'use strict';

/**
 * /api/webhooks/twilio — the inbound and status webhooks (queue item 39), end
 * to end over a real HTTP server: the real body parsers (with raw capture, as
 * server.js mounts them), the real router, the real messaging service, and the
 * real /api/tc stack beside it — over FakeTenantDb, with the registry stubbed
 * and a FAKE Twilio transport. No network.
 *
 * Fixtures: roland 12827 / 12828, valley 7115. Names synthetic; phones are
 * fictional 555-01xx numbers.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const { tenantContext, requireModule } = require('../middleware/tenantContext');
const { FakeTenantDb } = require('./tc/tcTestUtils');
const messaging = require('../services/messaging');
const consent = require('../services/messaging/consent');
const adapters = require('../services/messaging/adapters');
const client = require('../services/messaging/twilio/client');
const { computeSignature } = require('../services/messaging/twilio/signature');
const tcSms = require('../config/tcSms');

const BASE = 'https://dashboard.example.test';
const TOKEN = 'test-auth-token-not-real';
const ROLAND_NUMBER = '+14795550150';
const VALLEY_NUMBER = '+14795550160';
const PATIENT = '+14795550101';
const DAY = new Date('2026-10-08T17:00:00Z'); // 12:00 CDT

const ENV = {
  TC_SMS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'ACtest0000',
  TWILIO_API_KEY_SID: 'SKtest0000',
  TWILIO_API_KEY_SECRET: 'not-a-real-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGtest0000',
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_WEBHOOK_BASE_URL: BASE,
  TWILIO_TENANT_SLUG: 'carein',
  TWILIO_FROM_ROLAND: ROLAND_NUMBER,
  TWILIO_FROM_VALLEY: VALLEY_NUMBER,
};
const SAVED_ENV = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantBySlug',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'getPlatformSetting',
  'touchUserLogin',
];

/**
 * Boot: Twilio router first (exactly as server.js orders it), then the signed-in
 * TC stack for the same tenant DB.
 * @param {{ env?: Record<string, string|undefined>, modules?: string[], tenant?: object|null }} [opts]
 */
async function boot({ env = {}, modules = ['tc'], tenant } = {}) {
  for (const k of Object.keys(ENV)) delete process.env[k];
  Object.assign(process.env, ENV);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const db = new FakeTenantDb();
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
  };
  const tenantRow =
    tenant === undefined ? { tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' } : tenant;
  const seenTenantIds = [];
  registry.getUserByEmail = async (email) => ({ user_id: 'U1', tenant_id: 'T1', email, role: 'admin', status: 'active' });
  registry.getTenantById = async () => tenantRow;
  registry.getTenantBySlug = async (slug) => (tenantRow && slug === tenantRow.slug ? tenantRow : null);
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;
  registry.getPlatformAdminByEmail = async () => null;
  registry.getPlatformSetting = async () => null; // kill switch: env fallback answers
  registry.touchUserLogin = async () => {};
  userContext.clearCache();
  tenantDb.withTenantDb = async (req, fn) => {
    seenTenantIds.push(req && req.tenant && req.tenant.id);
    if (!req || !req.tenant || !req.tenant.id) throw new Error('no tenant');
    return fn(db);
  };
  tcSms.resetCacheForTests();
  messaging.setClockForTests(() => DAY);
  consent.setOdPatientReaderForTests(async (_office, patNum) => ({ PatNum: patNum, TxtMsgOk: 'Yes' }));

  const twilioCalls = [];
  let nextSid = 1;
  client.setFetchForTests(async (url, init) => {
    assert.ok(String(url).startsWith('https://api.twilio.com/'), `unexpected URL ${url}`);
    const form = new URLSearchParams(String(init.body));
    twilioCalls.push(form);
    return new Response(JSON.stringify({ sid: `SMfake${String(nextSid++).padStart(4, '0')}`, status: 'queued' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const app = express();
  // The SAME parser shape as server.js: raw capture on both.
  app.use(express.json({ verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf.toString('utf8'); } }));
  app.use(express.urlencoded({ extended: true, verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf.toString('utf8'); } }));
  app.use('/api/webhooks/twilio', require('./twilioWebhooks'));
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'tc@carein.ai', name: 'TC User', tenantId: 'x' };
    next();
  });
  app.use('/api', tenantContext());
  app.use('/api/tc', requireModule('tc'), require('./tc'));

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        twilioCalls,
        seenTenantIds,
        close: () =>
          new Promise((r) => {
            for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
            tenantDb.withTenantDb = originals.withTenantDb;
            server.close(r);
          }),
      });
    });
  });
}

