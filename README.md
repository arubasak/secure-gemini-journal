# Secure Personal Gemini Journal

A production-grade, cloud-native journaling app: sign in with Firebase, write private entries, and reflect on them in multi-turn conversations with Gemini. Every user's data is isolated in Cloud Firestore, every API key lives in Google Cloud Secret Manager, and the whole thing runs as one container on Cloud Run.

Built for the **Gen AI Academy APAC Cohort 3 Ideathon** (`#AccelerateAIwithCloudRun`).

> **Live demo:** <https://gemini-journal-rhmu3r743q-el.a.run.app>
> **Cloud Run label:** `dev-tutorial=cloud-run-ai-challenge` (set automatically by `deploy.sh`)

---

## What it does

### Base requirements
| Requirement | Implementation |
|---|---|
| **Firebase Authentication** | Google sign-in and email/password (with verification and password reset). Every API call carries a Firebase ID token that the backend verifies with the Admin SDK. |
| **Gemini API (AI Studio)** | Multi-turn reflection chat per entry via `@google/genai` chat sessions with persisted history; every conversation is **automatically summarised** after each exchange and saved on the entry; structured JSON analysis using `responseSchema`. |
| **AI Studio custom instructions (Phase 1)** | The security "constitution" used to generate this project, plus the per-integration addenda, is in [docs/AI_STUDIO_CUSTOM_INSTRUCTIONS.md](docs/AI_STUDIO_CUSTOM_INSTRUCTIONS.md). |
| **Cloud Firestore** | All documents live under `users/{uid}/...`. `uid` always comes from the verified token. Security rules deny all client writes and allow owner-only reads. |
| **Gemini backend** | Two supported backends. `vertex` (default) calls Gemini through **Vertex AI** using the Cloud Run service account, so no API key exists to leak and usage bills to normal Cloud billing. `aistudio` uses a Generative Language API key from Secret Manager. Switch with `GEMINI_BACKEND`. |
| **Secret Manager** | `GEMINI_API_KEY`, `FIREBASE_WEB_CONFIG` and the optional `MAPS_API_KEY` are Secret Manager secrets injected into Cloud Run with `--set-secrets`. Nothing is hardcoded. |
| **Cloud Run** | Non-root Node 22 container, source-deployed, labelled `dev-tutorial=cloud-run-ai-challenge`, least-privilege runtime service account. |

### Beyond the base app (original features)

1. **Mood Compass** – When you save an entry Gemini returns a strict-JSON analysis (mood, valence −2…+2, energy, themes, one-line summary, a follow-up prompt). The Insights page turns this into a mood-over-time chart, mood distribution, recurring themes, day streaks and a Gemini-written **"Week in review"** that is cached per user and regenerated only when the week's entries change.
2. **Location-aware entries** – Optional, consent-driven browser geolocation. If a Maps Platform key is configured the server reverse-geocodes to a friendly place name and proxies a static map image, so the Maps key never reaches the browser. Without a key the feature still works with coordinates and a typed label. Places also appear in Insights ("places you write from").
3. **Role-based admin dashboard** – The `admin` Firebase custom claim (granted only server-side with `scripts/grant-admin.js`) unlocks a dashboard with service health, aggregate counters and an audit trail. It is deliberately privacy-preserving: user ids are SHA-256 hashed and journal content is never readable from the admin API.
4. **External notifications (Slack / Discord)** – Users can connect an incoming-webhook URL and opt in to content-free nudges: a gentle check-in after a very low-mood entry, and milestone celebrations (7 / 30 / 100 entries). The URL is validated against a strict host allow-list (SSRF-safe), stored in a server-only Firestore document and never echoed back.
5. **Ask my journal (RAG over your own entries)** – Every entry is embedded with `gemini-embedding-001` (768 dims) and stored as a Firestore vector. Questions like "when did I last feel calm?" are embedded, matched with Firestore `findNearest` scoped to `users/{uid}/entries`, and answered by Gemini with numbered citations that link back to the entries. Raw vectors never leave the data layer.
6. **Streaming replies** – The reflection chat streams Gemini's answer token by token over Server-Sent Events, with automatic fallback to the non-streaming endpoint.
7. **Voice notes** – Record in the browser (MediaRecorder), Gemini transcribes the audio natively; nothing is stored server-side, clips are capped at ~90 s.
8. **Data ownership** – One-click JSON export of everything, and a confirmed "delete my account" that erases the Firestore subtree *and* the Firebase Auth user.

---

## How this was built (Ideathon Phase 1 → 3)

