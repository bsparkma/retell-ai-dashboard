'use strict';

/**
 * /api/webhooks/acs-sms — Event Grid delivery of ACS SMS events (queue item
 * 48), end to end over a real HTTP server: the real JSON parser (as server.js
 * mounts it), the real router, the real messaging service and the real /api/tc
 * stack beside it — over FakeTenantDb, with the registry stubbed and a FAKE
 * ACS transport. No network.
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
const acsClient = require('../services/messaging/acs/smsClient');
const twilioClient = require('../services/messaging/twilio/client');
const tcSms = require('../config/tcSms');

const TOKEN = 'acs-webhook-token-for-tests-0123456789abcdef';
const ROLAND_NUMBER = '+14795550150';
const VALLEY_NUMBER = '+14795550160';
const PATIENT = '+14795550101';
const DAY = new Date('2026-10-08T17:00:00Z'); // 12:00 CDT
const PATH = '/api/webhooks/acs-sms';

const ENV = {
  TC_SMS_ENABLED: 'true',
  TC_SMS_PROVIDER: undefined, // the default: acs
  TC_SMS_ACS_AUTH_MODE: 'managed_identity',
  TC_SMS_ACS_ENDPOINT: 'https://carein-test.communication.azure.com',
  TC_SMS_ACS_FROM_ROLAND: ROLAND_NUMBER,
  TC_SMS_ACS_FROM_VALLEY: VALLEY_NUMBER,
  TC_SMS_ACS_WEBHOOK_TOKEN: TOKEN,
  TC_SMS_ACS_TENANT_SLUG: 'carein',
  // A fully configured Twilio account is ALSO present, to prove it is never used.
  TWILIO_ACCOUNT_SID: 'ACtest0000',
  TWILIO_API_KEY_SID: 'SKtest0000',
  TWILIO_API_KEY_SECRET: 'not-a-real-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGtest0000',
  TWILIO_WEBHOOK_BASE_URL: 'https://dashboard.example.test',
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
 * @param {{ env?: Record<string, string|undefined>, modules?: string[], tenant?: object|null }} [opts]
 */
async function boot({ env = {}, modules = ['tc'], tenant } = {}) {
  for (const [k, v] of Object.entries({ ...ENV, ...env })) {
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

  const acsCalls = [];
  let nextId = 1;
  acsClient.setTokenProviderForTests(async () => 'fake-entra-token');
  acsClient.setFetchForTests(async (url, init) => {
    assert.ok(String(url).startsWith('https://carein-test.communication.azure.com/sms?'), `unexpected URL ${url}`);
    const body = JSON.parse(String(init.body));
    acsCalls.push({ url: String(url), headers: init.headers, body });
    return new Response(
      JSON.stringify({
        value: [
          {
            to: body.smsRecipients[0].to,
            messageId: `Outgoing_fake_${String(nextId++).padStart(4, '0')}`,
            httpStatusCode: 202,
            repeatabilityResult: 'accepted',
            successful: true,
          },
        ],
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
  });
  const twilioCalls = [];
  twilioClient.setFetchForTests(async (url) => {
    twilioCalls.push(String(url));
    throw new Error('Twilio must never be called under TC_SMS_PROVIDER=acs');
  });

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf.toString('utf8'); } }));
  app.use(PATH, require('./acsSmsWebhooks'));
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
        acsCalls,
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
  acsClient.resetForTests();
  twilioClient.resetFetch();
  tcSms.resetCacheForTests();
});

