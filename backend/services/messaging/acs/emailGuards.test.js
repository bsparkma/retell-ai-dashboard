'use strict';

/**
 * Structural guards for item 40 (ACS email), by source scan:
 *
 *   1. The public unsubscribe router SENDS NOTHING and never reads an office
 *      or an address from the request: the token is its only input.
 *   2. Its GET handler writes nothing (link scanners must not unsubscribe).
 *   3. The only caller of the ACS client's send is the email adapter.
 *   4. No log line in the email files carries a token, an address or a body.
 *   5. ACS only: no other email provider is wired anywhere in the backend.
 *   6. The unsubscribe token hash never leaves the database (not in the
 *      message columns the API returns).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

const ROUTER = read('routes/emailWebhooks.js');

test('the unsubscribe router never sends and takes nothing but the token', () => {
  assert.doesNotMatch(ROUTER, /sendMessage\(|sendEmail|emailAdapter|getAdapter|acs\/client/);
  assert.doesNotMatch(ROUTER, /req\.(body|query)\.(office|email|address|to)/);
  assert.doesNotMatch(ROUTER, /req\.params/);
});

test('GET /unsubscribe writes nothing and opens no tenant', () => {
  const start = ROUTER.indexOf("router.get('/unsubscribe'");
  const end = ROUTER.indexOf("router.post('/unsubscribe'");
  assert.ok(start !== -1 && end > start);
  const getHandler = ROUTER.slice(start, end);
  assert.doesNotMatch(getHandler, /recordUnsubscribeLink|attachTenant|withTenantDb|messaging\./);
});

test('the only caller of the ACS send is the email adapter', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js') && /\bsendEmail\(/.test(fs.readFileSync(p, 'utf8'))) {
        callers.push(path.relative(BACKEND, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(BACKEND);
  assert.deepEqual(callers.sort(), ['services/messaging/acs/client.js', 'services/messaging/adapters/emailAdapter.js']);
});

test('no log line carries a token, an address or a body', () => {
  for (const rel of [
    'routes/emailWebhooks.js',
    'services/messaging/acs/client.js',
    'services/messaging/adapters/emailAdapter.js',
    'services/messaging/emailContent.js',
    'config/acsEmail.js',
  ]) {
    const logs = read(rel).match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [];
    for (const line of logs) {
      assert.doesNotMatch(line, /token|tokenOf|toAddress|to_address|address\b|\bbody\b|html|subject|req\.body|req\.query/i, `${rel}: ${line}`);
    }
  }
});

test('ACS only: no other email provider is wired in the backend', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (/require\(['"](resend|@sendgrid\/mail|nodemailer|mailgun|postmark)/.test(src) || /api\.resend\.com|api\.sendgrid\.com/.test(src)) {
          offenders.push(path.relative(BACKEND, p));
        }
      }
    }
  };
  walk(BACKEND);
  assert.deepEqual(offenders, []);
  const pkg = JSON.parse(read('package.json'));
  for (const dep of ['resend', '@sendgrid/mail', 'nodemailer']) {
    assert.ok(!(pkg.dependencies && pkg.dependencies[dep]), dep);
  }
});

test('the unsubscribe token hash is not an API column', () => {
  const messaging = require('../index');
  assert.ok(!messaging.MESSAGE_COLS.includes('unsubscribe_token_hash'));
});
