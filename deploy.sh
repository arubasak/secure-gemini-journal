#!/usr/bin/env bash
# One-command deployment of the Secure Personal Gemini Journal to Cloud Run.
#
# Usage:
#   PROJECT_ID=my-project REGION=asia-south1 ./deploy.sh
#
# Optional env vars:
#   GEMINI_API_KEY   - if set, a new Secret Manager version is added (never stored on disk)
#   MAPS_API_KEY     - optional Maps Platform key for location-aware entries
#   GEMINI_BACKEND   - vertex (default, no API key needed) or aistudio (needs GEMINI_API_KEY)
#   GEMINI_MODEL     - defaults to gemini-2.5-flash on vertex, gemini-3.6-flash on aistudio
#   SERVICE          - Cloud Run service name (default gemini-journal)
#
# If ./firebase-web-config.json exists it is uploaded as the `firebase-web-config` secret.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-gemini-journal}"
SA_NAME="${SA_NAME:-gemini-journal-sa}"
GEMINI_BACKEND="${GEMINI_BACKEND:-vertex}"   # vertex (no key needed) | aistudio (needs a Gemini API key)
if [[ -z "${GEMINI_MODEL:-}" ]]; then
  if [[ "$GEMINI_BACKEND" == "vertex" ]]; then GEMINI_MODEL=gemini-2.5-flash; else GEMINI_MODEL=gemini-3.6-flash; fi
fi
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

[[ -n "$PROJECT_ID" ]] || { echo "PROJECT_ID is not set and no default gcloud project found"; exit 1; }
echo "==> Project: $PROJECT_ID  Region: $REGION  Service: $SERVICE"

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com identitytoolkit.googleapis.com aiplatform.googleapis.com \
  --project "$PROJECT_ID" --quiet

echo "==> Runtime service account (least privilege)"
if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name "Gemini Journal runtime" --project "$PROJECT_ID"
fi
for role in roles/secretmanager.secretAccessor roles/datastore.user roles/firebaseauth.admin roles/logging.logWriter roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" \
    --condition=None --quiet >/dev/null
done

echo "==> Secrets in Secret Manager"
ensure_secret() {
  gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1 ||
    gcloud secrets create "$1" --replication-policy automatic --project "$PROJECT_ID"
}
ensure_secret gemini-api-key
ensure_secret firebase-web-config
if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=- --project "$PROJECT_ID"
fi
if [[ -f firebase-web-config.json ]]; then
  gcloud secrets versions add firebase-web-config --data-file=firebase-web-config.json --project "$PROJECT_ID"
fi
# Vertex AI (default) authenticates with the service account, so no Gemini key is mounted.
SECRETS="FIREBASE_WEB_CONFIG=firebase-web-config:latest"
if [[ "$GEMINI_BACKEND" == "aistudio" ]]; then
  SECRETS="GEMINI_API_KEY=gemini-api-key:latest,$SECRETS"
fi
if [[ -n "${MAPS_API_KEY:-}" ]]; then
  ensure_secret maps-api-key
  printf '%s' "$MAPS_API_KEY" | gcloud secrets versions add maps-api-key --data-file=- --project "$PROJECT_ID"
fi
if gcloud secrets describe maps-api-key --project "$PROJECT_ID" >/dev/null 2>&1; then
  SECRETS="$SECRETS,MAPS_API_KEY=maps-api-key:latest"
fi
REQUIRED_SECRETS=(firebase-web-config)
[[ "$GEMINI_BACKEND" == "aistudio" ]] && REQUIRED_SECRETS+=(gemini-api-key)
for s in "${REQUIRED_SECRETS[@]}"; do
  if ! gcloud secrets versions list "$s" --project "$PROJECT_ID" --filter="state=enabled" --format="value(name)" | grep -q .; then
    echo "Secret '$s' has no enabled version. Add one, e.g.:"
    echo "  printf '%s' 'VALUE' | gcloud secrets versions add $s --data-file=- --project $PROJECT_ID"
    exit 1
  fi
done

echo "==> Firestore vector index for 'Ask my journal' (idempotent, builds in the background)"
if ! gcloud firestore indexes composite list --project "$PROJECT_ID" --format 'value(fields.fieldPath)' 2>/dev/null | grep -q 'embedding'; then
  gcloud firestore indexes composite create --project "$PROJECT_ID" \
    --collection-group=entries --query-scope=COLLECTION \
    --field-config='vector-config={"dimension":"768","flat":"{}"},field-path=embedding' --quiet --async || true
fi

echo "==> Deploying to Cloud Run (source build)"
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "$SA" \
  --set-secrets "$SECRETS" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GEMINI_MODEL=$GEMINI_MODEL,GEMINI_BACKEND=$GEMINI_BACKEND,CLOUD_RUN_REGION=$REGION,NODE_ENV=production${APP_URL:+,APP_URL=$APP_URL}" \
  --labels "dev-tutorial=cloud-run-ai-challenge" \
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 80 --timeout 60 --port 8080 \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
# Tell the service its own public URL (appended to Slack/Discord notifications).
# Skipped when APP_URL was passed in explicitly; otherwise creates one extra revision.
if [[ -z "${APP_URL:-}" ]]; then
  echo "==> Setting APP_URL=$URL"
  gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --update-env-vars "APP_URL=$URL" --quiet >/dev/null
fi
LABEL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(metadata.labels.dev-tutorial)')"
echo
echo "==> Deployed: $URL"
echo "==> Label dev-tutorial=$LABEL"
echo
echo "NEXT: add '${URL#https://}' to Firebase Console -> Authentication -> Settings -> Authorized domains,"
echo "      then deploy the Firestore rules:  npm run rules:deploy -- --project $PROJECT_ID"
