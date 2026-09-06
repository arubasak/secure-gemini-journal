import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWebhookUrl } from '../server/notify.js';
import { ValidationError } from '../server/validation.js';

test('accepts Slack and Discord https webhooks only', () => {
  const slack = validateWebhookUrl('https://hooks.slack.com/services/T000/B000/XXXXXXXX');
  assert.equal(slack.provider, 'slack');
  assert.equal(slack.host, 'hooks.slack.com');
  const discord = validateWebhookUrl('https://discord.com/api/webhooks/123456/abc_DEF-ghi');
  assert.equal(discord.provider, 'discord');
});

test('rejects SSRF-style and malformed URLs', () => {
  const bad = [
    'http://hooks.slack.com/services/T/B/X',              // not https
    'https://hooks.slack.com.evil.com/services/T/B/X',    // lookalike host
    'https://evil.com/api/webhooks/1/x',                   // unknown host
    'https://discord.com/api/other/1/x',                   // wrong path
    'https://user:pw@hooks.slack.com/services/T/B/X',      // credentials
    'https://hooks.slack.com:8443/services/T/B/X',         // port
    'https://169.254.169.254/computeMetadata/v1/',         // metadata server
    'https://discordapp.com/api/webhooks/1/x',             // legacy host redirects; not on the allow-list
    'https://hooks.slack.com/services//T/B',               // double slash / wrong shape
    'https://hooks.slack.com/services/T/B/X/extra',        // extra segment
    'not a url',
    42,
  ];
  for (const url of bad) assert.throws(() => validateWebhookUrl(url), ValidationError, String(url));
});

test('normalises a trailing-dot FQDN before matching (AI Studio review finding)', () => {
  const out = validateWebhookUrl('https://hooks.slack.com./services/T000/B000/abc123');
  assert.equal(out.host, 'hooks.slack.com');
  assert.equal(out.url, 'https://hooks.slack.com/services/T000/B000/abc123');
});
