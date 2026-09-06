import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth } from './auth.js';
import { entriesRouter } from './routes/entries.js';
import { insightsRouter } from './routes/insights.js';
import { accountRouter } from './routes/account.js';
import { adminRouter } from './routes/admin.js';
import { askRouter } from './routes/ask.js';
import { voiceRouter } from './routes/voice.js';
import { log } from './logger.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Builds the Express app. Dependencies are injected so tests can run the whole
 * HTTP surface with fakes (no network, no credentials).
 */
export function createApp({ config, auth, store, gemini, geocode, notifier }) {
  const app = express();
  app.disable('x-powered-by');
  // Cloud Run terminates TLS and sets X-Forwarded-For; trust exactly one hop.
  app.set('trust proxy', 1);

  const authDomain = config.firebaseWebConfig.authDomain;
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://www.gstatic.com', 'https://apis.google.com'],
          'style-src': ["'self'"],
          'style-src-attr': ["'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
          'connect-src': [
            "'self'",
            'https://identitytoolkit.googleapis.com',
            'https://securetoken.googleapis.com',
            'https://www.googleapis.com',
            'https://apis.google.com',
            `https://${authDomain}`,
          ],
          'frame-src': [`https://${authDomain}`, 'https://accounts.google.com', 'https://apis.google.com'],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'upgrade-insecure-requests': config.env === 'production' ? [] : null,
        },
      },
      // Required for Firebase signInWithPopup; still blocks cross-origin window references.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: { maxAge: 31536000, includeSubDomains: true },
    })
  );
  // Small JSON bodies everywhere except voice uploads, which carry their own (larger) parser.
  const smallJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => (req.path.startsWith('/api/voice/') ? next() : smallJson(req, res, next)));

  /* ----- rate limits ----- */
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 400,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down a little.' },
  });
  // Per-user budget for routes that call Gemini (protects the API quota).
  const aiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.AI_RATE_LIMIT) || 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.uid || req.ip,
    validate: { keyGeneratorIpFallback: false },
    message: { error: 'You have reached the AI usage limit for now. Please try again in a few minutes.' },
  });

  /* ----- public endpoints ----- */
  // NOTE: Cloud Run's frontend reserves /healthz - requests to it never reach the
  // container - so the health endpoint lives at /health.
  app.get('/health', (req, res) => res.json({ ok: true, revision: process.env.K_REVISION || 'local' }));
  app.get('/api/config', globalLimiter, (req, res) => {
    // Firebase web config is public by design (it identifies the project; access is
    // governed by Auth + security rules). It is still served from config, not hardcoded.
    const { apiKey, authDomain: ad, projectId, appId, messagingSenderId, storageBucket } = config.firebaseWebConfig;
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      firebase: { apiKey, authDomain: ad, projectId, appId, messagingSenderId, storageBucket },
      features: { maps: geocode.enabled, model: config.geminiModel },
    });
  });

  /* ----- authenticated API ----- */
  const api = express.Router();
  api.use(globalLimiter);
  api.use(requireAuth(auth, { requireVerifiedEmail: config.requireVerifiedEmail }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use('/entries', entriesRouter({ store, gemini, geocode, notifier, aiLimiter }));
  api.use('/insights', insightsRouter({ store, gemini, aiLimiter }));
  api.use('/account', accountRouter({ store, auth, notifier }));
  api.use('/ask', askRouter({ store, gemini, aiLimiter }));
  api.use('/voice', voiceRouter({ gemini, aiLimiter }));
  api.use('/admin', adminRouter({ store, config }));
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  /* ----- static frontend + SPA fallback ----- */
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h', etag: true }));
  app.use((req, res, next) => {
    // HEAD is included so uptime checks and link previewers get 200, not a bare 404.
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/')) return next();
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  /* ----- errors ----- */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      log.error('Unhandled request error', { path: req.path, method: req.method, reason: err.message, stack: err.stack });
      return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
    }
    return res.status(status).json({ error: err.message || 'Bad request' });
  });

  return app;
}
