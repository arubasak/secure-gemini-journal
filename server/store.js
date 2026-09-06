import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

/**
 * Firestore data-access layer.
 *
 * Data isolation model: every user document lives under `users/{uid}/...` and
 * `uid` ALWAYS comes from a verified Firebase ID token (see auth.js). There is
 * no query in this file that spans users, except the admin aggregates which
 * read only counters and timestamps - never entry content.
 */
export function createStore(db) {
  const users = db.collection('users');
  const userRef = (uid) => users.doc(uid);
  const entriesRef = (uid) => userRef(uid).collection('entries');
  const entryRef = (uid, id) => entriesRef(uid).doc(id);
  const messagesRef = (uid, id) => entryRef(uid, id).collection('messages');
  const insightsRef = (uid) => userRef(uid).collection('insights');
  const statsRef = db.collection('meta').doc('stats');
  const auditRef = db.collection('audit');

  return {
    /* ----- users ----- */
    async touchUser(user) {
      const ref = userRef(user.uid);
      const snap = await ref.get();
      const base = { lastSeenAt: FieldValue.serverTimestamp() };
      if (!snap.exists) {
        await ref.set({ ...base, createdAt: FieldValue.serverTimestamp(), entryCount: 0, provider: 'firebase' });
        await statsRef.set({ users: FieldValue.increment(1) }, { merge: true });
        return { created: true };
      }
      await ref.set(base, { merge: true });
      return { created: false };
    },

    async getUser(uid) {
      const snap = await userRef(uid).get();
      return snap.exists ? serialize(snap) : null;
    },

    /* ----- entries ----- */
    async listEntries(uid, limit = 50) {
      const q = await entriesRef(uid).orderBy('createdAt', 'desc').limit(limit).get();
      return q.docs.map(serialize);
    },

    async getEntry(uid, id) {
      const snap = await entryRef(uid, id).get();
      return snap.exists ? serialize(snap) : null;
    },

    async createEntry(uid, data) {
      const ref = entriesRef(uid).doc();
      const now = FieldValue.serverTimestamp();
      await ref.set({ ...data, createdAt: now, updatedAt: now, messageCount: 0 });
      await userRef(uid).set({ entryCount: FieldValue.increment(1), lastSeenAt: now }, { merge: true });
      await statsRef.set({ entries: FieldValue.increment(1) }, { merge: true });
      return serialize(await ref.get());
    },

    async updateEntry(uid, id, data) {
      const ref = entryRef(uid, id);
      await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
      return serialize(await ref.get());
    },

    async deleteEntry(uid, id) {
      await db.recursiveDelete(entryRef(uid, id));
      await userRef(uid).set({ entryCount: FieldValue.increment(-1) }, { merge: true });
    },

    /* ----- semantic search ("Ask my journal") ----- */
    async setEmbedding(uid, id, values) {
      await entryRef(uid, id).update({ embedding: FieldValue.vector(values), embeddingDim: values.length });
    },

    /**
     * Nearest entries by cosine distance. The query is scoped to the caller's
     * own `users/{uid}/entries` collection, so isolation holds even though the
     * vector index is defined on the `entries` collection group.
     */
    async findSimilar(uid, values, limit = 6) {
      const snap = await entriesRef(uid)
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector(values),
          limit,
          distanceMeasure: 'COSINE',
          distanceResultField: 'distance',
        })
        .get();
      return snap.docs.map(serialize);
    },

    async embeddingStatus(uid) {
      const all = await entriesRef(uid).select('embeddingDim').limit(500).get();
      const indexed = all.docs.filter((d) => d.get('embeddingDim')).length;
      return { total: all.size, indexed };
    },

    async listUnembedded(uid, limit = 50) {
      const all = await entriesRef(uid).orderBy('createdAt', 'desc').limit(200).get();
      return all.docs.filter((d) => !d.get('embeddingDim')).slice(0, limit).map(serialize);
    },

    /* ----- reflection thread ----- */
    async listMessages(uid, id) {
      const q = await messagesRef(uid, id).orderBy('createdAt', 'asc').limit(200).get();
      return q.docs.map(serialize);
    },

    async addMessages(uid, id, messages) {
      const batch = db.batch();
      const created = [];
      // Firestore server timestamps are identical within a batch, so add a
      // sequence number to preserve ordering between the user and model turns.
      const base = Date.now();
      messages.forEach((m, i) => {
        const ref = messagesRef(uid, id).doc();
        const doc = { role: m.role, text: m.text, seq: base + i, createdAt: FieldValue.serverTimestamp() };
        batch.set(ref, doc);
        created.push({ id: ref.id, role: m.role, text: m.text, createdAt: new Date(base + i).toISOString() });
      });
      batch.update(entryRef(uid, id), {
        messageCount: FieldValue.increment(messages.length),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(statsRef, { aiMessages: FieldValue.increment(messages.length) }, { merge: true });
      await batch.commit();
      return created;
    },

    /* ----- private settings (server-only; never readable by the client SDK) ----- */
    async getSettings(uid) {
      const snap = await userRef(uid).collection('private').doc('settings').get();
      return snap.exists ? serialize(snap) : {};
    },

    async setSettings(uid, data) {
      await userRef(uid).collection('private').doc('settings').set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },

    /* ----- insights cache ----- */
    async getInsight(uid, key) {
      const snap = await insightsRef(uid).doc(key).get();
      return snap.exists ? serialize(snap) : null;
    },

    async setInsight(uid, key, data) {
      await insightsRef(uid).doc(key).set({ ...data, generatedAt: FieldValue.serverTimestamp() });
      await statsRef.set({ reflections: FieldValue.increment(1) }, { merge: true });
    },

    /* ----- account ----- */
    async exportAll(uid) {
      const entries = await this.listEntries(uid, 1000);
      for (const e of entries) e.messages = await this.listMessages(uid, e.id);
      return { exportedAt: new Date().toISOString(), uid, entries };
    },

    async deleteAllUserData(uid) {
      await db.recursiveDelete(userRef(uid));
      await statsRef.set({ users: FieldValue.increment(-1), deletedAccounts: FieldValue.increment(1) }, { merge: true });
    },

    /* ----- audit + admin (aggregates only, never content) ----- */
    async audit(uid, event, meta = {}) {
      // uid is stored hashed so even the audit trail cannot be joined back to a person.
      await auditRef.add({ event, subject: hashUid(uid), meta, at: FieldValue.serverTimestamp() });
    },

    async adminOverview() {
      const [stats, recentUsers, recentAudit] = await Promise.all([
        statsRef.get(),
        users.orderBy('createdAt', 'desc').limit(10).get(),
        auditRef.orderBy('at', 'desc').limit(25).get(),
      ]);
      return {
        stats: stats.exists ? stats.data() : {},
        recentUsers: recentUsers.docs.map((d) => {
          const u = serialize(d);
          return { id: hashUid(d.id).slice(0, 10), createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, entryCount: u.entryCount || 0 };
        }),
        recentAudit: recentAudit.docs.map((d) => {
          const a = serialize(d);
          return { event: a.event, subject: a.subject.slice(0, 10), at: a.at, meta: a.meta };
        }),
      };
    },
  };
}

/* ---------- helpers ---------- */

export function hashUid(uid) {
  return createHash('sha256').update(`journal:${uid}`).digest('hex');
}

/** Firestore snapshot -> plain object with ISO timestamps and an `id`. */
export function serialize(snap) {
  const data = snap.data() || {};
  // Raw embedding vectors never leave the data layer (large, and useless to clients).
  delete data.embedding;
  return { id: snap.id, ...convert(data) };
}

function convert(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = convert(v);
    return out;
  }
  return value;
}
