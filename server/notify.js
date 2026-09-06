import { ValidationError } from './validation.js';
import { log } from './logger.js';

/**
 * External notifications (Slack / Discord incoming webhooks).
 *
 * Users register their own webhook URL. Because the server makes an outbound
 * request to a user-supplied URL, this is an SSRF vector - so the URL must be
 * https and the host must be on a strict allow-list. Messages never include
 * journal content: only a neutral nudge and a link back to the app.
 *
 * Hardened after review in the AI Studio security session against Addendum C:
 * discord.com only (the legacy discordapp.com host redirects, which we forbid),
 * exact Slack path shape, trailing-dot hostname normalisation, bounded
 * milestone count, and a low-mood message that carries crisis guidance and an
 * "AI, not a therapist" notice instead of an emotional judgement.
 */
const PROVIDERS = [
  // Slack incoming webhooks are exactly /services/T…/B…/token
  { name: 'slack', host: /^hooks\.slack\.com$/, path: /^\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/ },
  { name: 'discord', host: /^discord\.com$/, path: /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/ },
];

/** Returns { provider, url, host } or throws ValidationError. */
export function validateWebhookUrl(value) {
  if (typeof value !== 'string' || value.length > 400) throw new ValidationError('Webhook URL is invalid');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ValidationError('Webhook URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new ValidationError('Webhook URL must be a plain https URL');
  }
  // A trailing dot is a valid FQDN form ("hooks.slack.com.") that would slip past
  // an anchored regex in some runtimes; normalise before matching.
  url.hostname = url.hostname.replace(/\.$/, '');
  const provider = PROVIDERS.find((p) => p.host.test(url.hostname) && p.path.test(url.pathname));
  if (!provider) throw new ValidationError('Only Slack (hooks.slack.com) and Discord (discord.com/api/webhooks) webhooks are supported');
  return { provider: provider.name, url: url.toString(), host: url.hostname };
}

export function createNotifier({ appUrl = '' } = {}) {
  const NOTICE = 'Gemini Journal is an AI tool, not a therapist or crisis service. If you need support right now, contact local emergency services or a helpline (India: Tele-MANAS 14416; elsewhere findahelpline.com).';
  return {
    /** Sends a message. Never throws; returns true on success. */
    async send({ url, provider, text }) {
      try {
        const body = provider === 'discord' ? { content: text } : { text };
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
      } catch (err) {
        log.warn('Webhook delivery failed', { provider, reason: err.message });
        return false;
      }
    },

    /** Message builders - deliberately content-free and judgement-free. */
    messages: {
      test: () => `✅ Gemini Journal notifications are connected. ${appUrl}`.trim(),
      lowMood: () => `💜 A check-in is waiting for you in your journal whenever you are ready. ${NOTICE} ${appUrl}`.trim(),
      milestone: (n) => {
        const count = Number.isInteger(n) && n > 0 ? n : 0;
        return `🎉 That's ${count} journal entries. Consistency is the whole game - nice work. ${appUrl}`.trim();
      },
    },
  };
}
