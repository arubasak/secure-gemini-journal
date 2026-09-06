/**
 * End-to-end tests of the HTTP surface with in-memory fakes for Firebase Auth,
 * Firestore, Gemini and geocoding. No network, no credentials required.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

/* ---------- fakes ---------- */
const TOKENS = {
  'tok-u1': { uid: 'u1', name: 'Alice', email: 'alice@example.com' },
  'tok-u2': { uid: 'u2', name: 'Bob', email: 'bob@example.com' },
  'tok-admin': { uid: 'a1', name: 'Root', email: 'root@example.com', admin: true },
};
const deletedUsers = [];
const fakeAuth = {
  async verifyIdToken(token) {
    if (!TOKENS[token]) throw new Error('bad token');
    return TOKENS[token];
  },
  async deleteUser(uid) {
    deletedUsers.push(uid);
  },
};

function fakeStore() {
  const users = new Map(); // uid -> { profile, entries: Map(id -> {entry, messages[]}), insights: Map }
  const stats = {};
  const auditLog = [];
  let seq = 0;
  const now = () => new Date().toISOString();
  const bucket = (uid) => {
    if (!users.has(uid)) users.set(uid, { profile: null, entries: new Map(), insights: new Map() });
    return users.get(uid);
  };
  return {
    async touchUser(user) {
      const b = bucket(user.uid);
      if (!b.profile) { b.profile = { createdAt: now(), entryCount: 0 }; stats.users = (stats.users || 0) + 1; return { created: true }; }
      return { created: false };
    },
    async getUser(uid) { return bucket(uid).profile; },
    async listEntries(uid, limit) {
      return [...bucket(uid).entries.values()].map((x) => x.entry).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
    async getEntry(uid, id) { return bucket(uid).entries.get(id)?.entry || null; },
    async createEntry(uid, data) {
      const id = `e${++seq}`;
      const entry = { id, ...data, createdAt: now(), updatedAt: now(), messageCount: 0 };
      bucket(uid).entries.set(id, { entry, messages: [] });
      stats.entries = (stats.entries || 0) + 1;
      return entry;
    },
    async updateEntry(uid, id, data) {
      const rec = bucket(uid).entries.get(id);
      Object.assign(rec.entry, data, { updatedAt: now() });
      return rec.entry;
    },
    async deleteEntry(uid, id) { bucket(uid).entries.delete(id); },
    async listMessages(uid, id) { return (bucket(uid).entries.get(id)?.messages || []).slice(); },
    async addMessages(uid, id, msgs) {
      const rec = bucket(uid).entries.get(id);
      const created = msgs.map((m) => ({ id: `m${++seq}`, ...m, createdAt: now() }));
      rec.messages.push(...created);
      rec.entry.messageCount += msgs.length;
      return created;
    },
    async getInsight(uid, key) { return bucket(uid).insights.get(key) || null; },
    async setInsight(uid, key, data) { bucket(uid).insights.set(key, { ...data, generatedAt: now() }); },
    async exportAll(uid) {
      const entries = await this.listEntries(uid, 1000);
      for (const e of entries) e.messages = await this.listMessages(uid, e.id);
      return { exportedAt: now(), uid, entries };
    },
    async deleteAllUserData(uid) { users.delete(uid); },
    async setEmbedding(uid, id, values) { const r = bucket(uid).entries.get(id); r.vector = values; r.entry.embeddingDim = values.length; },
    async findSimilar(uid, values, limit) {
      const cos = (a, b) => 1 - a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b) || 1);
      return [...bucket(uid).entries.values()].filter((r) => r.vector).map((r) => ({ ...r.entry, distance: cos(values, r.vector) })).sort((p, q) => p.distance - q.distance).slice(0, limit);
    },
    async embeddingStatus(uid) { const all = [...bucket(uid).entries.values()]; return { total: all.length, indexed: all.filter((r) => r.vector).length }; },
    async listUnembedded(uid, limit) { return [...bucket(uid).entries.values()].filter((r) => !r.vector).slice(0, limit).map((r) => r.entry); },
    async getSettings(uid) { return bucket(uid).settings || {}; },
    async setSettings(uid, data) { bucket(uid).settings = { ...(bucket(uid).settings || {}), ...data }; },
    async audit(uid, event, meta = {}) { auditLog.push({ event, subject: `h-${uid}`, meta, at: now() }); },
    async adminOverview() {
      return { stats, recentUsers: [], recentAudit: auditLog.slice(-25) };
    },
    _users: users,
  };
}