test.afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  messaging.resetClock();
  consent.resetOdPatientReader();
  adapters.resetAdapters();
  client.resetFetch();
  tcSms.resetCacheForTests();
});

/**
 * POST a form to a webhook path, signed the way Twilio signs it (over the
 * PUBLIC URL), unless `signature` overrides it.
 */
async function postTwilio(baseUrl, path, params, { signature, token = TOKEN, signedPath = path } = {}) {
  const body = new URLSearchParams(params).toString();
  const pairs = Array.from(new URLSearchParams(params).entries());
  const sig = signature === undefined ? computeSignature(token, BASE + signedPath, pairs) : signature;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sig !== null) headers['X-Twilio-Signature'] = sig;
  const res = await fetch(baseUrl + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '' };
}

function inbound(overrides = {}) {
  return {
    AccountSid: 'ACtest0000',
    MessageSid: `SMin${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    From: PATIENT,
    To: ROLAND_NUMBER,
    Body: 'Thanks, what time works?',
    NumMedia: '0',
    ...overrides,
  };
}

function seedCase(db, overrides = {}) {
  const row = {
    case_id: crypto.randomUUID(),
    office_id: 'roland',
    patient_name: 'MangoTest Test',
    phone: '(479) 555-0101',
    email: null,
    od_patient_id: 12828,
    status: 'presented',
    ...overrides,
  };
  db.table('tc_cases').push(row);
  return row;
}

async function apiJson(baseUrl, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── signature: both directions, before any body processing ─────────────────

test('signature VALID → 200 empty TwiML, message recorded', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound());
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/xml/);
    assert.equal(r.text, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    assert.equal(db.table('tc_messages').length, 1);
  } finally {
    await close();
  }
});

test('signature INVALID / MISSING / wrong token / tampered body → 403, NOTHING touched', async () => {
  const { baseUrl, db, seenTenantIds, close } = await boot();
  try {
    const params = inbound({ Body: 'STOP' });
    const cases = [
      { signature: null },
      { signature: '' },
      { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      { token: 'some-other-token' },
      // Signed over the internal URL a naive Host-header rebuild would use.
      { signedPath: '/api/webhooks/twilio/inbound?x=1' },
    ];
    for (const opts of cases) {
      const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', params, opts);
      assert.equal(r.status, 403, JSON.stringify(opts));
      assert.equal(JSON.parse(r.text).code, 'TWILIO_SIGNATURE_INVALID');
    }
    // Tampered: valid signature for one body, a different body sent.
    const sig = computeSignature(TOKEN, BASE + '/api/webhooks/twilio/inbound', Object.entries(params));
    const res = await fetch(baseUrl + '/api/webhooks/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
      body: new URLSearchParams({ ...params, From: '+14795550199' }).toString(),
    });
    assert.equal(res.status, 403);

    assert.equal(db.log.length, 0, 'no query ran');
    assert.equal(db.table('tc_messages').length, 0);
    assert.equal(db.table('tc_contact_consent').length, 0, 'an unsigned STOP records nothing');
    assert.deepEqual(seenTenantIds, [], 'no tenant DB was even opened');
  } finally {
    await close();
  }
});

test('no auth token / no base URL configured → every webhook refused (fail closed)', async () => {
  for (const env of [{ TWILIO_AUTH_TOKEN: undefined }, { TWILIO_WEBHOOK_BASE_URL: undefined }]) {
    const { baseUrl, db, close } = await boot({ env });
    try {
      const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound());
      assert.equal(r.status, 403, JSON.stringify(env));
      assert.equal(db.table('tc_messages').length, 0);
    } finally {
      await close();
    }
  }
});

test('a signed event from a DIFFERENT account is refused', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ AccountSid: 'ACsomeoneelse' }));
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.text).code, 'TWILIO_ACCOUNT_MISMATCH');
    assert.equal(db.table('tc_messages').length, 0);
  } finally {
    await close();
  }
});

// ── tenant: from the registry, never guessed ────────────────────────────────

test('tenant unresolved (no slug / unknown slug / suspended) → 503, nothing recorded', async () => {
  for (const opts of [
    { env: { TWILIO_TENANT_SLUG: undefined } },
    { env: { TWILIO_TENANT_SLUG: 'nobody' } },
    { tenant: { tenant_id: 'T1', slug: 'carein', status: 'suspended' } },
  ]) {
    const { baseUrl, db, close } = await boot(opts);
    try {
      const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound());
      assert.equal(r.status, 503, JSON.stringify(opts));
      assert.equal(JSON.parse(r.text).code, 'TWILIO_TENANT_UNRESOLVED');
      assert.equal(db.table('tc_messages').length, 0);
    } finally {
      await close();
    }
  }
});

test('tenant not entitled to tc → 403 MODULE_NOT_ENTITLED, nothing recorded', async () => {
  const { baseUrl, db, close } = await boot({ modules: ['voice'] });
  try {
    const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound());
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.text).error, 'MODULE_NOT_ENTITLED');
    assert.equal(db.table('tc_messages').length, 0);
  } finally {
    await close();
  }
});

test('the webhook writes under the REGISTRY tenant id and the system actor', async () => {
  const { baseUrl, db, seenTenantIds, close } = await boot();
  try {
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound());
    assert.ok(seenTenantIds.length > 0 && seenTenantIds.every((t) => t === 'T1'));
    const created = db.table('audit_log').find((r) => r.resource_type === 'tc_message' && r.action === 'CREATE');
    assert.equal(created.user_id, 'system:twilio');
    assert.equal(created.office, 'roland');
  } finally {
    await close();
  }
});

// ── inbound: office from the RECEIVING number ──────────────────────────────

test('office derives from the To: roland number → roland, valley number → valley', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ To: ROLAND_NUMBER }));
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ To: VALLEY_NUMBER }));
    const rows = db.table('tc_messages');
    assert.deepEqual(rows.map((r) => r.office_id), ['roland', 'valley']);
    for (const r of rows) {
      assert.equal(r.direction, 'inbound');
      assert.equal(r.status, 'received');
      assert.equal(r.from_address, PATIENT);
      assert.equal(r.provider, 'twilio');
    }
    assert.equal(rows[1].to_address, VALLEY_NUMBER);
  } finally {
    await close();
  }
});

test('UNKNOWN receiving number → 200 empty TwiML (no Twilio retry), NOTHING recorded, no tenant opened', async () => {
  const { baseUrl, db, seenTenantIds, close } = await boot();
  try {
    const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ To: '+14795550199', Body: 'STOP' }));
    assert.equal(r.status, 200);
    assert.match(r.text, /<Response><\/Response>/);
    assert.equal(db.table('tc_messages').length, 0);
    assert.equal(db.table('tc_contact_consent').length, 0);
    assert.deepEqual(seenTenantIds, []);
  } finally {
    await close();
  }
});

test('only ONE office configured: the unconfigured office’s number is unknown, never mapped to the other', async () => {
  const { baseUrl, db, close } = await boot({ env: { TWILIO_FROM_VALLEY: undefined } });
  try {
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ To: VALLEY_NUMBER }));
    assert.equal(db.table('tc_messages').length, 0);
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ To: ROLAND_NUMBER }));
    assert.equal(db.table('tc_messages').length, 1);
  } finally {
    await close();
  }
});

test('E.164 normalization: a 10-digit To/From still matches', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ To: '4795550150', From: '479-555-0101' }));
    const [row] = db.table('tc_messages');
    assert.equal(row.office_id, 'roland');
    assert.equal(row.from_address, PATIENT);
  } finally {
    await close();
  }
});

test('an unusable sender (short code) is dropped with 200, nothing recorded', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ From: '72345' }));
    assert.equal(r.status, 200);
    assert.equal(db.table('tc_messages').length, 0);
  } finally {
    await close();
  }
});

// ── inbound: linking to the ONE open case ──────────────────────────────────

test('links to the one OPEN case in that office whose phone matches', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    seedCase(db, { status: 'completed' }); // terminal: not a candidate
    seedCase(db, { office_id: 'valley', od_patient_id: 7115 }); // other office: never a candidate
    seedCase(db, { phone: '(479) 555-0102', od_patient_id: 12827 }); // different number
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound());
    const [row] = db.table('tc_messages');
    assert.equal(row.case_id, c.case_id);
  } finally {
    await close();
  }
});

test('AMBIGUOUS (two open cases share the number) → unlinked; ambiguity is a refusal', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    seedCase(db);
    seedCase(db, { status: 'nurture' });
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound());
    assert.equal(db.table('tc_messages')[0].case_id, null);
  } finally {
    await close();
  }
});

test('no match → unlinked, visible in the inbox; a valley case with the number does not link a roland text', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    seedCase(db, { office_id: 'valley', od_patient_id: 7115 });
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ To: ROLAND_NUMBER }));
    assert.equal(db.table('tc_messages')[0].case_id, null);
    const inbox = await apiJson(baseUrl, 'GET', '/api/tc/messages/inbox?office=roland');
    assert.equal(inbox.body.messages.length, 1);
    const valleyInbox = await apiJson(baseUrl, 'GET', '/api/tc/messages/inbox?office=valley');
    assert.equal(valleyInbox.body.messages.length, 0);
  } finally {
    await close();
  }
});

test('a linked inbound appears in the case thread', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'Can I come Tuesday?' }));
    const thread = await apiJson(baseUrl, 'GET', `/api/tc/messages?office=roland&caseId=${c.case_id}`);
    assert.equal(thread.status, 200);
    assert.equal(thread.body.messages.length, 1);
    assert.equal(thread.body.messages[0].direction, 'inbound');
    assert.equal(thread.body.messages[0].body, 'Can I come Tuesday?');
  } finally {
    await close();
  }
});

test('MMS: attachments are never fetched; the body says one was sent', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/x' }));
    assert.match(db.table('tc_messages')[0].body, /picture or file/);
  } finally {
    await close();
  }
});

test('a re-delivered webhook (same MessageSid) is stored ONCE', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const p = inbound();
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', p);
    const again = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', p);
    assert.equal(again.status, 200);
    assert.equal(db.table('tc_messages').length, 1);
    assert.equal(db.table('audit_log').filter((r) => r.resource_type === 'tc_message' && r.action === 'CREATE').length, 1);
  } finally {
    await close();
  }
});

// ── STOP / START / HELP ─────────────────────────────────────────────────────

test('STOP records consent (stop_keyword), and the consent gate then blocks the next send', async () => {
  const { baseUrl, db, twilioCalls, close } = await boot();
  try {
    const c = seedCase(db);
    const d = await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', {
      caseId: c.case_id,
      channel: 'sms',
      body: 'Following up on your visit.',
    });
    assert.equal(d.status, 201);

    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'stop' }));
    const [consentRow] = db.table('tc_contact_consent');
    assert.equal(consentRow.state, 'opted_out');
    assert.equal(consentRow.source, 'stop_keyword');
    assert.equal(consentRow.office_id, 'roland');
    assert.equal(consentRow.address, PATIENT);

    const send = await apiJson(baseUrl, 'POST', `/api/tc/messages/${d.body.message.messageId}/send?office=roland`, {});
    assert.equal(send.status, 403);
    assert.equal(send.body.code, 'CONSENT_OPTED_OUT');
    assert.equal(twilioCalls.length, 0, 'Twilio was never called');
    assert.equal(db.table('tc_messages').find((r) => r.message_id === d.body.message.messageId).status, 'draft');
  } finally {
    await close();
  }
});

test('STOP at roland does not opt the number out at valley (consent is per office)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'STOP', To: ROLAND_NUMBER }));
    const rows = db.table('tc_contact_consent');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].office_id, 'roland');
  } finally {
    await close();
  }
});

test('START / UNSTOP after STOP: recorded and audited, consent is NOT flipped back (unruled)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'STOP' }));
    for (const word of ['START', 'unstop']) {
      await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: word }));
    }
    const rows = db.table('tc_contact_consent');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'opted_out');
    assert.equal(db.table('tc_messages').length, 3, 'every keyword text is still in the record');
    assert.equal(
      db.table('audit_log').filter((r) => r.resource_type === 'tc_message.inbound_keyword.start').length,
      2
    );
  } finally {
    await close();
  }
});

test('HELP is recorded, audited, and changes nothing; no auto-reply body in the TwiML', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const r = await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'HELP' }));
    assert.equal(r.text, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    assert.equal(db.table('tc_contact_consent').length, 0);
    assert.ok(db.table('audit_log').some((a) => a.resource_type === 'tc_message.inbound_keyword.help'));
  } finally {
    await close();
  }
});

// ── outbound + status callbacks ─────────────────────────────────────────────

async function sendOne(baseUrl, db, office = 'roland') {
  const c = seedCase(db, office === 'valley' ? { office_id: 'valley', od_patient_id: 7115 } : {});
  const d = await apiJson(baseUrl, 'POST', `/api/tc/messages/draft?office=${office}`, {
    caseId: c.case_id,
    channel: 'sms',
    body: 'Hi, this is the office following up on your recent visit.',
  });
  const s = await apiJson(baseUrl, 'POST', `/api/tc/messages/${d.body.message.messageId}/send?office=${office}`, {});
  return { c, d: d.body.message, s };
}

function rowById(db, id) {
  return db.table('tc_messages').find((r) => r.message_id === id);
}

test('Send (roland): one Twilio call with roland’s From; row queued with Twilio’s SID; readiness says connected', async () => {
  const { baseUrl, db, twilioCalls, close } = await boot();
  try {
    const { c, d, s } = await sendOne(baseUrl, db);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.message.status, 'queued');
    assert.equal(s.body.message.provider, 'twilio');
    assert.equal(s.body.message.providerMessageId, 'SMfake0001');
    assert.equal(s.body.message.fromAddress, ROLAND_NUMBER);
    assert.equal(twilioCalls.length, 1);
    assert.equal(twilioCalls[0].get('From'), ROLAND_NUMBER);
    assert.equal(twilioCalls[0].get('To'), PATIENT);
    assert.equal(twilioCalls[0].get('StatusCallback'), `${BASE}/api/webhooks/twilio/status/roland`);
    assert.equal(rowById(db, d.messageId).status, 'queued');

    const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=roland&caseId=${c.case_id}`);
    const smsReady = ready.body.channels.find((x) => x.channel === 'sms');
    assert.equal(smsReady.adapterEnabled, true);
    assert.equal(smsReady.adapterReason, null);
  } finally {
    await close();
  }
});

