import { log } from './logger.js';

/**
 * Location-aware entries. Coordinates come from the browser (only after the user
 * explicitly clicks "Add location"). If a Google Maps Platform key is configured
 * in Secret Manager we reverse-geocode server-side, so the key never reaches the
 * browser. Without a key the feature still works with raw coordinates + a
 * user-typed label.
 */
export function createGeocoder({ apiKey }) {
  const enabled = Boolean(apiKey);

  return {
    enabled,

    /** Returns a short human label ("Koramangala, Bengaluru") or '' on any failure. */
    async reverse({ lat, lng }) {
      if (!enabled) return '';
      try {
        const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
        url.searchParams.set('latlng', `${lat},${lng}`);
        url.searchParams.set('result_type', 'neighborhood|sublocality|locality|administrative_area_level_2');
        url.searchParams.set('key', apiKey);
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const first = data.results?.[0];
        if (!first) return '';
        const parts = first.address_components || [];
        const pick = (type) => parts.find((c) => c.types.includes(type))?.long_name;
        const area = pick('neighborhood') || pick('sublocality') || pick('sublocality_level_1');
        const city = pick('locality') || pick('administrative_area_level_2');
        const label = [area, city].filter(Boolean).join(', ') || first.formatted_address || '';
        return label.slice(0, 120);
      } catch (err) {
        log.warn('Reverse geocoding failed', { reason: err.message });
        return '';
      }
    },

    /** Static map PNG for an entry, fetched server-side so the key stays secret. */
    async staticMap({ lat, lng }) {
      if (!enabled) return null;
      const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
      url.searchParams.set('center', `${lat},${lng}`);
      url.searchParams.set('zoom', '14');
      url.searchParams.set('size', '640x220');
      url.searchParams.set('scale', '2');
      url.searchParams.set('markers', `color:0x6c5ce7|${lat},${lng}`);
      url.searchParams.set('key', apiKey);
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