const fakeGemini = {
  model: 'fake-model',
  async analyzeMood() { return { mood: 'calm', score: 1, energy: 'medium', themes: ['test'], summary: 'A calm entry.', prompt: 'What helped?' }; },
  async reply({ history, message }) { return `echo: ${message} (history ${history.length})`; },
  async summarizeThread({ messages }) { return `You explored ${messages.length} turns. Key insight: keep going.`; },
  async replyStream({ history, message, onChunk }) { for (const piece of ['streamed: ', message, ` (history ${history.length})`]) await onChunk(piece); return `streamed: ${message} (history ${history.length})`; },
  // Toy embedding: bag of characters, good enough to rank "sleep" near "slept".
  async embed(text) { const v = new Array(768).fill(0); for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 768] += 1; return v; },
  async answerFromEntries({ question, entries }) { return `Answer to "${question}" from ${entries.length} entries [1].`; },
  async transcribe({ mimeType }) { return `transcript of ${mimeType}`; },
  async weeklyReflection({ entries }) { return `**Patterns I noticed**\n- ${entries.length} entries`; },
};
const fakeGeocode = { enabled: false, async reverse() { return ''; }, async staticMap() { return null; } };
const sentWebhooks = [];
const fakeNotifier = {
  async send({ url, provider, text }) { sentWebhooks.push({ url, provider, text }); return !url.includes('broken'); },
  messages: { test: () => 'test msg', lowMood: () => 'low mood msg', milestone: (n) => `milestone ${n}` },
};

const config = {
  env: 'test',
  geminiModel: 'fake-model',
  mapsApiKey: '',
  requireVerifiedEmail: false,
  firebaseWebConfig: { apiKey: 'web-key', authDomain: 'demo.firebaseapp.com', projectId: 'demo', appId: '1:2:web:3' },
};