test('per-office fail closed: only roland configured → valley send is 501 FEATURE_DISABLED, draft stays, Twilio never called', async () => {
  const { baseUrl, db, twilioCalls, close } = await boot({ env: { TWILIO_FROM_VALLEY: undefined } });
  try {
    const { c, d, s } = await sendOne(baseUrl, db, 'valley');
    assert.equal(s.status, 501);
    assert.equal(s.body.code, 'FEATURE_DISABLED');
    assert.equal(s.body.reason, 'office_not_configured');
    assert.equal(rowById(db, d.messageId).status, 'draft');
    assert.equal(twilioCalls.length, 0);

    const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=valley&caseId=${c.case_id}`);
    const smsReady = ready.body.channels.find((x) => x.channel === 'sms');
    assert.equal(smsReady.adapterEnabled, false);
    assert.equal(smsReady.adapterReason, 'office_not_configured');

    // …while roland, configured, sends.
    const roland = await sendOne(baseUrl, db, 'roland');
    assert.equal(roland.s.status, 200);
    assert.equal(twilioCalls.length, 1);
    assert.equal(twilioCalls[0].get('From'), ROLAND_NUMBER);
  } finally {
    await close();
  }
});

test('kill switch off → 501 switched_off, draft stays; readiness says switched_off', async () => {
  const { baseUrl, db, twilioCalls, close } = await boot({ env: { TC_SMS_ENABLED: 'false' } });
  try {
    const { c, d, s } = await sendOne(baseUrl, db);
    assert.equal(s.status, 501);
    assert.equal(s.body.reason, 'switched_off');
    assert.equal(rowById(db, d.messageId).status, 'draft');
    assert.equal(twilioCalls.length, 0);
    const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=roland&caseId=${c.case_id}`);
    assert.equal(ready.body.channels.find((x) => x.channel === 'sms').adapterReason, 'switched_off');
  } finally {
    await close();
  }
});

