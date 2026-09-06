export const LIMITS = {
  title: 120,
  content: 10000,
  message: 2000,
  placeLabel: 120,
  listMax: 100,
};

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Trim, enforce string type + length, strip control chars except newline/tab. */
export function cleanText(value, { field, max, required = false }) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !cleaned) throw new ValidationError(`${field} cannot be empty`);
  if (cleaned.length > max) throw new ValidationError(`${field} is too long (max ${max} characters)`);
  return cleaned;
}

/** Optional location: { lat, lng, label? }. Returns null when absent. */
export function cleanLocation(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object') throw new ValidationError('Location must be an object');
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new ValidationError('Location coordinates are invalid');
  }
  return {
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    label: cleanText(value.label, { field: 'Place', max: LIMITS.placeLabel }) || '',
  };
}

export function cleanEntryInput(body = {}) {
  return {
    title: cleanText(body.title, { field: 'Title', max: LIMITS.title }) || 'Untitled entry',
    content: cleanText(body.content, { field: 'Entry', max: LIMITS.content, required: true }),
    location: cleanLocation(body.location),
  };
}

export function cleanMessageInput(body = {}) {
  return cleanText(body.message, { field: 'Message', max: LIMITS.message, required: true });
}

export function cleanLimit(value, fallback = 50) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, LIMITS.listMax);
}

export function isDocId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
