import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Firebase Admin SDK, authenticated with Application Default Credentials
 * (the Cloud Run runtime service account in production). No service-account
 * key files are ever checked in, mounted, or referenced.
 */
export function initFirebase({ projectId }) {
  const app = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return { app, auth: getAuth(app), db };
}