async function status(baseUrl, office, sid, messageStatus, extra = {}) {
  return postTwilio(baseUrl, `/api/webhooks/twilio/status/${office}`, {
    AccountSid: 'ACtest0000',
    MessageSid: sid,
    MessageStatus: messageStatus,
    ...extra,
  });
}

test('status: queued → sent → delivered, each applied once and audited', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    assert.equal((await status(baseUrl, 'roland', 'SMfake0001', 'sent')).status, 200);
    assert.equal(rowById(db, d.messageId).status, 'sent');
    await status(baseUrl, 'roland', 'SMfake0001', 'delivered');
    assert.equal(rowById(db, d.messageId).status, 'delivered');
    const types = db.table('audit_log').map((r) => r.resource_type).filter((t) => t.startsWith('tc_message.status.'));
    assert.deepEqual(types, ['tc_message.status.sent', 'tc_message.status.delivered']);
  } finally {
    await close();
  }
});

test('status: idempotent — the same report twice changes nothing the second time', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    await status(baseUrl, 'roland', 'SMfake0001', 'delivered');
    await status(baseUrl, 'roland', 'SMfake0001', 'delivered');
    assert.equal(rowById(db, d.messageId).status, 'delivered');
    assert.equal(db.table('audit_log').filter((r) => r.resource_type === 'tc_message.status.delivered').length, 1);
  } finally {
    await close();
  }
});

