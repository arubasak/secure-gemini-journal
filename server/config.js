import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from './logger.js';

/**
 * Runtime configuration.
 *
 * Secrets are NEVER hardcoded. Resolution order for each secret:
 *   1. Environment variable. On Cloud Run this is populated by `--set-secrets`,
 *      i.e. Secret Manager versions injected as env vars (the recommended pattern).
 *   2. Direct Secret Manager access via the runtime service account (fallback,
 *      lets the app run anywhere Application Default Credentials exist, e.g.
 *      local dev after `gcloud auth application-default login`).
 */
export async function loadConfig() {
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.FIREBASE_PROJECT_ID ||
    (await detectProjectId());

  const config = {
    port: Number(process.env.PORT) || 8080,
    env: process.env.NODE_ENV || 'production',
    projectId,
    // Two supported Gemini backends:
    //   'vertex'   - Vertex AI, authenticated with the Cloud Run service account (ADC).
    //                Billed to the project's normal Cloud billing account. No API key exists to leak.
    //   'aistudio' - Generative Language API with a key from Secret Manager.
    // Vertex is the default because it needs no key and no AI Studio prepaid credits.
    geminiBackend: process.env.GEMINI_BACKEND === 'aistudio' ? 'aistudio' : 'vertex',
    vertexLocation: process.env.VERTEX_LOCATION || 'global',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    mapsApiKey: process.env.MAPS_API_KEY || '',
    firebaseWebConfig: parseJson(process.env.FIREBASE_WEB_CONFIG),
    requireVerifiedEmail: process.env.REQUIRE_VERIFIED_EMAIL === 'true',
    // Secret names in Secret Manager (only used by the fallback path).
    geminiSecretName: process.env.GEMINI_SECRET_NAME || 'gemini-api-key',
    mapsSecretName: process.env.MAPS_SECRET_NAME || 'maps-api-key',
    firebaseWebConfigSecretName: process.env.FIREBASE_WEB_CONFIG_SECRET_NAME || 'firebase-web-config',
  };

  // The default model differs per backend: 2.5 Flash is closed to new AI Studio
  // projects (Sept 2026) but still available on Vertex AI.
  config.geminiModel = process.env.GEMINI_MODEL || (config.geminiBackend === 'vertex' ? 'gemini-2.5-flash' : 'gemini-3.6-flash');

  // Only the AI Studio backend needs a key; Vertex uses the service account.
  if (config.geminiBackend === 'aistudio' && !config.geminiApiKey) {
    log.info('GEMINI_API_KEY not in env; reading from Secret Manager', { secret: config.geminiSecretName });
    config.geminiApiKey = await accessSecret(projectId, config.geminiSecretName);
  }
  if (!config.firebaseWebConfig) {
    log.info('FIREBASE_WEB_CONFIG not in env; reading from Secret Manager', { secret: config.firebaseWebConfigSecretName });
    config.firebaseWebConfig = parseJson(await accessSecret(projectId, config.firebaseWebConfigSecretName));
  }
  if (!config.mapsApiKey && process.env.MAPS_SECRET_ENABLED === 'true') {
    config.mapsApiKey = await accessSecret(projectId, config.mapsSecretName);
  }

  const missing = [];
  if (!projectId) missing.push('GOOGLE_CLOUD_PROJECT');
  if (config.geminiBackend === 'aistudio' && !config.geminiApiKey) missing.push('GEMINI_API_KEY');
  if (!config.firebaseWebConfig?.apiKey || !config.firebaseWebConfig?.authDomain) missing.push('FIREBASE_WEB_CONFIG');
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}. See README section "Configuration".`);
  }
  return config;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('FIREBASE_WEB_CONFIG is not valid JSON');
  }
}

async function accessSecret(projectId, name) {
  if (!projectId) return '';
  try {
    const client = new SecretManagerServiceClient();
    const [version] = await client.accessSecretVersion({
      name: `projects/${projectId}/secrets/${name}/versions/latest`,
    });
    return version.payload?.data?.toString('utf8').trim() || '';
  } catch (err) {
    log.warn('Secret Manager access failed', { secret: name, reason: err.message });
    return '';
  }
}

async function detectProjectId() {
  // On Cloud Run the metadata server knows the project. Short timeout keeps local dev fast.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok ? (await res.text()).trim() : '';
  } catch {
    return '';
  }
}
