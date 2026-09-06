import { Router } from 'express';
import { cleanEntryInput, cleanMessageInput, cleanLimit, isDocId, ValidationError } from '../validation.js';
import { log } from '../logger.js';
import { safeEmbed } from '../embed.js';

/**
 * /api/entries - journal entries and their Gemini reflection threads.
 * All handlers use req.user.uid (verified token) - never an id from the client.
 */
export function entriesRouter({ store, gemini, geocode, notifier, aiLimiter }) {
  const r = Router();

  r.param('id', (req, res, next, id) => {
    if (!isDocId(id)) return next(new ValidationError('Invalid entry id'));
    return next();
  });

  // List (summaries only - content is trimmed to a preview)
  r.get('/', async (req, res) => {
    const entries = await store.listEntries(req.user.uid, cleanLimit(req.query.limit));
    res.json({ entries: entries.map(toSummary) });
  });

  // Create + Mood Compass analysis + optional reverse geocoding
  r.post('/', aiLimiter, async (req, res) => {
    const input = cleanEntryInput(req.body);
    if (input.location && !input.location.label) {
      input.location.label = await geocode.reverse(input.location);
    }
    const analysis = await safeAnalyze(gemini, input);
    const entry = await store.createEntry(req.user.uid, { ...input, analysis });
    await safeEmbed({ gemini, store, uid: req.user.uid, entry });
    await store.audit(req.user.uid, 'entry.create', { hasLocation: Boolean(input.location), analyzed: Boolean(analysis) });
    const notified = await maybeNotify({ store, notifier, uid: req.user.uid, analysis });
    res.status(201).json({ entry, notified });
  });

  r.get('/:id', async (req, res) => {
    const entry = await store.getEntry(req.user.uid, req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    const messages = await store.listMessages(req.user.uid, req.params.id);
    return res.json({ entry, messages });
  });

  r.put('/:id', aiLimiter, async (req, res) => {
    const existing = await store.getEntry(req.user.uid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Entry not found' });
    const input = cleanEntryInput(req.body);
    if (input.location && !input.location.label) {
      const same = existing.location && existing.location.lat === input.location.lat && existing.location.lng === input.location.lng;
      input.location.label = same ? existing.location.label || '' : await geocode.reverse(input.location);
    }
    const changed = input.title !== existing.title || input.content !== existing.content;
    const analysis = changed || !existing.analysis ? await safeAnalyze(gemini, input) : existing.analysis;
    const entry = await store.updateEntry(req.user.uid, req.params.id, { ...input, analysis });
    if (changed || !existing.embeddingDim) await safeEmbed({ gemini, store, uid: req.user.uid, entry });
    return res.json({ entry });
  });

  r.delete('/:id', async (req, res) => {
    const existing = await store.getEntry(req.user.uid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Entry not found' });
    await store.deleteEntry(req.user.uid, req.params.id);
    await store.audit(req.user.uid, 'entry.delete');
    return res.status(204).end();
  });

  // Re-run analysis (e.g. when Gemini was unavailable at creation time)
  r.post('/:id/analyze', aiLimiter, async (req, res) => {
    const existing = await store.getEntry(req.user.uid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Entry not found' });
    const analysis = await gemini.analyzeMood(existing);
    const entry = await store.updateEntry(req.user.uid, req.params.id, { analysis });
    return res.json({ entry });
  });

  // Multi-turn reflection chat with Gemini
  r.post('/:id/messages', aiLimiter, async (req, res) => {
    const message = cleanMessageInput(req.body);
    const entry = await store.getEntry(req.user.uid, req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    const history = await store.listMessages(req.user.uid, req.params.id);
    const reply = await gemini.reply({
      entry: { ...entry, createdAtIso: entry.createdAt },
      history,
      message,
      userName: req.user.name,
    });
    const saved = await store.addMessages(req.user.uid, req.params.id, [
      { role: 'user', text: message },
      { role: 'model', text: reply },
    ]);
    // Base spec: conversations are automatically summarised and saved.
    let summary = entry.summary || null;
    try {
      const text = await gemini.summarizeThread({ entry, messages: [...history, ...saved] });
      if (text) {
        summary = { text, messageCount: history.length + saved.length, updatedAt: new Date().toISOString() };
        await store.updateEntry(req.user.uid, req.params.id, { summary });
      }
    } catch (err) {
      log.warn('Thread summary failed', { reason: err.message });
    }
    return res.status(201).json({ messages: saved, summary });
  });

  // Same as above, but streams Gemini's reply as Server-Sent Events:
  //   event: chunk  -> { text }
  //   event: done   -> { messages, summary }
  //   event: error  -> { error }
  r.post('/:id/messages/stream', aiLimiter, async (req, res) => {
    const message = cleanMessageInput(req.body);
    const entry = await store.getEntry(req.user.uid, req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    const history = await store.listMessages(req.user.uid, req.params.id);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const reply = await gemini.replyStream({
        entry: { ...entry, createdAtIso: entry.createdAt },
        history,
        message,
        userName: req.user.name,
        onChunk: (text) => send('chunk', { text }),
      });
      const saved = await store.addMessages(req.user.uid, req.params.id, [
        { role: 'user', text: message },
        { role: 'model', text: reply },
      ]);
      let summary = entry.summary || null;
      try {
        const text = await gemini.summarizeThread({ entry, messages: [...history, ...saved] });
        if (text) {
          summary = { text, messageCount: history.length + saved.length, updatedAt: new Date().toISOString() };
          await store.updateEntry(req.user.uid, req.params.id, { summary });
        }
      } catch (err) {
        log.warn('Thread summary failed', { reason: err.message });
      }
      send('done', { messages: saved, summary });
    } catch (err) {
      log.error('Streaming reply failed', { reason: err.message });
      send('error', { error: 'Gemini could not answer right now. Please try again.' });
    }
    return res.end();
  });

  // Static map image proxied server-side (Maps key never leaves the server)
  r.get('/:id/map.png', async (req, res) => {
    const entry = await store.getEntry(req.user.uid, req.params.id);
    if (!entry?.location) return res.status(404).end();
    const png = await geocode.staticMap(entry.location);
    if (!png) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=86400');
    return res.send(png);
  });

  return r;
}

/**
 * External notifications (Slack/Discord) based on entry content signals.
 * Only fires if the user opted in. Messages never contain journal text.
 */
async function maybeNotify({ store, notifier, uid, analysis }) {
  try {
    const settings = await store.getSettings(uid);
    if (!settings?.webhookUrl) return null;
    const target = { url: settings.webhookUrl, provider: settings.provider };
    if (settings.lowMood && analysis && analysis.score <= -2) {
      const ok = await notifier.send({ ...target, text: notifier.messages.lowMood() });
      return ok ? 'lowMood' : null;
    }
    if (settings.milestones) {
      const profile = await store.getUser(uid);
      const count = profile?.entryCount || 0;
      if ([7, 30, 100, 365].includes(count)) {
        const ok = await notifier.send({ ...target, text: notifier.messages.milestone(count) });
        return ok ? 'milestone' : null;
      }
    }
    return null;
  } catch (err) {
    log.warn('Notification check failed', { reason: err.message });
    return null;
  }
}

async function safeAnalyze(gemini, input) {
  try {
    return await gemini.analyzeMood(input);
  } catch (err) {
    log.warn('Mood analysis failed; entry saved without analysis', { reason: err.message });
    return null;
  }
}

export function toSummary(e) {
  return {
    id: e.id,
    title: e.title,
    preview: (e.content || '').slice(0, 140),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    messageCount: e.messageCount || 0,
    location: e.location ? { label: e.location.label || '' } : null,
    analysis: e.analysis ? { mood: e.analysis.mood, score: e.analysis.score, themes: e.analysis.themes } : null,
  };
}