test('status: out of order — delivered is never regressed by a late sent / failed / queued', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    await status(baseUrl, 'roland', 'SMfake0001', 'delivered');
    for (const late of ['sent', 'undelivered', 'failed', 'queued', 'sending']) {
      await status(baseUrl, 'roland', 'SMfake0001', late, late === 'undelivered' ? { ErrorCode: '30003' } : {});
      assert.equal(rowById(db, d.messageId).status, 'delivered', late);
    }
    assert.equal(rowById(db, d.messageId).error ?? null, null);
  } finally {
    await close();
  }
});

test('status: undelivered after sent shows failed with the code as text; a late delivered then wins', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    await status(baseUrl, 'roland', 'SMfake0001', 'sent');
    await status(baseUrl, 'roland', 'SMfake0001', 'undelivered', { ErrorCode: '30006' });
    const failed = rowById(db, d.messageId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Not delivered (Twilio error 30006: the number is a landline or cannot receive texts).');
    // A second failure with another code does not overwrite the first reason.
    await status(baseUrl, 'roland', 'SMfake0001', 'failed', { ErrorCode: '30008' });
    assert.match(rowById(db, d.messageId).error, /30006/);
    // A carrier delivery receipt is proof: it wins over failed and clears the error.
    await status(baseUrl, 'roland', 'SMfake0001', 'delivered');
    assert.equal(rowById(db, d.messageId).status, 'delivered');
    assert.equal(rowById(db, d.messageId).error, null);
  } finally {
    await close();
  }
});

