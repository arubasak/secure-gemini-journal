import { log } from './logger.js';

/** Text that gets embedded for an entry: title + content (+ place, mood tags). */
export function embeddingText(entry) {
  const bits = [entry.title, entry.content];
  if (entry.location?.label) bits.push(`Place: ${entry.location.label}`);
  if (entry.analysis?.mood) bits.push(`Mood: ${entry.analysis.mood}. Themes: ${(entry.analysis.themes || []).join(', ')}`);
  return bits.filter(Boolean).join('\n');
}

/** Best-effort embedding write; never fails the request that triggered it. */
export async function safeEmbed({ gemini, store, uid, entry }) {
  try {
    const values = await gemini.embed(embeddingText(entry), 'RETRIEVAL_DOCUMENT');
    await store.setEmbedding(uid, entry.id, values);
    return true;
  } catch (err) {
    log.warn('Embedding failed; entry saved without vector', { reason: err.message });
    return false;
  }
}
