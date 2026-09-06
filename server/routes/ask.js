import { Router } from 'express';
import { cleanText } from '../validation.js';
import { safeEmbed } from '../embed.js';
import { log } from '../logger.js';

/**
 * /api/ask - "Ask my journal": retrieval-augmented answers over the user's own
 * entries using Gemini embeddings + Firestore vector search. Retrieval is
 * scoped to users/{uid}/entries, so it can never surface another user's text.
 */
export function askRouter({ store, gemini, aiLimiter }) {
  const r = Router();

  r.get('/status', async (req, res) => {
    res.json(await store.embeddingStatus(req.user.uid));
  });

  // Backfill embeddings for entries written before this feature existed.
  r.post('/reindex', aiLimiter, async (req, res) => {
    const pending = await store.listUnembedded(req.user.uid, 25);
    let done = 0;
    for (const entry of pending) if (await safeEmbed({ gemini, store, uid: req.user.uid, entry })) done += 1;
    res.json({ embedded: done, failed: pending.length - done, ...(await store.embeddingStatus(req.user.uid)) });
  });

  r.post('/', aiLimiter, async (req, res) => {
    const question = cleanText(req.body?.question, { field: 'Question', max: 500, required: true });
    const vector = await gemini.embed(question, 'RETRIEVAL_QUERY');
    let matches;
    try {
      matches = await store.findSimilar(req.user.uid, vector, 6);
    } catch (err) {
      if (/index/i.test(err.message) && /FAILED_PRECONDITION|requires/i.test(err.message + err.code)) {
        log.error('Vector index missing', { reason: err.message });
        return res.status(503).json({ error: 'Semantic search is not set up yet: the Firestore vector index has not been created. See README "Vector index".' });
      }
      throw err;
    }
    // Drop weak matches (cosine distance: 0 = identical, 1 = unrelated)
    const relevant = matches.filter((m) => typeof m.distance !== 'number' || m.distance < 0.6);
    if (!relevant.length) {
      return res.json({ answer: null, sources: [], message: 'Nothing in your journal seems related to that yet.' });
    }
    const answer = await gemini.answerFromEntries({ question, entries: relevant, userName: req.user.name });
    await store.audit(req.user.uid, 'ask.query', { sources: relevant.length });
    res.json({
      answer,
      sources: relevant.map((e, i) => ({
        n: i + 1,
        id: e.id,
        title: e.title,
        createdAt: e.createdAt,
        mood: e.analysis?.mood || null,
        similarity: typeof e.distance === 'number' ? Math.round((1 - e.distance) * 100) : null,
      })),
    });
  });

  return r;
}
