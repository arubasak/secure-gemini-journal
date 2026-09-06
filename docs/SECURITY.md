# Security design notes

This document explains the threat model and the controls in the Secure Personal Gemini Journal.

## Threat model

| Threat | Control |
|---|---|
| Unauthenticated access to the API | `requireAuth` middleware verifies a Firebase ID token (signature, expiry, audience, issuer) on every `/api/*` request. |
| User A reads/edits/deletes user B's data (IDOR) | All Firestore paths are built from `req.user.uid` derived from the token. No route accepts a user id from the client. Tests in `tests/app.test.js` assert 404 for cross-user read, update, delete and chat. |
| Client SDK bypasses the API | `firestore.rules` allows owner-only reads and **no** client writes; `meta` and `audit` are server-only. |
| Leaked API keys | Gemini/Maps keys exist only in Secret Manager. Cloud Run injects them as env vars via `--set-secrets`; the runtime service account holds only `secretmanager.secretAccessor`. Keys are never logged or sent to the browser. The Maps static image is proxied so the key stays server-side. |
| Privilege escalation to admin | The `admin` role is a Firebase custom claim that can only be set with Admin SDK credentials (`scripts/grant-admin.js`). The client cannot mint claims. Admin endpoints additionally pass `requireAdmin`. |
| Prompt injection through journal text | System instructions state that entry text is data, never instructions, and forbid revealing the prompt. Analysis uses a strict `responseSchema`, and `normalizeMood` re-validates every field (enum, ranges, lengths). |
| XSS via AI or user content | The frontend never uses `innerHTML`. Gemini output goes through a whitelist Markdown renderer that only creates `p`, `ul`, `li`, `strong`, `em` and text nodes. A strict CSP (`script-src 'self' gstatic apis.google.com`) blocks inline scripts. |
| Clickjacking / framing | `frame-ancestors 'none'`, `X-Frame-Options` via helmet. |
| Abuse / cost blow-up | Global limiter (400 req / 15 min / IP) and per-user AI limiter (40 / 15 min / uid), `64kb` JSON limit, hard caps on entry (10 000 chars) and message (2 000 chars) length, chat history trimmed to 20 turns, weekly reflection cached per signature. |
| Path traversal / malformed ids | `isDocId` allows only `[A-Za-z0-9_-]{1,64}`; invalid ids return 400 before any Firestore access. |
| Container compromise | Non-root `node` user, `npm ci --omit=dev`, minimal `node:22-slim` base, no shell tooling required at runtime. |
| Data retention / right to erasure | `GET /api/account/export` returns every document; `DELETE /api/account` performs `recursiveDelete` on the user subtree and deletes the Auth user. |

## Identity flow

1. Browser signs in with Firebase (Google or email/password).
2. `user.getIdToken()` yields a short-lived JWT, sent as `Authorization: Bearer`.
3. Server: `admin.auth().verifyIdToken(token)` → `{ uid, email, name, admin }`.
4. All reads/writes use `users/{uid}` built from that `uid`.

## Secret handling

```
Secret Manager                 Cloud Run revision                 Process
gemini-api-key:latest   ──►  env GEMINI_API_KEY        ──►  new GoogleGenAI({ apiKey })
firebase-web-config     ──►  env FIREBASE_WEB_CONFIG   ──►  served at /api/config (public identifiers only)
maps-api-key (optional) ──►  env MAPS_API_KEY          ──►  server-side geocoding + static map proxy
```
If an env var is absent (e.g. local dev) `server/config.js` calls `accessSecretVersion` directly with ADC. Missing required config aborts startup with a clear message rather than running insecurely.

## Logging & audit

* Structured JSON logs with `severity` for Cloud Logging. Secrets and journal content are never logged.
* `audit/{id}` records `user.create`, `entry.create`, `entry.delete`, `account.export`, `account.delete` with a SHA-256 hashed subject id.

## Headers set by helmet

`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (needed for the Google sign-in popup), `X-Frame-Options: DENY`, and `Cache-Control: no-store` on all authenticated responses.

## Residual risks / future work

* Email/password accounts are not forced to verify email unless `REQUIRE_VERIFIED_EMAIL=true`.
* Rate limiting is per-instance (in-memory). For multi-instance scale, back it with Memorystore.
* Consider Cloud Armor in front of Cloud Run for L7 protection, and App Check to attest the web client.
