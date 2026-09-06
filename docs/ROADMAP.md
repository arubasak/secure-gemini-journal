# Roadmap: from Secure Personal Gemini Journal to a next-generation wellness partner

The shipped app (September 2026) is a secure, cloud-native journal. This document records where it goes next, in three horizons. Every item inherits the same rule set as the current build: the constitution in [AI_STUDIO_CUSTOM_INSTRUCTIONS.md](AI_STUDIO_CUSTOM_INSTRUCTIONS.md) is extended with an addendum *before* the integration is written.

## Shipped today (baseline)

Firebase Auth (Google + email) · multi-turn Gemini chat with streaming and auto-summaries · per-user Firestore isolation with server-only rules · Vertex AI backend (no API key in the deployment) · Mood Compass insights and weekly review · location-aware entries with server-side geocoding · RBAC admin dashboard · Slack/Discord nudges · "Ask my journal" retrieval with citations · voice notes · export and hard delete · 27 unit tests and a 25-check live suite.

---

## Horizon 1 – Web, weeks not months (reuses what exists)

| Feature | What it does | Builds on | Effort |
|---|---|---|---|
| **Temporal threading** | On save, vector-search the writer's own past entries and open the companion with "Last month you wrote about X. How does today compare?" Closes unresolved loops across time. | Ask-my-journal retrieval + chat system prompt | ~40 lines |
| **Divergence detection (web-flavoured)** | Compare the mood Gemini reads from the text with the tone it hears in a voice note; gently surface a mismatch ("Your words say fine, your voice sounded tired"). | Voice notes + Mood Compass | one extra prompt + UI chip |
| **Scheduled evening check-in** | Cloud Scheduler hits a protected endpoint that sends the opt-in webhook nudge at the user's chosen hour. | Notifications | Cloud Scheduler job + one route |
| **Photo entries** | Attach a photo; Gemini describes it and folds it into the reflection. Signed Cloud Storage URLs scoped per user. | Storage rules mirror Firestore rules | small |
| **Firebase App Check** | Attest the web client with reCAPTCHA Enterprise so only the real frontend can call the API. | Existing token middleware | small, needs frontend SDK |
| **Silent context** | Optional weather and calendar tags pulled server-side at save time (user-granted OAuth scope for Calendar), so entries carry context without manual logging. | Entry model, addendum for new OAuth scope | medium |

## Horizon 2 – Web, bigger bets

- **Gemini Live voice companion.** Real-time two-way voice over WebSockets (Cloud Run supports them), with the week's entries preloaded as context.
- **Agentic weekly coach.** Gemini function-calling over the app's own API: read insights, draft next week's intentions, schedule its own nudges. Every tool call lands in the audit trail.
- **Multimodal life timeline.** Entries, photos, places and moods on a map plus timeline; Gemini writes a monthly "chapter".
- **Shared journals with fine-grained roles.** Couples or therapy dyads, using custom claims per journal and per-document rules; the hardest stress test of the RBAC foundation.
- **Client-side end-to-end encryption.** Keys derived in the browser with WebCrypto so the operator cannot read entries; Gemini runs on decrypted text only within a request. Hard to get right, strongest possible privacy story.
- **Anomaly detection with a safety net.** Score mood trajectories over weeks; with explicit consent and clear thresholds, alert a trusted contact on sustained decline. Ethically sensitive: opt-in, human review, crisis resources always shown.

## Horizon 3 – Native Android build (separate product track)

The brainstorm's "next-gen journal" pillars (multimodal ambient input, proactive hyper-personalised prompting, on-device privacy, biometric analytics) need a native client. This is a different codebase that reuses the same backend, Firestore schema and constitution.

```
[Wearables: Pixel Watch / Fitbit / Garmin / Samsung / Oura]
              │
              ▼
    [Health Connect SDK]  on-device encrypted store, granular per-metric permissions
              │
              ▼
    [Android client]
       ├─ Gemini Nano via AICore (on-device): summarise raw HR / HRV / sleep series into
       │   semantic flags, e.g. {"afternoon_stress_event": true, "sleep_deficit_hours": 1.8};
       │   raw telemetry never leaves the phone
       ├─ Ambient voice capture with tone cues alongside the transcript
       └─ Same Firebase ID token → same Cloud Run API
              │
              ▼
    [Cloud Run + Vertex AI Gemini]  function-calling tool get_biometric_context(timeframe)
       ├─ Divergence detection: "Your body was running hot at 3 PM. Did something happen
       │   that you are downplaying?"
       ├─ Temporal threading across months (long-context)
       └─ Trend insights: "You express 30% more anxiety on Tuesdays"
```

Sequenced milestones:

1. **Backend first.** Add a `context` sub-document per entry (flags only, never raw series) and a `get_biometric_context` tool definition; ship the addendum for biometric data (consent, retention, no raw telemetry in the cloud).
2. **Android shell.** Kotlin app with Firebase Auth, the existing REST API, and Health Connect read permissions for sleep and heart rate only.
3. **On-device summarisation.** Gemini Nano through AICore on supported Pixel/Samsung devices; graceful fallback to "no biometric context" elsewhere.
4. **Proactive prompting.** WorkManager job that asks the backend for a contextual prompt when a stress flag is set, delivered as a notification.
5. **Biometric analytics** in Insights, computed from flags, with the same privacy posture as the admin dashboard (aggregates, never raw).

## Explicitly out of scope, and why

- **Raw biometric streams in the cloud.** Violates the constitution's data-minimisation stance; only on-device-derived flags may leave the phone.
- **Ad-targeting or model training on journal content.** Never. The product only works if users trust that self-censorship is unnecessary.
- **Medical diagnosis.** The companion names patterns and points to help; it does not diagnose.