/** POST an Event Grid delivery (an array of events) with the token unless overridden. */
async function postEvents(baseUrl, events, { token = TOKEN, headers = {}, query = '' } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token !== null) h['X-CareIN-Webhook-Token'] = token;
  const res = await fetch(baseUrl + PATH + query, { method: 'POST', headers: h, body: JSON.stringify(events) });
  const text = await res.text();
  return { status: res.status, text, json: text ? safeJson(text) : null };
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** ACS SMSReceived, as Event Grid delivers it (numbers WITHOUT a leading + — ACS's own example). */
function received(over = {}) {
  const messageId = over.messageId || crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    topic: '/subscriptions/x/resourceGroups/rg/providers/microsoft.communication/communicationservices/carein-test',
    subject: '/phonenumber/14795550150',
    eventType: 'Microsoft.Communication.SMSReceived',
    dataVersion: '1.0',
    metadataVersion: '1',
    eventTime: '2026-10-08T17:00:00Z',
    data: {
      messageId,
      from: '14795550101',
      to: '14795550150',
      message: 'Thanks, what time works?',
      receivedTimestamp: '2026-10-08T17:00:00Z',
      segmentCount: 1,
      ...over,
    },
  };
}

/** ACS SMSDeliveryReportReceived for a text WE sent (from = our number). */
function deliveryReport(messageId, deliveryStatus, over = {}) {
  return {
    id: crypto.randomUUID(),
    topic: '/subscriptions/x/resourceGroups/rg/providers/microsoft.communication/communicationservices/carein-test',
    subject: '/phonenumber/14795550150',
    eventType: 'Microsoft.Communication.SMSDeliveryReportReceived',
    dataVersion: '1.0',
    metadataVersion: '1',
    eventTime: '2026-10-08T17:01:00Z',
    data: {
      messageId,
      from: ROLAND_NUMBER,
      to: PATIENT,
      deliveryStatus,
      deliveryStatusDetails: deliveryStatus === 'Delivered' ? 'No error.' : 'Unknown carrier error.',
      receivedTimestamp: '2026-10-08T17:01:00Z',
      deliveryAttempts: [{ timestamp: '2026-10-08T17:00:30Z', segmentsSucceeded: 1, segmentsFailed: 0 }],
      tag: 'roland',
      ...over,
    },
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

function seedEnrollment(db, tcCase, over = {}) {
  const row = {
    enrollment_id: crypto.randomUUID(),
    case_id: tcCase.case_id,
    office_id: tcCase.office_id,
    track_key: 'no_show_recovery',
    intensity_at_enroll: 'standard',
    status: 'active',
    stop_reason: null,
    next_touch_index: 1,
    next_touch_due_at: '2026-10-10T05:00:00.000Z',
    last_touch_at: '2026-10-07T10:00:00.000Z',
    created_by: 'tc@carein.ai',
    created_at: '2026-10-06T15:00:00.000Z',
    updated_at: '2026-10-07T10:00:00.000Z',
    ...over,
  };
  db.table('tc_nurture_enrollments').push(row);
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

// ── the Event Grid handshake ────────────────────────────────────────────────

test('handshake: with the token, answers { validationResponse } with Event Grid’s code and records nothing', async () => {
  const { baseUrl, db, seenTenantIds, close } = await boot();
  try {
    const r = await postEvents(baseUrl, [
      {
        id: crypto.randomUUID(),
        topic: '/subscriptions/x/resourceGroups/rg/providers/microsoft.communication/communicationservices/carein-test',
        subject: '',
        eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent',
        data: { validationCode: '512d38b6-c7b8-40c8-89fe-f46f9e9622b6', validationUrl: 'https://rp.example.test/validate' },
        eventTime: '2026-10-08T17:00:00Z',
        dataVersion: '2',
        metadataVersion: '1',
      },
    ]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { validationResponse: '512d38b6-c7b8-40c8-89fe-f46f9e9622b6' });
    assert.equal(db.log.length, 0);
    assert.deepEqual(seenTenantIds, [], 'the handshake opens no tenant');
  } finally {
    await close();
  }
});

test('handshake WITHOUT the token is refused 401 — the validation code is never echoed', async () => {
  const { baseUrl, close } = await boot();
  try {
    const r = await postEvents(
      baseUrl,
      [{ eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent', data: { validationCode: 'abc-123' } }],
      { token: null }
    );
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.text, /abc-123/);
  } finally {
    await close();
  }
});

// ── auth: unauthenticated = recorded NOWHERE ───────────────────────────────

test('missing / wrong / query-string / unconfigured token → 401, NOTHING recorded, no tenant opened', async () => {
  const stop = received({ message: 'STOP' });
  const cases = [
    { opts: { token: null } },
    { opts: { token: '' } },
    { opts: { token: 'wrong-token-wrong-token-wrong-token-xx' } },
    { opts: { token: TOKEN.slice(0, -1) } },
    { opts: { token: `${TOKEN}x` } },
    // The token in the query string is not accepted (it would sit in URLs that get logged).
    { opts: { token: null, query: `?token=${TOKEN}` } },
    { opts: { token: null, headers: { Authorization: `Bearer ${TOKEN}` } } },
    // Unconfigured, or configured too short to be a lock: every request refused.
    { env: { TC_SMS_ACS_WEBHOOK_TOKEN: undefined }, opts: {} },
    { env: { TC_SMS_ACS_WEBHOOK_TOKEN: 'short' }, opts: { token: 'short' } },
  ];
  for (const { env, opts } of cases) {
    const { baseUrl, db, seenTenantIds, close } = await boot({ env });
    try {
      const r = await postEvents(baseUrl, [stop, deliveryReport('Outgoing_x', 'Delivered')], opts);
      assert.equal(r.status, 401, JSON.stringify({ env, opts }));
      assert.equal(r.json.code, 'ACS_WEBHOOK_UNAUTHORIZED');
      assert.equal(db.log.length, 0, 'no query ran');
      assert.equal(db.table('tc_messages').length, 0);
      assert.equal(db.table('tc_contact_consent').length, 0, 'an unauthenticated STOP records nothing');
      assert.equal(db.table('audit_log').length, 0, 'not even an audit row');
      assert.deepEqual(seenTenantIds, [], 'no tenant DB was even opened');
    } finally {
      await close();
    }
  }
});

test('a body that is not an Event Grid array (e.g. CloudEvents single object) → 400, nothing recorded', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const r = await postEvents(baseUrl, received());
    assert.equal(r.status, 400);
    assert.equal(db.table('tc_messages').length, 0);
  } finally {
    await close();
  }
});

// ── tenant ──────────────────────────────────────────────────────────────────

test('tenant unresolved (no slug / unknown / suspended) → 503; not entitled → 403; nothing recorded', async () => {
  for (const opts of [
    { env: { TC_SMS_ACS_TENANT_SLUG: undefined }, status: 503 },
    { env: { TC_SMS_ACS_TENANT_SLUG: 'nobody' }, status: 503 },
    { tenant: { tenant_id: 'T1', slug: 'carein', status: 'suspended' }, status: 503 },
    { modules: ['voice'], status: 403 },
  ]) {
    const { baseUrl, db, close } = await boot(opts);
    try {
      const r = await postEvents(baseUrl, [received()]);
      assert.equal(r.status, opts.status, JSON.stringify(opts));
      assert.equal(db.table('tc_messages').length, 0);
    } finally {
      await close();
    }
  }
});

test('the webhook writes under the REGISTRY tenant id and the system actor', async () => {
  const { baseUrl, db, seenTenantIds, close } = await boot();
  try {
    await postEvents(baseUrl, [received()]);
    assert.ok(seenTenantIds.length > 0 && seenTenantIds.every((t) => t === 'T1'));
    const created = db.table('audit_log').find((r) => r.resource_type === 'tc_message' && r.action === 'CREATE');
    assert.equal(created.user_id, 'system:acs-sms');
    assert.equal(created.office, 'roland');
  } finally {
    await close();
  }
});

// ── inbound: office from the RECEIVING number ──────────────────────────────

test('office derives from the receiving number: roland’s → roland, valley’s → valley (with or without +)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const r = await postEvents(baseUrl, [received({ to: '14795550150' }), received({ to: '+14795550160' })]);
    assert.equal(r.status, 200);
    const rows = db.table('tc_messages');
    assert.deepEqual(rows.map((x) => x.office_id), ['roland', 'valley']);
    for (const x of rows) {
      assert.equal(x.direction, 'inbound');
      assert.equal(x.status, 'received');
      assert.equal(x.from_address, PATIENT);
      assert.equal(x.provider, 'acs');
    }
    assert.equal(rows[0].to_address, ROLAND_NUMBER);
    assert.equal(rows[1].to_address, VALLEY_NUMBER);
  } finally {
    await close();
  }
});