1. **Phase 1 – constitution first.** Google AI Studio was configured with the security custom instructions in [docs/AI_STUDIO_CUSTOM_INSTRUCTIONS.md](docs/AI_STUDIO_CUSTOM_INSTRUCTIONS.md): threat-model-first, default-deny auth, per-user Firestore isolation, Secret Manager only, SSRF/XSS/prompt-injection rules.
2. **Phase 2 – base app under those directives.** The code was developed with AI assistance operating under that constitution, then reviewed in the configured AI Studio session (Gemini 3.8 Flash, saved prompt "Firestore Rules Security Review"). The review of `firestore.rules` and `server/auth.js` passed the isolation and authorization checks and raised four findings, all applied before the final deploy: revocation-aware token verification (`checkRevoked`), no-store cache headers on every authenticated path, structured logging of verification failures, and a provider-independent email-verification check.
3. **Phase 3 – extensions, with an addendum each time.** Before every new integration (Maps, RBAC, webhooks, retrieval/streaming/voice) the constitution was extended with the matching addendum in the same document, as the Ideathon brief recommends. The webhook integration was reviewed in the same AI Studio session against Addendum C, which raised five findings that were all applied: `discord.com` only (the legacy host redirects, which the code forbids), exact Slack path shape, trailing-dot hostname normalisation, a bounded milestone count, and a low-mood message that carries crisis guidance and an "AI, not a therapist" notice instead of an emotional judgement.

**Where it goes next:** [docs/ROADMAP.md](docs/ROADMAP.md) covers the near-term web features (temporal threading, divergence detection, scheduled check-ins), the bigger web bets, and the native Android track with Health Connect and on-device Gemini Nano.

<!-- Optional: name any additional AI coding assistants used alongside AI Studio here. -->

---

## Architecture

```
Browser (vanilla JS, Firebase Auth SDK)
   │  Authorization: Bearer <Firebase ID token>
   ▼
Cloud Run service  (Node 22 · Express 5 · helmet · rate limits)
   ├── verifyIdToken()  ─────────────►  Firebase Authentication
   ├── users/{uid}/entries/{id}/messages ─►  Cloud Firestore   (Admin SDK, ADC)
   ├── chats.create / generateContent ────►  Gemini API        (key from Secret Manager)
   ├── geocode / staticmap (optional) ────►  Maps Platform     (key from Secret Manager)
   └── structured JSON logs ─────────────►  Cloud Logging
```

**Data model**

```
users/{uid}                      profile: createdAt, lastSeenAt, entryCount
users/{uid}/entries/{entryId}    title, content, location?, analysis{mood,score,energy,themes,summary,prompt},
                                 summary{text,messageCount,updatedAt} (auto-saved conversation summary), messageCount
users/{uid}/entries/{id}/messages/{msgId}   role: user|model, text, seq, createdAt
users/{uid}/insights/weekly      cached reflection: text, signature, entryCount, generatedAt
users/{uid}/private/settings     webhook URL + notification toggles (server-only, rules deny all client access)
meta/stats                       server-only aggregate counters (admin dashboard)
audit/{id}                       server-only events with hashed subject ids
```

**Project layout**

```
server/
  index.js        bootstrap: config → Firebase Admin → Gemini → Express
  config.js       env + Secret Manager resolution (no hardcoded keys)
  auth.js         requireAuth / requireAdmin middleware
  app.js          Express app: helmet CSP, rate limits, routers, SPA fallback
  store.js        Firestore data-access layer (per-user scoping lives here)
  gemini.js       chat sessions, mood analysis (JSON schema), weekly reflection
  geocode.js      reverse geocoding + static map proxy (optional)
  routes/         entries · insights · account · admin
public/           index.html · styles.css · app.js (no framework, no build step)
tests/            node:test suite with in-memory fakes (no credentials needed)
scripts/          grant-admin.js (custom-claim RBAC)
firestore.rules   security rules (owner-only read, no client writes)
Dockerfile        non-root production image
deploy.sh / deploy.ps1   one-command Cloud Run deployment
```

---

## Deploying to Cloud Run

