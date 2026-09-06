import { Router } from 'express';
import { createHash } from 'node:crypto';

/**
 * /api/insights - "Mood Compass": trends computed from the user's own entries,
 * plus a Gemini-written weekly reflection (cached in Firestore per user).
 */
export function insightsRouter({ store, gemini, aiLimiter }) {
  const r = Router();

  r.get('/', async (req, res) => {
    const entries = await store.listEntries(req.user.uid, 100);
    res.json(computeInsights(entries));
  });

  r.get('/weekly', aiLimiter, async (req, res) => {
    const uid = req.user.uid;
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const recent = (await store.listEntries(uid, 100)).filter((e) => Date.parse(e.createdAt) >= since);
    if (recent.length === 0) return res.json({ reflection: null, entryCount: 0 });

    const signature = createHash('sha1')
      .update(recent.map((e) => `${e.id}:${e.updatedAt}`).join('|'))
      .digest('hex');
    const cached = await store.getInsight(uid, 'weekly');
    const fresh = cached && cached.signature === signature;
    if (fresh && req.query.refresh !== '1') {
      return res.json({ reflection: cached.text, entryCount: recent.length, generatedAt: cached.generatedAt, cached: true });
    }

    const text = await gemini.weeklyReflection({
      userName: req.user.name,
      entries: recent
        .slice()
        .reverse()
        .map((e) => ({
          date: e.createdAt.slice(0, 10),
          title: e.title,
          content: e.content,
          mood: e.analysis?.mood,
          location: e.location,
        })),
    });
    await store.setInsight(uid, 'weekly', { text, signature, entryCount: recent.length });
    return res.json({ reflection: text, entryCount: recent.length, generatedAt: new Date().toISOString(), cached: false });
  });

  return r;
}

/** Pure function so it is unit-testable. `entries` is newest-first. */
export function computeInsights(entries) {
  const analyzed = entries.filter((e) => e.analysis);
  const series = analyzed
    .slice(0, 30)
    .reverse()
    .map((e) => ({ id: e.id, date: e.createdAt, score: e.analysis.score, mood: e.analysis.mood, title: e.title }));

  const moods = {};
  const themes = {};
  const places = {};
  for (const e of analyzed) {
    moods[e.analysis.mood] = (moods[e.analysis.mood] || 0) + 1;
    for (const t of e.analysis.themes || []) themes[t] = (themes[t] || 0) + 1;
  }
  for (const e of entries) {
    const label = e.location?.label;
    if (label) places[label] = (places[label] || 0) + 1;
  }

  const days = [...new Set(entries.map((e) => e.createdAt.slice(0, 10)))].sort().reverse();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const scores = series.map((s) => s.score);

  return {
    totals: {
      entries: entries.length,
      thisWeek: entries.filter((e) => Date.parse(e.createdAt) >= weekAgo).length,
      streak: computeStreak(days),
      averageScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
      conversations: entries.reduce((n, e) => n + (e.messageCount || 0), 0),
    },
    series,
    moods: sortCounts(moods),
    themes: sortCounts(themes).slice(0, 10),
    places: sortCounts(places).slice(0, 5),
  };
}

function sortCounts(obj) {
  return Object.entries(obj)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Consecutive days with at least one entry, ending today or yesterday. */
export function computeStreak(daysDesc, today = new Date()) {
  if (!daysDesc.length) return 0;
  const dayMs = 24 * 3600 * 1000;
  const toDay = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / dayMs);
  const todayIdx = Math.floor(today.getTime() / dayMs);
  let expected = toDay(daysDesc[0]);
  if (todayIdx - expected > 1) return 0;
  let streak = 0;
  for (const d of daysDesc) {
    if (toDay(d) !== expected) break;
    streak += 1;
    expected -= 1;
  }
  return streak;
}