test('UNKNOWN receiving number → 200 (no Event Grid retry), NOTHING recorded, no tenant opened', async () => {
  const { baseUrl, db, seenTenantIds, close } = await boot();
  try {
    const r = await postEvents(baseUrl, [received({ to: '14795550199', message: 'STOP' })]);
    assert.equal(r.status, 200);
    assert.equal(db.table('tc_messages').length, 0);
    assert.equal(db.table('tc_contact_consent').length, 0);
    assert.deepEqual(seenTenantIds, []);
  } finally {
    await close();
  }
});

test('only ONE office configured: the other office’s number is unknown, never mapped to the configured one', async () => {
  const { baseUrl, db, close } = await boot({ env: { TC_SMS_ACS_FROM_VALLEY: undefined } });
  try {
    await postEvents(baseUrl, [received({ to: VALLEY_NUMBER })]);
    assert.equal(db.table('tc_messages').length, 0);
    await postEvents(baseUrl, [received({ to: ROLAND_NUMBER })]);
    assert.equal(db.table('tc_messages').length, 1);
    assert.equal(db.table('tc_messages')[0].office_id, 'roland');
  } finally {
    await close();
  }
});

test('the patient’s number never decides the office: a valley-receiving text from a roland patient is valley’s', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    seedCase(db); // a roland case with this patient's number
    await postEvents(baseUrl, [received({ to: VALLEY_NUMBER })]);
    const [row] = db.table('tc_messages');
    assert.equal(row.office_id, 'valley');
    assert.equal(row.case_id, null, 'a roland case is never linked from a valley text');
  } finally {
    await close();
  }
});

