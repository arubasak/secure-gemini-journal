# Social post drafts (mandatory hashtag: #AccelerateAIwithCloudRun)

Replace `<LIVE_URL>` and `<REPO_URL>` before posting. Attach 2–3 screenshots (sign-in, an entry with the Gemini thread, the Mood Compass insights page) or a 60–90 s screen recording.

---

## LinkedIn (long form)

I just shipped my Gen AI Academy APAC Ideathon project: a **Secure Personal Gemini Journal** running on Google Cloud Run. 🚀

The brief was a journal with Firebase sign-in, Gemini conversations, per-user Firestore storage and keys in Secret Manager. I treated that as the launchpad and built three things on top:

🧭 **Mood Compass** – every entry is analysed by Gemini with a strict JSON schema (mood, valence, energy, themes, a follow-up question). Insights shows a mood-over-time chart, recurring themes, streaks, and a Gemini-written "Week in review" that's cached per user and only regenerated when the week's entries change.

📍 **Location-aware entries** – opt-in browser geolocation, reverse-geocoded on the server with a Maps key that never leaves Secret Manager. Static maps are proxied too, so the browser never sees the key.

🛡️ **Role-based admin dashboard** – an `admin` Firebase custom claim (set only server-side) unlocks service health, aggregate usage and an audit trail. It's privacy-preserving by design: hashed user ids, and the admin API physically cannot read journal content.

🔔 **Slack/Discord notifications** – opt-in, content-free nudges after a very low-mood entry and on milestones. Webhook URLs are validated against a strict host allow-list (SSRF-safe), stored server-only and never echoed back.

🔎 **Ask my journal** – "When did I last feel calm?" Entries are embedded with gemini-embedding-001 into Firestore vector search, scoped to the user's own collection, and Gemini answers with citations that link back to the entries. Plus streaming replies over SSE and 🎤 voice notes transcribed natively by Gemini.

And it all started with Phase 1: a security "constitution" in Google AI Studio's custom instructions (threat modelling first, default-deny auth, per-user Firestore isolation, Secret Manager only, SSRF/XSS/prompt-injection rules) that I extended with an addendum before every new integration.

How the stack fits together:
• Firebase Authentication → ID token on every request, verified with the Admin SDK
• Cloud Firestore → everything under users/{uid}; rules deny all client writes, owner-only reads
• Gemini API (AI Studio) → multi-turn chat sessions with persisted history + responseSchema for structured analysis
• Secret Manager → Gemini/Maps/Firebase config injected into Cloud Run with --set-secrets, least-privilege service account
• Cloud Run → non-root Node 22 container, strict CSP, rate limits, labelled dev-tutorial=cloud-run-ai-challenge

Plus one-click data export and a real "delete my account" that erases Firestore and the Auth user. 20 automated tests run the whole HTTP surface with fakes – including cross-user isolation checks.

🔗 Live: <LIVE_URL>
💻 Code: <REPO_URL>

Huge thanks to the Gen AI Academy team for the push to go beyond the demo and build it production-grade.

#AccelerateAIwithCloudRun #GoogleCloud #CloudRun #Gemini #Firebase #GenAIAcademy #BuildWithAI

---

## X / Twitter (short)

Shipped for the Gen AI Academy Ideathon: a Secure Personal Gemini Journal on Cloud Run 🚀

Firebase Auth → per-user Firestore → Gemini multi-turn chat, keys locked in Secret Manager.
Beyond the base app: 🧭 Mood Compass insights + weekly AI review, 📍 location-aware entries, 🛡️ role-based admin dashboard.

Live: <LIVE_URL>
Code: <REPO_URL>

#AccelerateAIwithCloudRun #Gemini #CloudRun

---

## Medium / blog outline (if you prefer a write-up)

1. Why a journal is a great security exercise (personal data, AI in the loop)
2. Architecture diagram (from README)
3. Feature 1: Mood Compass – JSON schema prompt, normalisation, caching the weekly reflection
4. Feature 2: Location-aware entries – consent, server-side geocoding, proxied static maps
5. Feature 3: RBAC admin – custom claims, hashed audit trail, what the admin can't see
6. Security checklist: token verification, Firestore rules, Secret Manager, CSP, rate limits, prompt-injection defence
7. Deploying with one script and the `dev-tutorial=cloud-run-ai-challenge` label
8. What I'd add next (App Check, Cloud Armor, Memorystore-backed rate limits)
