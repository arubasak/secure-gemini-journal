import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInsights, computeStreak } from '../server/routes/insights.js';
import { toHistory, normalizeMood } from '../server/gemini.js';

const day = (offset) => new Date(Date.now() - offset * 24 * 3600 * 1000).toISOString();
const entry = (offset, mood, score, themes = [], extra = {}) => ({
  id: `e${offset}`,
  title: `Entry ${offset}`,
  content: 'text',
  createdAt: day(offset),
  updatedAt: day(offset),
  messageCount: 2,
  analysis: { mood, score, themes, energy: 'medium', summary: '', prompt: '' },
  ...extra,
});

test('computeStreak counts consecutive days ending today or yesterday', () => {
  const today = new Date('2026-09-06T10:00:00Z');
  assert.equal(computeStreak([], today), 0);
  assert.equal(computeStreak(['2026-09-06', '2026-09-05', '2026-09-04'], today), 3);
  assert.equal(computeStreak(['2026-09-05', '2026-09-04', '2026-09-01'], today), 2);
  assert.equal(computeStreak(['2026-09-03'], today), 0);
});

test('computeInsights aggregates moods, themes, places and series', () => {
  const entries = [
    entry(0, 'joyful', 2, ['work', 'sleep'], { location: { label: 'Home' } }),
    entry(1, 'sad', -1, ['work']),
    entry(2, 'calm', 1, [], { location: { label: 'Home' } }),
    { id: 'x', title: 'no analysis', content: 't', createdAt: day(3), updatedAt: day(3), messageCount: 0 },
  ];
  const out = computeInsights(entries);
  assert.equal(out.totals.entries, 4);
  assert.equal(out.totals.thisWeek, 4);
  assert.equal(out.totals.conversations, 6);
  assert.equal(out.totals.averageScore, 0.67);
  assert.equal(out.series.length, 3);
  assert.equal(out.series[0].id, 'e2', 'series is oldest-first');
  assert.deepEqual(out.moods[0], { name: 'calm', count: 1 });
  assert.deepEqual(out.themes[0], { name: 'work', count: 2 });
  assert.deepEqual(out.places, [{ name: 'Home', count: 2 }]);
});

test('toHistory enforces user-first alternation and trims to 20 turns', () => {
  const hist = toHistory([
    { role: 'model', text: 'orphan' },
    { role: 'user', text: 'a' },
    { role: 'user', text: 'b' },
    { role: 'model', text: 'c' },
    { role: 'user', text: '' },
  ]);
  assert.deepEqual(hist, [
    { role: 'user', parts: [{ text: 'a\n\nb' }] },
    { role: 'model', parts: [{ text: 'c' }] },
  ]);
  const long = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: `m${i}` }));
  assert.equal(toHistory(long).length, 20);
});

test('normalizeMood clamps and sanitises model output', () => {
  const out = normalizeMood({ mood: 'ecstatic', score: 9, energy: 'zzz', themes: ['Work!', 'x'.repeat(40), 'sleep', 'a', 'b', 'c'], summary: 's', prompt: 'p' });
  assert.equal(out.mood, 'neutral');
  assert.equal(out.score, 2);
  assert.equal(out.energy, 'medium');
  assert.deepEqual(out.themes, ['work', 'sleep', 'a', 'b']);
  assert.deepEqual(normalizeMood().themes, []);
});