/* ---------- harness ---------- */
let server;
let base;
const store = fakeStore();
before(async () => {
  const app = createApp({ config, auth: fakeAuth, store, gemini: fakeGemini, geocode: fakeGeocode, notifier: fakeNotifier });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

/* ---------- tests ---------- */
test('health and public config expose no secrets', async () => {
  assert.equal((await call('/health')).status, 200);
  // /healthz is reserved by Cloud Run's frontend, so it must not be our health path.
  assert.equal((await call('/healthz')).status, 200, 'unknown paths fall through to the SPA');
  const cfg = await call('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.firebase.authDomain, 'demo.firebaseapp.com');
  assert.equal(cfg.json.features.maps, false);
  assert.ok(!cfg.text.includes('gemini'), 'no gemini key in public config');
});

test('security headers are set', async () => {
  const res = await call('/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.match(res.text, /<title>Gemini Journal<\/title>/);
});

test('SPA fallback serves index.html for app routes, JSON 404 for unknown API routes', async () => {
  const page = await call('/some/deep/link');
  assert.equal(page.status, 200);
  assert.match(page.text, /<!DOCTYPE html>/);
  assert.equal((await call('/some/deep/link', { method: 'HEAD' })).status, 200, 'HEAD is answered too');
  const api = await call('/api/nope', { token: 'tok-u1' });
  assert.equal(api.status, 404);
  assert.deepEqual(api.json, { error: 'Not found' });
});

test('API rejects missing and invalid tokens', async () => {
  assert.equal((await call('/api/entries')).status, 401);
  assert.equal((await call('/api/entries', { token: 'nope' })).status, 401);
  assert.equal((await call('/api/account/me', { token: 'nope' })).status, 401);
});

let entryId;
test('user can create an entry and Gemini analysis is attached', async () => {
  const bad = await call('/api/entries', { method: 'POST', token: 'tok-u1', body: { title: 'x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Entry is required/);

  const res = await call('/api/entries', { method: 'POST', token: 'tok-u1', body: { title: 'Day one', content: 'Slept well, felt calm.' } });
  assert.equal(res.status, 201);
  entryId = res.json.entry.id;
  assert.equal(res.json.entry.analysis.mood, 'calm');
  assert.equal(res.json.entry.location, null);

  const list = await call('/api/entries', { token: 'tok-u1' });
  assert.equal(list.json.entries.length, 1);
  assert.equal(list.json.entries[0].title, 'Day one');
  assert.equal(list.json.entries[0].content, undefined, 'list returns summaries, not full content');
});

test('entries are isolated per user (no cross-user reads, updates or deletes)', async () => {
  assert.equal((await call(`/api/entries/${entryId}`, { token: 'tok-u2' })).status, 404);
  assert.equal((await call(`/api/entries/${entryId}`, { method: 'PUT', token: 'tok-u2', body: { content: 'hijack' } })).status, 404);
  assert.equal((await call(`/api/entries/${entryId}`, { method: 'DELETE', token: 'tok-u2' })).status, 404);
  assert.equal((await call(`/api/entries/${entryId}/messages`, { method: 'POST', token: 'tok-u2', body: { message: 'hi' } })).status, 404);
  const other = await call('/api/entries', { token: 'tok-u2' });
  assert.equal(other.json.entries.length, 0);
  const mine = await call(`/api/entries/${entryId}`, { token: 'tok-u1' });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.entry.content, 'Slept well, felt calm.');
});

test('malformed ids are rejected before touching the store', async () => {
  const res = await call('/api/entries/..%2Fusers', { token: 'tok-u1' });
  assert.equal(res.status, 400);
});

test('multi-turn reflection persists the thread and feeds history back to Gemini', async () => {
  const first = await call(`/api/entries/${entryId}/messages`, { method: 'POST', token: 'tok-u1', body: { message: 'Why did I feel calm?' } });
  assert.equal(first.status, 201);
  assert.equal(first.json.messages.length, 2);
  assert.equal(first.json.messages[1].text, 'echo: Why did I feel calm? (history 0)');

  const second = await call(`/api/entries/${entryId}/messages`, { method: 'POST', token: 'tok-u1', body: { message: 'Tell me more' } });
  assert.equal(second.json.messages[1].text, 'echo: Tell me more (history 2)');

  assert.match(second.json.summary.text, /You explored 4 turns/);
  const detail = await call(`/api/entries/${entryId}`, { token: 'tok-u1' });
  assert.equal(detail.json.messages.length, 4);
  assert.equal(detail.json.entry.messageCount, 4);
  assert.equal(detail.json.entry.summary.messageCount, 4, 'conversation summary is auto-saved on the entry');
  assert.equal((await call(`/api/entries/${entryId}/messages`, { method: 'POST', token: 'tok-u1', body: { message: '' } })).status, 400);
});

test('streaming reply arrives as SSE chunks and is persisted with a summary', async () => {
  const token = 'tok-u1';
  const res = await fetch(`${base}/api/entries/${entryId}/messages/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Stream this' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const raw = await res.text();
  const events = raw.split('\n\n').filter(Boolean).map((b) => {
    const ev = /event: (\w+)/.exec(b)[1];
    const data = JSON.parse(/data: (.*)/.exec(b)[1]);
    return { ev, data };
  });
  const chunks = events.filter((e) => e.ev === 'chunk').map((e) => e.data.text).join('');
  assert.equal(chunks, 'streamed: Stream this (history 4)');
  const done = events.find((e) => e.ev === 'done');
  assert.equal(done.data.messages.length, 2);
  assert.equal(done.data.messages[1].text, 'streamed: Stream this (history 4)');
  assert.match(done.data.summary.text, /6 turns/);
  const detail = await call(`/api/entries/${entryId}`, { token });
  assert.equal(detail.json.messages.length, 6);
  // isolation and validation still apply on the streaming route
  assert.equal((await call(`/api/entries/${entryId}/messages/stream`, { method: 'POST', token: 'tok-u2', body: { message: 'x' } })).status, 404);
  assert.equal((await call(`/api/entries/${entryId}/messages/stream`, { method: 'POST', token, body: { message: '' } })).status, 400);
});

test('ask my journal: embeddings are per-user, retrieval is cited, cross-user text never appears', async () => {
  // u1's entry was embedded at creation time
  const status = await call('/api/ask/status', { token: 'tok-u1' });
  assert.deepEqual(status.json, { total: 1, indexed: 1 });

  // u2 writes a secret; u1 must never retrieve it
  fakeGemini.analyzeMood = async () => ({ mood: 'calm', score: 1, energy: 'medium', themes: [], summary: '', prompt: '' });
  await call('/api/entries', { method: 'POST', token: 'tok-u2', body: { title: 'Secret', content: 'Slept well, felt calm. PASSPHRASE-XYZ' } });

  const ask = await call('/api/ask', { method: 'POST', token: 'tok-u1', body: { question: 'How did I sleep?' } });
  assert.equal(ask.status, 200);
  assert.match(ask.json.answer, /from 1 entries/);
  assert.equal(ask.json.sources.length, 1);
  assert.equal(ask.json.sources[0].id, entryId);
  assert.equal(typeof ask.json.sources[0].similarity, 'number');
  assert.ok(!JSON.stringify(ask.json).includes('PASSPHRASE'), 'no cross-user leakage through retrieval');
  assert.equal((await call('/api/ask', { method: 'POST', token: 'tok-u1', body: { question: '' } })).status, 400);

  // reindex is a no-op when everything is indexed
  const re = await call('/api/ask/reindex', { method: 'POST', token: 'tok-u1' });
  assert.equal(re.json.embedded, 0);
  assert.equal(re.json.total, 1);
  assert.equal(re.json.indexed, 1);

  // raw vectors are never serialised to clients
  const list = await call('/api/entries', { token: 'tok-u1' });
  assert.ok(!JSON.stringify(list.json).includes('"embedding"'));
});

test('voice transcription validates format and size', async () => {
  const audio = Buffer.alloc(4000, 1).toString('base64');
  const ok = await call('/api/voice/transcribe', { method: 'POST', token: 'tok-u1', body: { mimeType: 'audio/webm;codecs=opus', audio } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.text, 'transcript of audio/webm');
  assert.equal((await call('/api/voice/transcribe', { method: 'POST', token: 'tok-u1', body: { mimeType: 'video/mp4', audio } })).status, 400);
  assert.equal((await call('/api/voice/transcribe', { method: 'POST', token: 'tok-u1', body: { mimeType: 'audio/webm', audio: 'abc' } })).status, 400);
  assert.equal((await call('/api/voice/transcribe', { method: 'POST', token: 'tok-u1', body: { mimeType: 'audio/webm', audio: '!!!' } })).status, 400);
  const big = await call('/api/voice/transcribe', { method: 'POST', token: 'tok-u1', body: { mimeType: 'audio/webm', audio: Buffer.alloc(4.5 * 1024 * 1024, 1).toString('base64') } });
  assert.equal(big.status, 400);
  assert.equal((await call('/api/voice/transcribe', { method: 'POST', body: { mimeType: 'audio/webm', audio } })).status, 401);
});

test('insights and cached weekly reflection', async () => {
  const ins = await call('/api/insights', { token: 'tok-u1' });
  assert.equal(ins.status, 200);
  assert.equal(ins.json.totals.entries, 1);
  assert.equal(ins.json.series[0].mood, 'calm');

  const w1 = await call('/api/insights/weekly', { token: 'tok-u1' });
  assert.equal(w1.json.cached, false);
  assert.match(w1.json.reflection, /1 entries/);
  const w2 = await call('/api/insights/weekly', { token: 'tok-u1' });
  assert.equal(w2.json.cached, true);
  const w3 = await call('/api/insights/weekly?refresh=1', { token: 'tok-u1' });
  assert.equal(w3.json.cached, false);
  const empty = await call('/api/insights/weekly', { token: 'tok-admin' });
  assert.deepEqual(empty.json, { reflection: null, entryCount: 0 });
});

test('admin dashboard is role-gated by the custom claim', async () => {
  assert.equal((await call('/api/admin/overview', { token: 'tok-u1' })).status, 403);
  const ok = await call('/api/admin/overview', { token: 'tok-admin' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.stats.entries, 2);
  assert.equal(ok.json.service.model, 'fake-model');
  assert.ok(!JSON.stringify(ok.json).includes('PASSPHRASE'), 'admin never sees journal content');
  assert.ok(!JSON.stringify(ok.json).includes('Slept well'), 'admin never sees journal content');
});

test('account export and confirmed deletion', async () => {
  const me = await call('/api/account/me', { token: 'tok-u1' });
  assert.equal(me.json.uid, 'u1');
  assert.equal(me.json.admin, false);

  const exp = await call('/api/account/export', { token: 'tok-u1' });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  assert.equal(exp.json.entries[0].messages.length, 6);

  const noConfirm = await call('/api/account', { method: 'DELETE', token: 'tok-u1', body: { confirm: 'nope' } });
  assert.equal(noConfirm.status, 400);
  const del = await call('/api/account', { method: 'DELETE', token: 'tok-u1', body: { confirm: 'DELETE MY JOURNAL' } });
  assert.equal(del.status, 204);
  assert.deepEqual(deletedUsers, ['u1']);
  assert.equal((await call('/api/entries', { token: 'tok-u1' })).json.entries.length, 0);
});

test('notification settings: validation, masking, test send and low-mood trigger', async () => {
  const initial = await call('/api/account/notifications', { token: 'tok-u2' });
  assert.deepEqual(initial.json, { configured: false, provider: null, host: null, lowMood: false, milestones: false });

  const bad = await call('/api/account/notifications', { method: 'PUT', token: 'tok-u2', body: { webhookUrl: 'https://evil.com/hook' } });
  assert.equal(bad.status, 400);

  const ok = await call('/api/account/notifications', { method: 'PUT', token: 'tok-u2', body: { webhookUrl: 'https://hooks.slack.com/services/T1/B1/abc', lowMood: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.configured, true);
  assert.equal(ok.json.provider, 'slack');
  assert.ok(!JSON.stringify(ok.json).includes('/services/'), 'webhook URL is never echoed back');

  const sent = await call('/api/account/notifications/test', { method: 'POST', token: 'tok-u2' });
  assert.equal(sent.status, 200);
  assert.equal(sentWebhooks.at(-1).text, 'test msg');

  // A very low-mood entry triggers a content-free nudge
  fakeGemini.analyzeMood = async () => ({ mood: 'sad', score: -2, energy: 'low', themes: [], summary: '', prompt: '' });
  const entry = await call('/api/entries', { method: 'POST', token: 'tok-u2', body: { content: 'Everything went wrong today.' } });
  assert.equal(entry.json.notified, 'lowMood');
  assert.equal(sentWebhooks.at(-1).text, 'low mood msg');
  assert.ok(!sentWebhooks.at(-1).text.includes('wrong'), 'notification contains no journal text');

  const off = await call('/api/account/notifications', { method: 'PUT', token: 'tok-u2', body: { webhookUrl: '', lowMood: false, milestones: false } });
  assert.equal(off.json.configured, false);
  assert.equal((await call('/api/account/notifications/test', { method: 'POST', token: 'tok-u2' })).status, 400);
});

test('oversized JSON bodies are rejected', async () => {
  const res = await call('/api/entries', { method: 'POST', token: 'tok-u2', body: { content: 'x'.repeat(70 * 1024) } });
  assert.equal(res.status, 413);
});
