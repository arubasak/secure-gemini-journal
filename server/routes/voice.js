import { Router } from 'express';
import express from 'express';
import { ValidationError } from '../validation.js';

const ALLOWED_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/aac'];
const MAX_BYTES = 4 * 1024 * 1024; // ~90 s of opus at 128 kbps is well under this

/**
 * /api/voice/transcribe - voice notes. Audio is sent as base64 JSON, forwarded
 * to Gemini (native audio understanding) and never stored.
 */
export function voiceRouter({ gemini, aiLimiter }) {
  const r = Router();

  // Parser limit sits above MAX_BYTES (base64 inflates by 4/3) so oversized clips get a clear 400, not a bare 413.
  r.post('/transcribe', express.json({ limit: '8mb' }), aiLimiter, async (req, res) => {
    const { mimeType, audio } = req.body || {};
    const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(type)) throw new ValidationError('Unsupported audio format');
    if (typeof audio !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(audio)) throw new ValidationError('Audio payload is invalid');
    const bytes = Math.floor((audio.length * 3) / 4);
    if (bytes < 1000) throw new ValidationError('Recording is too short');
    if (bytes > MAX_BYTES) throw new ValidationError('Recording is too long (max ~90 seconds)');
    const text = await gemini.transcribe({ mimeType: type, base64: audio });
    if (!text) return res.json({ text: '', message: 'Could not hear anything in that recording.' });
    return res.json({ text: text.slice(0, 10000) });
  });

  return r;
}