test('an unusable sender (short code) is dropped with 200, nothing recorded', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const r = await postEvents(baseUrl, [received({ from: '72345' })]);
    assert.equal(r.status, 200);
    assert.equal(db.table('tc_messages').length, 0);
  } finally {
    await close();
  }
});

test('an inbound links to the one OPEN case in that office whose phone matches', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    await postEvents(baseUrl, [received()]);
    assert.equal(db.table('tc_messages')[0].case_id, c.case_id);
  } finally {
    await close();
  }
});

// ── at-least-once: dedup on ACS's messageId ────────────────────────────────

test('a re-delivered event (same ACS messageId) is stored ONCE and audited once', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const ev = received({ messageId: 'd29ebbea-3341-4466-9690-0a03af35228e' });
    assert.equal((await postEvents(baseUrl, [ev])).status, 200);
    // Event Grid redelivers with a NEW envelope id but the same ACS messageId.
    assert.equal((await postEvents(baseUrl, [{ ...ev, id: crypto.randomUUID() }])).status, 200);
    assert.equal((await postEvents(baseUrl, [ev, ev])).status, 200, 'and twice inside one batch');
    assert.equal(db.table('tc_messages').length, 1);
    assert.equal(db.table('tc_messages')[0].provider_message_id, 'd29ebbea-3341-4466-9690-0a03af35228e');
    assert.equal(db.table('audit_log').filter((r) => r.resource_type === 'tc_message' && r.action === 'CREATE').length, 1);
  } finally {
    await close();
  }
});

test('a re-delivered STOP opts out once (one consent row)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const ev = received({ message: 'STOP' });
    await postEvents(baseUrl, [ev]);
    await postEvents(baseUrl, [ev]);
    assert.equal(db.table('tc_contact_consent').length, 1);
  } finally {
    await close();
  }
});

// ── STOP → consent + nurture, through the EXISTING hooks ───────────────────