test('status: another office’s callback path cannot touch this message; unknown office → 404; unknown sid → 200 no-op', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    await status(baseUrl, 'valley', 'SMfake0001', 'delivered');
    assert.equal(rowById(db, d.messageId).status, 'queued');
    assert.equal((await status(baseUrl, 'riley', 'SMfake0001', 'delivered')).status, 404);
    assert.equal((await status(baseUrl, 'roland', 'SMnope', 'delivered')).status, 200);
    assert.equal(rowById(db, d.messageId).status, 'queued');
  } finally {
    await close();
  }
});

test('status: never touches a draft, a sending row, or an inbound row', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const now = new Date();
    for (const [status_, direction] of [['draft', 'outbound'], ['sending', 'outbound'], ['received', 'inbound']]) {
      db.table('tc_messages').push({
        message_id: crypto.randomUUID(),
        office_id: 'roland',
        case_id: null,
        direction,
        channel: 'sms',
        status: status_,
        provider: 'twilio',
        provider_message_id: `SM${status_}`,
        body: '',
        created_at: now,
      });
      await status(baseUrl, 'roland', `SM${status_}`, 'delivered');
      assert.equal(db.table('tc_messages').find((r) => r.provider_message_id === `SM${status_}`).status, status_);
    }
  } finally {
    await close();
  }
});

