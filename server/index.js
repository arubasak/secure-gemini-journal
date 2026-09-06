import { loadConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { createStore } from './store.js';
import { createGemini } from './gemini.js';
import { createGeocoder } from './geocode.js';
import { createNotifier } from './notify.js';
import { createApp } from './app.js';
import { log } from './logger.js';

async function main() {
  const config = await loadConfig();
  const { auth, db } = initFirebase(config);
  const store = createStore(db);
  const gemini = createGemini({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    backend: config.geminiBackend,
    projectId: config.projectId,
    location: config.vertexLocation,
  });
  const geocode = createGeocoder({ apiKey: config.mapsApiKey });
  const notifier = createNotifier({ appUrl: process.env.APP_URL || '' });
  const app = createApp({ config, auth, store, gemini, geocode, notifier });

  const server = app.listen(config.port, () => {
    log.info('Secure Personal Gemini Journal listening', {
      port: config.port,
      project: config.projectId,
      backend: config.geminiBackend,
      model: config.geminiModel,
      maps: geocode.enabled,
      revision: process.env.K_REVISION || 'local',
    });
  });

  // Cloud Run sends SIGTERM before shutting an instance down.
  const shutdown = (signal) => {
    log.info('Shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('Startup failed', { reason: err.message });
  process.exit(1);
});