test('STOP → consent opted_out (stop_keyword) AND the running nurture enrollment stops; the next send is blocked', async () => {
  const { baseUrl, db, acsCalls, close } = await boot();
  try {
    const c = seedCase(db, { status: 'nurture' });
    const enr = seedEnrollment(db, c);
    const d = await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', {
      caseId: c.case_id,
      channel: 'sms',
      body: 'Following up on your visit.',
    });
    assert.equal(d.status, 201);

    const r = await postEvents(baseUrl, [received({ message: 'Stop' })]);
    assert.equal(r.status, 200);

    const [consentRow] = db.table('tc_contact_consent');
    assert.equal(consentRow.state, 'opted_out');
    assert.equal(consentRow.source, 'stop_keyword');
    assert.equal(consentRow.office_id, 'roland');
    assert.equal(consentRow.address, PATIENT);

    const enrRow = db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === enr.enrollment_id);
    assert.equal(enrRow.status, 'stopped');
    assert.equal(enrRow.stop_reason, 'opted_out');
    assert.ok(db.table('audit_log').some((a) => a.resource_type === 'tc_nurture_enrollment.stopped'));

    const send = await apiJson(baseUrl, 'POST', `/api/tc/messages/${d.body.message.messageId}/send?office=roland`, {});
    assert.equal(send.status, 403);
    assert.equal(send.body.code, 'CONSENT_OPTED_OUT');
    assert.equal(acsCalls.length, 0, 'ACS was never called: our consent layer is the authority');
  } finally {
    await close();
  }
});

test('a non-STOP reply PAUSES the running nurture enrollment (existing hook), consent untouched', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db, { status: 'nurture' });
    const enr = seedEnrollment(db, c);
    await postEvents(baseUrl, [received({ message: 'Can I come Tuesday?' })]);
    assert.equal(db.table('tc_nurture_enrollments').find((x) => x.enrollment_id === enr.enrollment_id).status, 'paused');
    assert.equal(db.table('tc_contact_consent').length, 0);
  } finally {
    await close();
  }
});

test('STOP lands even with texting SWITCHED OFF (inbound ignores tc_sms_enabled)', async () => {
  const { baseUrl, db, close } = await boot({ env: { TC_SMS_ENABLED: 'false' } });
  try {
    const r = await postEvents(baseUrl, [received({ message: 'STOP' })]);
    assert.equal(r.status, 200);
    assert.equal(db.table('tc_contact_consent')[0].state, 'opted_out');
  } finally {
    await close();
  }
});

test('HELP / START are recorded and audited, change nothing, and NOTHING is sent in reply', async () => {
  const { baseUrl, db, acsCalls, twilioCalls, close } = await boot();
  try {
    await postEvents(baseUrl, [received({ message: 'STOP' })]);
    const r = await postEvents(baseUrl, [received({ message: 'HELP' }), received({ message: 'START' })]);
    assert.equal(r.status, 200);
    assert.equal(r.text, '', 'the response carries no reply text');
    assert.equal(db.table('tc_contact_consent')[0].state, 'opted_out', 'START does not flip consent back');
    assert.ok(db.table('audit_log').some((a) => a.resource_type === 'tc_message.inbound_keyword.help'));
    assert.ok(db.table('audit_log').some((a) => a.resource_type === 'tc_message.inbound_keyword.start'));
    assert.equal(acsCalls.length, 0);
    assert.equal(twilioCalls.length, 0);
    assert.ok(db.table('tc_messages').every((m) => m.direction === 'inbound'), 'no outbound row was created');
  } finally {
    await close();
  }
});

// ── send through ACS: 202 = queued, never sent/delivered ───────────────────