test('status: an unsigned callback cannot mark a message delivered', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    const r = await postTwilio(
      baseUrl,
      '/api/webhooks/twilio/status/roland',
      { AccountSid: 'ACtest0000', MessageSid: 'SMfake0001', MessageStatus: 'delivered' },
      { signature: null }
    );
    assert.equal(r.status, 403);
    assert.equal(rowById(db, d.messageId).status, 'queued');
  } finally {
    await close();
  }
});

// ── the "new texts" badge ───────────────────────────────────────────────────

test('unseen count: inbound only, per office; opening a case marks its texts seen; inbox mark-all', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'one' })); // linked
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'two', From: '+14795550109' })); // unlinked
    await postTwilio(baseUrl, '/api/webhooks/twilio/inbound', inbound({ Body: 'three', To: VALLEY_NUMBER })); // valley
    await sendOne(baseUrl, db); // an outbound never counts

    const count = async (office) => (await apiJson(baseUrl, 'GET', `/api/tc/messages/unseen-count?office=${office}`)).body;
    assert.deepEqual(await count('roland'), { success: true, count: 2, capped: false });
    assert.equal((await count('valley')).count, 1);

    const onCases = await apiJson(baseUrl, 'GET', '/api/tc/messages/unseen?office=roland');
    assert.equal(onCases.body.messages.length, 1);
    assert.equal(onCases.body.messages[0].caseId, c.case_id);

    const seen = await apiJson(baseUrl, 'POST', '/api/tc/messages/seen?office=roland', { caseId: c.case_id });
    assert.deepEqual(seen.body, { success: true, marked: 1 });
    assert.equal((await count('roland')).count, 1);
    const seenRow = db.table('tc_messages').find((r) => r.body === 'one');
    assert.equal(seenRow.seen_by, 'tc@carein.ai');

    const inboxSeen = await apiJson(baseUrl, 'POST', '/api/tc/messages/seen?office=roland', { caseId: null });
    assert.equal(inboxSeen.body.marked, 1);
    assert.equal((await count('roland')).count, 0);
    assert.equal((await count('valley')).count, 1, 'another office is untouched');

    // Strict body.
    const bad = await apiJson(baseUrl, 'POST', '/api/tc/messages/seen?office=roland', { caseId: c.case_id, all: true });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});
