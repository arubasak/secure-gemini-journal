# One-command deployment of the Secure Personal Gemini Journal to Cloud Run (Windows / PowerShell).
#
# Usage:
#   $env:PROJECT_ID = "my-project"; $env:REGION = "asia-south1"; .\deploy.ps1
# Optional: $env:GEMINI_API_KEY, $env:MAPS_API_KEY, $env:GEMINI_MODEL, $env:SERVICE
# If .\firebase-web-config.json exists it is uploaded as the `firebase-web-config` secret.
$ErrorActionPreference = "Stop"

$ProjectId = if ($env:PROJECT_ID) { $env:PROJECT_ID } else { (gcloud config get-value project 2>$null).Trim() }
$Region = if ($env:REGION) { $env:REGION } else { "asia-south1" }
$Service = if ($env:SERVICE) { $env:SERVICE } else { "gemini-journal" }
$SaName = if ($env:SA_NAME) { $env:SA_NAME } else { "gemini-journal-sa" }
$Model = if ($env:GEMINI_MODEL) { $env:GEMINI_MODEL } else { "gemini-3.6-flash" }
$Sa = "$SaName@$ProjectId.iam.gserviceaccount.com"
if (-not $ProjectId) { throw "PROJECT_ID is not set and no default gcloud project found" }
Write-Host "==> Project: $ProjectId  Region: $Region  Service: $Service"

Write-Host "==> Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com identitytoolkit.googleapis.com --project $ProjectId --quiet

Write-Host "==> Runtime service account (least privilege)"
gcloud iam service-accounts describe $Sa --project $ProjectId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { gcloud iam service-accounts create $SaName --display-name "Gemini Journal runtime" --project $ProjectId }
foreach ($role in @("roles/secretmanager.secretAccessor", "roles/datastore.user", "roles/firebaseauth.admin", "roles/logging.logWriter")) {
  gcloud projects add-iam-policy-binding $ProjectId --member "serviceAccount:$Sa" --role $role --condition=None --quiet | Out-Null
}

Write-Host "==> Secrets in Secret Manager"
function Ensure-Secret($name) {
  gcloud secrets describe $name --project $ProjectId 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { gcloud secrets create $name --replication-policy automatic --project $ProjectId }
}
Ensure-Secret "gemini-api-key"
Ensure-Secret "firebase-web-config"
if ($env:GEMINI_API_KEY) {
  $tmp = New-TemporaryFile
  [System.IO.File]::WriteAllText($tmp.FullName, $env:GEMINI_API_KEY)
  gcloud secrets versions add gemini-api-key --data-file=$tmp.FullName --project $ProjectId
  Remove-Item $tmp.FullName -Force
}
if (Test-Path "firebase-web-config.json") {
  gcloud secrets versions add firebase-web-config --data-file=firebase-web-config.json --project $ProjectId
}
$Secrets = "GEMINI_API_KEY=gemini-api-key:latest,FIREBASE_WEB_CONFIG=firebase-web-config:latest"
if ($env:MAPS_API_KEY) {
  Ensure-Secret "maps-api-key"
  $tmp = New-TemporaryFile
  [System.IO.File]::WriteAllText($tmp.FullName, $env:MAPS_API_KEY)
  gcloud secrets versions add maps-api-key --data-file=$tmp.FullName --project $ProjectId
  Remove-Item $tmp.FullName -Force
}
gcloud secrets describe maps-api-key --project $ProjectId 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $Secrets = "$Secrets,MAPS_API_KEY=maps-api-key:latest" }
foreach ($s in @("gemini-api-key", "firebase-web-config")) {
  $versions = gcloud secrets versions list $s --project $ProjectId --filter="state=enabled" --format="value(name)"
  if (-not $versions) { throw "Secret '$s' has no enabled version. Add one with: gcloud secrets versions add $s --data-file=<file> --project $ProjectId" }
}

Write-Host "==> Firestore vector index for 'Ask my journal' (idempotent, builds in the background)"
$existing = gcloud firestore indexes composite list --project $ProjectId --format "value(fields.fieldPath)" 2>$null | Select-String "embedding"
if (-not $existing) {
  gcloud firestore indexes composite create --project $ProjectId --collection-group=entries --query-scope=COLLECTION --field-config='vector-config={"dimension":"768","flat":"{}"},field-path=embedding' --quiet --async
}

Write-Host "==> Deploying to Cloud Run (source build)"
gcloud run deploy $Service `
  --source . `
  --project $ProjectId `
  --region $Region `
  --platform managed `
  --allow-unauthenticated `
  --service-account $Sa `
  --set-secrets $Secrets `
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$ProjectId,GEMINI_MODEL=$Model,CLOUD_RUN_REGION=$Region,NODE_ENV=production$(if ($env:APP_URL) { ",APP_URL=$($env:APP_URL)" })" `
  --labels "dev-tutorial=cloud-run-ai-challenge" `
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 80 --timeout 60 --port 8080 `
  --quiet
if ($LASTEXITCODE -ne 0) { throw "gcloud run deploy failed" }

$Url = (gcloud run services describe $Service --project $ProjectId --region $Region --format "value(status.url)").Trim()
# Tell the service its own public URL (appended to Slack/Discord notifications).
if (-not $env:APP_URL) {
  Write-Host "==> Setting APP_URL=$Url"
  gcloud run services update $Service --project $ProjectId --region $Region --update-env-vars "APP_URL=$Url" --quiet | Out-Null
}
$Label = (gcloud run services describe $Service --project $ProjectId --region $Region --format "value(metadata.labels.dev-tutorial)").Trim()
Write-Host ""
Write-Host "==> Deployed: $Url"
Write-Host "==> Label dev-tutorial=$Label"
Write-Host ""
Write-Host "NEXT: add '$($Url -replace '^https://','')' to Firebase Console -> Authentication -> Settings -> Authorized domains,"
Write-Host "      then deploy the Firestore rules:  npm run rules:deploy -- --project $ProjectId"