test('Send (roland): ONE ACS call from roland’s number, delivery reports on; row QUEUED with ACS’s id; Twilio never called', async () => {
  const { baseUrl, db, acsCalls, twilioCalls, close } = await boot();
  try {
    const { c, d, s } = await sendOne(baseUrl, db);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.message.status, 'queued', 'a 202 is queued, not sent and not delivered');
    assert.equal(s.body.message.provider, 'acs');
    assert.equal(s.body.message.providerMessageId, 'Outgoing_fake_0001');
    assert.equal(s.body.message.fromAddress, ROLAND_NUMBER);
    assert.equal(acsCalls.length, 1);
    const call = acsCalls[0];
    assert.match(call.url, /\/sms\?api-version=2021-03-07$/);
    assert.equal(call.headers.Authorization, 'Bearer fake-entra-token');
    assert.equal(call.body.from, ROLAND_NUMBER);
    assert.equal(call.body.smsRecipients.length, 1);
    assert.equal(call.body.smsRecipients[0].to, PATIENT);
    assert.equal(call.body.smsRecipients[0].repeatabilityRequestId, d.messageId, 'idempotent on OUR message id');
    assert.equal(call.body.smsSendOptions.enableDeliveryReport, true);
    assert.equal(rowById(db, d.messageId).status, 'queued');
    assert.equal(twilioCalls.length, 0);

    const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=roland&caseId=${c.case_id}`);
    const smsReady = ready.body.channels.find((x) => x.channel === 'sms');
    assert.equal(smsReady.adapterEnabled, true);
    assert.equal(smsReady.adapterReason, null);
  } finally {
    await close();
  }
});

test('per-office sender, NO fallback: valley without TC_SMS_ACS_FROM_VALLEY → 501 office_not_configured naming it; roland still sends', async () => {
  const { baseUrl, db, acsCalls, close } = await boot({ env: { TC_SMS_ACS_FROM_VALLEY: undefined } });
  try {
    const { c, d, s } = await sendOne(baseUrl, db, 'valley');
    assert.equal(s.status, 501);
    assert.equal(s.body.code, 'FEATURE_DISABLED');
    assert.equal(s.body.reason, 'office_not_configured');
    assert.deepEqual(s.body.missing, ['TC_SMS_ACS_FROM_VALLEY']);
    assert.equal(rowById(db, d.messageId).status, 'draft');
    assert.equal(acsCalls.length, 0);

    const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=valley&caseId=${c.case_id}`);
    assert.equal(ready.body.channels.find((x) => x.channel === 'sms').adapterReason, 'office_not_configured');

    const roland = await sendOne(baseUrl, db, 'roland');
    assert.equal(roland.s.status, 200);
    assert.equal(acsCalls.length, 1);
    assert.equal(acsCalls[0].body.from, ROLAND_NUMBER, 'roland’s own number, never valley borrowing it');
  } finally {
    await close();
  }
});

test('nothing configured (the shipped state): every office is FEATURE_DISABLED and nothing reaches ACS', async () => {
  const { baseUrl, db, acsCalls, close } = await boot({
    env: { TC_SMS_ACS_ENDPOINT: undefined, TC_SMS_ACS_FROM_ROLAND: undefined, TC_SMS_ACS_FROM_VALLEY: undefined },
  });
  try {
    const { d, s } = await sendOne(baseUrl, db);
    assert.equal(s.status, 501);
    assert.equal(s.body.reason, 'not_configured');
    assert.equal(rowById(db, d.messageId).status, 'draft');
    assert.equal(acsCalls.length, 0);
  } finally {
    await close();
  }
});

test('an ACS per-recipient refusal inside the 202 is a FAILED send with a scrubbed reason, never queued', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    acsClient.setFetchForTests(async () =>
      new Response(
        JSON.stringify({
          value: [
            {
              to: PATIENT,
              httpStatusCode: 400,
              successful: false,
              errorMessage: 'Invalid To phone number format +14795550101.',
            },
          ],
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const { d, s } = await sendOne(baseUrl, db);
    assert.equal(s.status, 502, JSON.stringify(s.body));
    assert.equal(s.body.providerCode, 'ACS_RECIPIENT_400');
    const row = rowById(db, d.messageId);
    assert.equal(row.status, 'failed');
    assert.doesNotMatch(row.error, /555/, 'no phone number survives into the stored error');
  } finally {
    await close();
  }
});

// ── delivery reports: monotonic, office from OUR sending number ─────────────

test('delivery report: queued → Delivered applied once and audited; a redelivery changes nothing', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    const id = rowById(db, d.messageId).provider_message_id;
    assert.equal((await postEvents(baseUrl, [deliveryReport(id, 'Delivered')])).status, 200);
    assert.equal(rowById(db, d.messageId).status, 'delivered');
    assert.equal((await postEvents(baseUrl, [deliveryReport(id, 'Delivered')])).status, 200);
    assert.equal(db.table('audit_log').filter((a) => a.resource_type === 'tc_message.status.delivered').length, 1);
  } finally {
    await close();
  }
});

