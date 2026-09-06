import { log } from './logger.js';

/**
 * Authentication + authorization middleware.
 *
 * Every /api route must carry `Authorization: Bearer <Firebase ID token>`.
 * The token is verified by Firebase Admin (signature, expiry, audience, issuer,
 * and revocation). The verified `uid` is the ONLY identity ever used for data
 * access. The client can never choose which user's data it touches.
 *
 * Hardened after review in the AI Studio security session (see
 * docs/AI_STUDIO_CUSTOM_INSTRUCTIONS.md): revocation check, no-store headers on
 * every authenticated path, structured logging of verification failures, and a
 * provider-independent email-verification check.
 */
export function requireAuth(auth, { requireVerifiedEmail = false } = {}) {
  return async (req, res, next) => {
    // Authenticated responses (including auth failures) must never be cached.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');

    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return res.status(401).json({ error: 'Authentication required' });
    try {
      // checkRevoked=true: a deleted/disabled user or a revoked session is rejected
      // immediately instead of remaining valid until the token's natural expiry.
      const decoded = await auth.verifyIdToken(match[1], true);
      if (requireVerifiedEmail && decoded.email && !decoded.email_verified) {
        return res.status(403).json({ error: 'Please verify your email address before using the journal' });
      }
      req.user = {
        uid: decoded.uid,
        email: decoded.email || null,
        name: decoded.name || null,
        // Role-based access: `admin` is a Firebase custom claim set server-side
        // (scripts/grant-admin.js). It can never be set from the client.
        admin: decoded.admin === true,
      };
      return next();
    } catch (err) {
      // Log the failure class for monitoring, never the token itself.
      log.warn('Token verification failed', { code: err?.code || 'UNKNOWN_AUTH_ERROR', path: req.path });
      const revoked = err?.code === 'auth/id-token-revoked' || err?.code === 'auth/user-disabled';
      return res.status(401).json({
        error: revoked ? 'Your session has been signed out. Please sign in again.' : 'Invalid or expired session. Please sign in again.',
      });
    }
  };
}

/** Must run after requireAuth. */
export function requireAdmin() {
  return (req, res, next) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin role required' });
    return next();
  };
}
