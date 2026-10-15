'use strict';

/**
 * Structural guards for item 48 (ACS SMS), by source scan:
 *
 *   1. The Event Grid webhook SENDS NOTHING: it never names the ACS send call,
 *      the approval-click function, an adapter, or a client.
 *   2. Token first: the shared-secret middleware is the router's ONLY
 *      router.use and is registered before every route handler.
 *   3. Inbound ignores the kill switch: the webhook never reads tc_sms_enabled
 *      (a STOP must land while texting is switched off).
 *   4. No PHI in logs: no console line in the ACS SMS files interpolates a
 *      number or a body field.
 *   5. The only caller of the ACS send call is the ACS SMS adapter.
 *   6. The Twilio adapter knows nothing of the provider switch — selection
 *      lives in adapters/index.js, so the Twilio module stays as #230 left it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

const ROUTER = read('routes/acsSmsWebhooks.js');

test('the ACS webhook router never sends', () => {
  assert.doesNotMatch(
    ROUTER,
    /sendSms|sendMessage\(|acsSmsAdapter|smsAdapter|adapters?\.send|getAdapter|acs\/smsClient|twilio\/client|createMessage/
  );
});

test('the token check is the only router.use and precedes every route handler', () => {
  const use = ROUTER.indexOf('router.use(');
  const firstRoute = Math.min(
    ...['router.post(', 'router.get(', 'router.put(', 'router.all(', 'router.options('].map((s) => {
      const i = ROUTER.indexOf(s);
      return i === -1 ? Infinity : i;
    })
  );
  assert.ok(use !== -1 && use < firstRoute, 'router.use(token) must precede the first route');
  assert.match(ROUTER.slice(use, firstRoute), /tokenMatches\(/);
  assert.match(ROUTER.slice(use, firstRoute), /timingSafeEqual|tokenMatches/);
  assert.equal((ROUTER.match(/router\.use\(/g) || []).length, 1);
  // The query string is never consulted for the secret.
  assert.doesNotMatch(ROUTER, /req\.query/);
});

test('the webhook never consults the texting kill switch (STOP must always land)', () => {
  assert.doesNotMatch(ROUTER, /tcSms\b|smsEnabled|tc_sms_enabled'/);
  assert.doesNotMatch(ROUTER, /require\('\.\.\/config\/tcSms'\)/);
});

test('no log line carries a phone number or a message body', () => {
  const files = [
    'routes/acsSmsWebhooks.js',
    'services/messaging/acs/smsClient.js',
    'services/messaging/acs/smsStatus.js',
    'services/messaging/adapters/acsSmsAdapter.js',
    'config/acsSms.js',
    'config/tcSmsProvider.js',
  ];
  for (const rel of files) {
    const src = read(rel);
    const logs = src.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [];
    for (const line of logs) {
      assert.doesNotMatch(
        line,
        // `err.message` is an error sentence, not a patient's message, so only
        // the EVENT's fields (data.from / data.to / data.message) are forbidden.
        /\.from\b|\.to\b|data\.(from|to|message)|\bw\.data\b|fromAddress|toAddress|\bbody\b/,
        `${rel}: ${line}`
      );
    }
  }
});

test('the only caller of the ACS SMS send call is the ACS SMS adapter', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js') && /\bsendSms\(/.test(fs.readFileSync(p, 'utf8'))) {
        callers.push(path.relative(BACKEND, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(BACKEND);
  assert.deepEqual(callers.sort(), ['services/messaging/acs/smsClient.js', 'services/messaging/adapters/acsSmsAdapter.js']);
});

test('the Twilio adapter is not where selection happens (it never reads TC_SMS_PROVIDER)', () => {
  const twilio = read('services/messaging/adapters/smsAdapter.js');
  assert.doesNotMatch(twilio, /tcSmsProvider|TC_SMS_PROVIDER|acs/i);
  assert.match(twilio, /provider: 'twilio'/);
  const registry = read('services/messaging/adapters/index.js');
  assert.match(registry, /function selectedSmsAdapter\(/);
});
