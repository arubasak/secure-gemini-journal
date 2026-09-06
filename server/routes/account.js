import { Router } from 'express';
import { ValidationError } from '../validation.js';
import { validateWebhookUrl } from '../notify.js';

/**
 * /api/account - profile, notification settings, data portability (export)
 * and the right to erasure.
 */
export function accountRouter({ store, auth, notifier }) {
  const r = Router();

  /* ----- external notifications (Slack / Discord webhooks) ----- */
  const publicSettings = (s = {}) => ({
    configured: Boolean(s.webhookUrl),
    provider: s.provider || null,
    host: s.host || null,
    lowMood: Boolean(s.lowMood),
    milestones: Boolean(s.milestones),
  });

  r.get('/notifications', async (req, res) => {
    res.json(publicSettings(await store.getSettings(req.user.uid)));
  });

  r.put('/notifications', async (req, res) => {
    const body = req.body || {};
    const update = { lowMood: body.lowMood === true, milestones: body.milestones === true };
    if (body.webhookUrl === '' || body.webhookUrl === null) {
      Object.assign(update, { webhookUrl: null, provider: null, host: null });
    } else if (body.webhookUrl !== undefined) {
      const { provider, url, host } = validateWebhookUrl(body.webhookUrl);
      Object.assign(update, { webhookUrl: url, provider, host });
    }
    await store.setSettings(req.user.uid, update);
    await store.audit(req.user.uid, 'notifications.update', { configured: Boolean(update.webhookUrl ?? (await store.getSettings(req.user.uid)).webhookUrl) });
    res.json(publicSettings(await store.getSettings(req.user.uid)));
  });

  r.post('/notifications/test', async (req, res) => {
    const s = await store.getSettings(req.user.uid);
    if (!s.webhookUrl) throw new ValidationError('Add a webhook URL first');
    const ok = await notifier.send({ url: s.webhookUrl, provider: s.provider, text: notifier.messages.test() });
    if (!ok) return res.status(502).json({ error: 'The webhook did not accept the message. Check the URL.' });
    return res.json({ ok: true });
  });

  r.get('/me', async (req, res) => {
    const { created } = await store.touchUser(req.user);
    if (created) await store.audit(req.user.uid, 'user.create');
    const profile = await store.getUser(req.user.uid);
    res.json({
      uid: req.user.uid,
      email: req.user.email,
      name: req.user.name,
      admin: req.user.admin,
      createdAt: profile?.createdAt || null,
      entryCount: profile?.entryCount || 0,
    });
  });

  // Full JSON export of everything the app holds for this user.
  r.get('/export', async (req, res) => {
    const data = await store.exportAll(req.user.uid);
    await store.audit(req.user.uid, 'account.export', { entries: data.entries.length });
    res.set('Content-Disposition', `attachment; filename="journal-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  });

  // Delete every Firestore document AND the Firebase Auth user.
  r.delete('/', async (req, res) => {
    if (req.body?.confirm !== 'DELETE MY JOURNAL') {
      throw new ValidationError('Type "DELETE MY JOURNAL" to confirm account deletion');
    }
    await store.audit(req.user.uid, 'account.delete');
    await store.deleteAllUserData(req.user.uid);
    await auth.deleteUser(req.user.uid);
    res.status(204).end();
  });

  return r;
}