test('delivery report: out of order — a late Failed never regresses delivered; Failed then Delivered → delivered', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const a = await sendOne(baseUrl, db);
    const idA = rowById(db, a.d.messageId).provider_message_id;
    await postEvents(baseUrl, [deliveryReport(idA, 'Delivered')]);
    await postEvents(baseUrl, [deliveryReport(idA, 'Failed')]);
    assert.equal(rowById(db, a.d.messageId).status, 'delivered');
    assert.equal(rowById(db, a.d.messageId).error, null);

    const b = await sendOne(baseUrl, db);
    const idB = rowById(db, b.d.messageId).provider_message_id;
    await postEvents(baseUrl, [deliveryReport(idB, 'Failed')]);
    assert.equal(rowById(db, b.d.messageId).status, 'failed');
    assert.match(rowById(db, b.d.messageId).error, /Not delivered \(ACS: Unknown carrier error\.\)/);
    await postEvents(baseUrl, [deliveryReport(idB, 'Delivered')]);
    assert.equal(rowById(db, b.d.messageId).status, 'delivered', 'a carrier receipt is proof it arrived');
  } finally {
    await close();
  }
});

test('delivery report: an ACS/carrier opt-out block maps to failed WITH a plain reason, never a silent drop', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    const id = rowById(db, d.messageId).provider_message_id;
    await postEvents(baseUrl, [
      deliveryReport(id, 'Failed', { deliveryStatusDetails: 'Recipient has opted out of messages from +14795550150.' }),
    ]);
    const row = rowById(db, d.messageId);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /blocked this sender/);
    assert.doesNotMatch(row.error, /555/);
    assert.equal(db.table('tc_contact_consent').length, 0, 'a provider block does not WRITE consent; STOP does');
  } finally {
    await close();
  }
});

test('delivery report: an unknown deliveryStatus is ignored; an unknown messageId is a 200 no-op', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    const id = rowById(db, d.messageId).provider_message_id;
    assert.equal((await postEvents(baseUrl, [deliveryReport(id, 'Expired')])).status, 200);
    assert.equal(rowById(db, d.messageId).status, 'queued');
    assert.equal((await postEvents(baseUrl, [deliveryReport('Outgoing_nobody', 'Delivered')])).status, 200);
  } finally {
    await close();
  }
});

test('delivery report: office comes from OUR sending number — a report claiming valley’s number cannot touch a roland row', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    const id = rowById(db, d.messageId).provider_message_id;
    await postEvents(baseUrl, [deliveryReport(id, 'Delivered', { from: VALLEY_NUMBER })]);
    assert.equal(rowById(db, d.messageId).status, 'queued');
    // An unknown sending number is dropped, no tenant opened.
    await postEvents(baseUrl, [deliveryReport(id, 'Delivered', { from: '+14795550199' })]);
    assert.equal(rowById(db, d.messageId).status, 'queued');
  } finally {
    await close();
  }
});

test('delivery report: a Twilio-provider row with the same id is never touched by an ACS report', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const { d } = await sendOne(baseUrl, db);
    const row = rowById(db, d.messageId);
    row.provider = 'twilio'; // as if it had gone out through Twilio
    await postEvents(baseUrl, [deliveryReport(row.provider_message_id, 'Delivered')]);
    assert.equal(rowById(db, d.messageId).status, 'queued');
  } finally {
    await close();
  }
});

test('an unrelated event type is ignored with 200 and opens no tenant', async () => {
  const { baseUrl, db, seenTenantIds, close } = await boot();
  try {
    const r = await postEvents(baseUrl, [{ eventType: 'Microsoft.Communication.ChatMessageReceived', data: {} }]);
    assert.equal(r.status, 200);
    assert.equal(db.table('tc_messages').length, 0);
    assert.deepEqual(seenTenantIds, []);
  } finally {
    await close();
  }
});