### 0. Prerequisites
* A Google Cloud project with billing enabled, and the [gcloud CLI](https://cloud.google.com/sdk/docs/install) signed in (`gcloud auth login`).
* Node.js 20+ locally (only for tests / local dev).

### 1. Firebase setup (console, ~3 minutes)
1. Open <https://console.firebase.google.com>, **Add project** → pick your existing Google Cloud project.
2. **Authentication → Get started → Sign-in method**: enable **Google** and **Email/Password**.
3. **Firestore Database → Create database** → *production mode*, choose a region (e.g. `asia-south1`).
4. **Project settings → Your apps → Add app → Web**. Copy the `firebaseConfig` object and save it as `firebase-web-config.json` in the repo root (this file is git-ignored):
   ```json
   {"apiKey":"AIza...","authDomain":"PROJECT.firebaseapp.com","projectId":"PROJECT","appId":"1:...:web:..."}
   ```

### 2. Gemini API key
Create a key at <https://aistudio.google.com/apikey>. Do **not** put it in any file.

### 3. Deploy
```bash
export PROJECT_ID=your-project-id
export REGION=asia-south1
export GEMINI_API_KEY=AIza...          # read once, stored only in Secret Manager
# optional: export MAPS_API_KEY=...    # Geocoding API + Maps Static API enabled
./deploy.sh
```
On Windows PowerShell use `.\deploy.ps1` with the same environment variables (`$env:PROJECT_ID = "..."`).

The script is idempotent. It:
* enables Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Firestore and Identity Toolkit APIs;
* creates the runtime service account `gemini-journal-sa` with only `secretmanager.secretAccessor`, `datastore.user`, `firebaseauth.admin` and `logging.logWriter`;
* creates/updates the secrets `gemini-api-key`, `firebase-web-config` (and `maps-api-key`);
* runs `gcloud run deploy --source .` with `--set-secrets`, `--labels dev-tutorial=cloud-run-ai-challenge`, and prints the URL.

### 4. Post-deploy (required)
1. **Authorized domain**: Firebase console → Authentication → Settings → *Authorized domains* → add the Cloud Run host printed by the script (e.g. `gemini-journal-abc123-el.a.run.app`). Without this, Google sign-in fails with `auth/unauthorized-domain`.
2. **Firestore rules**:
   ```bash
   npm run rules:deploy -- --project $PROJECT_ID
   ```
   (uses `firebase-tools` via `npx`; run `npx firebase-tools login` once if prompted.)
3. **Vector index** (needed for "Ask my journal"): `deploy.sh` creates it asynchronously; it takes a few minutes to build. Check with
   ```bash
   gcloud firestore indexes composite list --project $PROJECT_ID --filter 'collectionGroup=entries'
   ```
   or create it by hand / via `firebase deploy --only firestore:indexes` (definition in `firestore.indexes.json`). Until it is READY the Ask page returns a clear "not set up yet" message. Entries written before the feature can be indexed from the Ask page ("Index older entries").
4. **Optional – make yourself admin**:
   ```bash
   gcloud auth application-default login
   GOOGLE_CLOUD_PROJECT=$PROJECT_ID node scripts/grant-admin.js you@example.com
   ```
   Sign out and back in; an **Admin** tab appears.

### 5. Verify the submission requirements
```bash
gcloud run services describe gemini-journal --region $REGION \
  --format 'value(status.url,metadata.labels.dev-tutorial)'
```
should print your URL and `cloud-run-ai-challenge`.

---

## Running locally

```bash
npm install
cp .env.example .env         # fill in GOOGLE_CLOUD_PROJECT and FIREBASE_WEB_CONFIG
gcloud auth application-default login   # ADC for Firestore + Secret Manager
npm run dev                  # http://localhost:8080
```
Leave `GEMINI_API_KEY` empty in `.env` to exercise the Secret Manager fallback path, or paste the key for a quick start. Add `localhost` to Firebase authorized domains (it is there by default).

Tests need no credentials at all:
```bash
npm test
```

---

## Configuration reference

| Variable | Required | Source on Cloud Run | Purpose |
|---|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | yes | env | Project for Firebase Admin + Secret Manager |
| `GEMINI_API_KEY` | only for `aistudio` | Secret `gemini-api-key` | Gemini API key |
| `FIREBASE_WEB_CONFIG` | yes | Secret `firebase-web-config` | Firebase web SDK config (served to the browser from `/api/config`) |
| `MAPS_API_KEY` | no | Secret `maps-api-key` | Enables reverse geocoding + static maps |
| `APP_URL` | no | env (set by deploy script after first deploy) | Link appended to Slack/Discord notifications |
| `GEMINI_BACKEND` | no | env | `vertex` (default, no key) or `aistudio` |
| `VERTEX_LOCATION` | no | env | Vertex region, default `global` |
| `GEMINI_MODEL` | no | env | Default `gemini-3.6-flash` (2.5 Flash is closed to new projects) |
| `AI_RATE_LIMIT` | no | env | Gemini calls per user per 15 min (default 40) |
| `REQUIRE_VERIFIED_EMAIL` | no | env | Block unverified email/password accounts |

If a required secret is missing from the environment, `server/config.js` reads it straight from Secret Manager using the runtime service account, so both Cloud Run patterns (`--set-secrets` and direct API access) are supported.

---

## Security design (summary)

* **Authentication**: Firebase ID tokens verified server-side on every request (`verifyIdToken`). Sessions are never stored server-side; tokens expire hourly and refresh silently.
* **Authorization / isolation**: the `uid` from the verified token is the only key ever used to read or write Firestore. Tests assert that user B gets 404 for user A's entries on read, update, delete and chat.
* **Firestore rules**: owner-only reads, no client writes at all, server-only `meta` and `audit` collections. See [`firestore.rules`](firestore.rules).
* **Secrets**: no keys in code, images or env files; Secret Manager + least-privilege service account.
* **Transport & browser hardening**: strict Content-Security-Policy (scripts only from self and gstatic), HSTS, `frame-ancestors 'none'`, COOP `same-origin-allow-popups`, no `innerHTML` anywhere in the client.
* **Abuse controls**: global and per-user rate limits, 64 KB JSON body cap, 10 000-char entries, 2 000-char messages, validated document ids.
* **AI safety**: the system prompt tells Gemini to treat journal text as data, never instructions; replies are rendered through a whitelist Markdown renderer; a crisis-support note is always visible.
* **Privacy by design**: hashed ids in audit logs, admin API cannot read content, full export and hard delete available to every user.

More detail in [docs/SECURITY.md](docs/SECURITY.md).

---

## License
MIT
