# Ideathon submission kit

Deadline: **6 September 2026, 11:59 PM IST** (dashboard locks).

## Brief description (paste into the form)

**Secure Personal Gemini Journal** is a cloud-native journaling app where users sign in with **Firebase Authentication** (email/password and Google), write private entries, and reflect on them in **multi-turn conversations with Gemini** via the `@google/genai` SDK. Every request carries a Firebase ID token that the Cloud Run backend verifies with the Admin SDK; the verified `uid` is the only key ever used to read or write **Cloud Firestore**, where each user's entries, chat threads and insights live under `users/{uid}`. Firestore security rules deny all client writes and allow owner-only reads, so there is zero cross-user leakage even if the API were bypassed. Credentials (Firebase web config, optional Maps key, and a Gemini API key when that backend is selected) live in **Google Cloud Secret Manager** and are injected into **Cloud Run** with `--set-secrets` under a least-privilege service account; nothing is hardcoded.

The app supports two Gemini backends behind one interface, switched with the `GEMINI_BACKEND` variable. The deployed build uses **Vertex AI**, which authenticates with the Cloud Run service account so that no Gemini API key exists anywhere to leak, and the `aistudio` backend calls the same models through a Generative Language API key held in Secret Manager. Both paths run identical prompt, schema and safety code.

Every conversation is automatically summarised by Gemini after each exchange and saved on the entry. Beyond the base app I built: (1) **Mood Compass** – Gemini analyses each entry with a strict JSON schema (mood, valence, energy, themes, summary, follow-up prompt) powering a mood-trend chart, theme cloud, streaks and a cached, Gemini-written weekly reflection; (2) **Location-aware entries** – opt-in geolocation with server-side reverse geocoding and proxied static maps so the Maps key never reaches the browser; (3) a **role-based admin dashboard** gated by a Firebase custom claim, showing service health, aggregate usage and a hashed audit trail while being unable to read any journal content; (4) **Slack/Discord notifications** – opt-in, content-free nudges after very low-mood entries and on milestones, with SSRF-safe webhook validation; (5) **Ask my journal** – retrieval-augmented answers over the user's own entries using Gemini embeddings and Firestore vector search scoped to `users/{uid}`, with citations linking back to entries; (6) **streaming replies** over Server-Sent Events and (7) **voice notes** transcribed natively by Gemini; plus full JSON export and hard account deletion. Phase 1 (the AI Studio security "constitution" and per-integration addenda) is documented in the repo. The service is hardened with a strict CSP, HSTS, rate limits, input limits, prompt-injection-resistant system instructions, and ships with 26 automated tests covering authentication, per-user isolation (including retrieval), multi-turn and streaming history, RBAC, notifications, voice validation and deletion.

## Checklist

- [x] **Live Cloud Run URL** – https://gemini-journal-rhmu3r743q-el.a.run.app
- [ ] Open it in an incognito window and sign in once to confirm.
- [x] **Label** – verified `dev-tutorial=cloud-run-ai-challenge`.
- [ ] Re-check if you redeploy: `gcloud run services describe gemini-journal --region <REGION> --format 'value(metadata.labels.dev-tutorial)'` prints `cloud-run-ai-challenge`.
- [x] **Firebase authorized domain** added for both run.app hosts.
- [x] **Firestore rules deployed** – already released. Re-run if changed: `npm run rules:deploy -- --project <PROJECT_ID>`; verify in Firebase console → Firestore → Rules.
- [ ] **Public repo** (GitHub/GitLab) containing: `server/`, `public/`, `firestore.rules`, `firebase.json`, `Dockerfile`, `deploy.sh`, `README.md`, `.env.example`, `tests/`. Confirm `.gitignore` excludes `.env` and `firebase-web-config.json`.
- [ ] **Social post** published on LinkedIn / X / Medium with **#AccelerateAIwithCloudRun**, highlighting Mood Compass, location-aware entries and the admin dashboard. Paste the post URL into the form.
- [ ] **Brief description** (above) pasted into the form; mention Firebase, Firestore, Cloud Run and Gemini explicitly.
- [ ] Every mandatory field on the *Ideathon Prototype Submission* tab completed, then **Submit** before 11:59 PM IST.

## Publishing the repo (commands)

```bash
cd gemini-journal
git init -b main
git add .
git commit -m "Secure Personal Gemini Journal - Ideathon submission"
# create an empty public repo on GitHub, then:
git remote add origin https://github.com/<you>/secure-gemini-journal.git
git push -u origin main
```

## Demo script for the video / screenshots (≈90 seconds)

1. Sign in (show the sign-in card and the trust badges). Email/password works out of the box; enable Google in the Firebase console first if you want to demo that button.
2. Write an entry, click **Add location**, save → mood badge, themes and summary appear.
3. Click the suggested prompt, have a 2–3 turn conversation with Gemini.
4. Open **Insights** → mood chart, themes, places, generate the **Week in review**.
5. Open **Account** → download export, show the delete-account confirmation.
6. (Admin user) open **Admin** → service revision, counters, audit trail with hashed ids.
7. Flash the Cloud Run console: service label `dev-tutorial=cloud-run-ai-challenge`, Secret Manager secrets, Firestore rules.
