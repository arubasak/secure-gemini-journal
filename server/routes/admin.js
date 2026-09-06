import { Router } from 'express';
import { requireAdmin } from '../auth.js';

/**
 * /api/admin - role-based admin dashboard.
 *
 * Access requires the `admin: true` custom claim on the Firebase user, which can
 * only be set server-side (scripts/grant-admin.js). The dashboard is deliberately
 * privacy-preserving: it exposes counters, hashed user ids and audit events -
 * never journal content, emails, or names.
 */
export function adminRouter({ store, config }) {
  const r = Router();
  r.use(requireAdmin());

  r.get('/overview', async (req, res) => {
    const overview = await store.adminOverview();
    res.json({
      ...overview,
      service: {
        name: process.env.K_SERVICE || 'local',
        revision: process.env.K_REVISION || 'dev',
        region: process.env.CLOUD_RUN_REGION || null,
        model: config.geminiModel,
        mapsEnabled: Boolean(config.mapsApiKey),
        node: process.version,
      },
    });
  });

  return r;
}
