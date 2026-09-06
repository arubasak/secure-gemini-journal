#!/usr/bin/env node
/**
 * Grant or revoke the `admin` role (Firebase custom claim) for a user.
 * Runs with Application Default Credentials - no key files.
 *
 *   node scripts/grant-admin.js user@example.com            # grant
 *   node scripts/grant-admin.js user@example.com --revoke   # revoke
 *
 * Requires: GOOGLE_CLOUD_PROJECT (or a gcloud default project) and
 *           `gcloud auth application-default login` by a project owner/editor.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/grant-admin.js <email> [--revoke]');
  process.exit(1);
}
const revoke = flag === '--revoke';
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth();
const user = await auth.getUserByEmail(email);
const claims = { ...(user.customClaims || {}) };
if (revoke) delete claims.admin;
else claims.admin = true;
await auth.setCustomUserClaims(user.uid, claims);
// Force a token refresh so the change takes effect on next sign-in / getIdToken(true).
await auth.revokeRefreshTokens(user.uid);
console.log(`${revoke ? 'Revoked' : 'Granted'} admin for ${email} (${user.uid}). The user must sign out and back in.`);
