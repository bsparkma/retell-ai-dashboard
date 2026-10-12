'use strict';

/**
 * Structural guards for item 39, by source scan:
 *
 *   1. The webhook router SENDS NOTHING: it never names the Twilio create call
 *      or the approval-click function. A reply to STOP/HELP is Twilio Advanced
 *      Opt-Out's job.
 *   2. Signature first: the router's signature middleware is registered before
 *      any route handler, so no handler can run on an unverified body.
 *   3. No PHI in logs: no console line in the router or the Twilio files
 *      interpolates a phone number or a body field.
 *   4. The only caller of client.createMessage is the SMS adapter.
 *   5. Minimum necessary: no template carries clinical detail.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

const ROUTER = read('routes/twilioWebhooks.js');

test('the webhook router never sends', () => {
  assert.doesNotMatch(ROUTER, /createMessage|sendMessage\(|smsAdapter|adapters?\.send|getAdapter|twilio\/client/);
});

test('signature validation is registered before every route handler', () => {
  const use = ROUTER.indexOf('router.use(');
  const firstRoute = Math.min(
    ...['router.post(', 'router.get(', 'router.put(', 'router.all('].map((s) => {
      const i = ROUTER.indexOf(s);
      return i === -1 ? Infinity : i;
    })
  );
  assert.ok(use !== -1 && use < firstRoute, 'router.use(signature) must precede the first route');
  assert.match(ROUTER.slice(use, firstRoute), /isValidSignature/);
  // Exactly one router.use — nothing sneaks in ahead of it.
  assert.equal((ROUTER.match(/router\.use\(/g) || []).length, 1);
});

test('no log line carries a phone number or a message body', () => {
  const files = [
    'routes/twilioWebhooks.js',
    'services/messaging/twilio/client.js',
    'services/messaging/twilio/signature.js',
    'services/messaging/twilio/status.js',
    'services/messaging/adapters/smsAdapter.js',
  ];
  for (const rel of files) {
    const src = read(rel);
    const logs = src.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [];
    for (const line of logs) {
      assert.doesNotMatch(line, /\.(From|To|Body)\b|fromAddress|toAddress|\bbody\b|\bto\b\}|\bfrom\b\}/, `${rel}: ${line}`);
    }
  }
});

test('the only caller of the Twilio create call is the SMS adapter', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js') && /\bcreateMessage\(/.test(fs.readFileSync(p, 'utf8'))) {
        callers.push(path.relative(BACKEND, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(BACKEND);
  assert.deepEqual(callers.sort(), ['services/messaging/adapters/smsAdapter.js', 'services/messaging/twilio/client.js']);
});

test('templates are minimum-necessary: "treatment"/"visit" wording only, no clinical detail', () => {
  const { TEMPLATES } = require('../templates');
  const CLINICAL = /\b(crown|implant|root canal|extraction|filling|cavity|caries|periodont|gum disease|bridge|denture|veneer|x-?ray|diagnos|infection|decay|abscess|\bD\d{4}\b)/i;
  for (const t of Object.values(TEMPLATES)) {
    for (const text of [t.sms, t.email, t.emailSubject]) {
      assert.doesNotMatch(text, CLINICAL, `${t.key}: ${text}`);
    }
  }
});
