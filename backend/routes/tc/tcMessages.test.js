'use strict';

/**
 * /api/tc/messages — review-then-send for patient messages (queue item 38).
 *
 * Covers: the module/office/role guards (tcGuard pattern), server-assembled
 * addresses, the status machine (no send from anything but a draft; an adapter
 * throw is `failed` with the error preserved and is never retried), every
 * consent-gate block as its own code AND its own audit row, inbound STOP →
 * opt-out, and office scoping.
 *
 * Fixtures: roland 12827 / 12828, valley 7115. Names are synthetic; phones are
 * 555-01xx fictional numbers.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const messaging = require('../../services/messaging');
const consent = require('../../services/messaging/consent');
const adapters = require('../../services/messaging/adapters');

const DAY = new Date('2026-10-08T17:00:00Z'); // 12:00 CDT
const NIGHT = new Date('2026-10-09T03:00:00Z'); // 22:00 CDT

function seedCase(db, overrides = {}) {
  const row = {
    case_id: crypto.randomUUID(),
    office_id: 'roland',
    patient_name: 'MangoTest Test',
    phone: '(479) 555-0101',
    email: 'Patient.One@Example.test',
    od_patient_id: 12828,
    status: 'presented',
    ...overrides,
  };
  db.table('tc_cases').push(row);
  return row;
}

/** Stub OD TxtMsgOk per office:PatNum. */
function stubOd(table) {
  const calls = [];
  consent.setOdPatientReaderForTests(async (office, patNum) => {
    calls.push({ office, patNum });
    const key = `${office}:${patNum}`;
    return key in table ? { PatNum: patNum, TxtMsgOk: table[key] } : null;
  });
  return calls;
}

/** A connected adapter that records what it was handed. */
function fakeAdapter(channel, behaviour) {
  const sent = [];
  adapters.setAdapterForTests(channel, {
    channel,
    provider: 'fake',
    enabled: () => true,
    async send(message, office) {
      sent.push({ message, office });
      return behaviour(message, office);
    },
  });
  return sent;
}

async function boot(opts) {
  messaging.setClockForTests(() => DAY);
  stubOd({ 'roland:12828': 'Yes', 'roland:12827': 'Yes', 'valley:7115': 'Yes' });
  return bootTcApp(opts);
}

test.afterEach(() => {
  messaging.resetClock();
  consent.resetOdPatientReader();
  adapters.resetAdapters();
});

async function draft(baseUrl, office, body) {
  return api(baseUrl, 'POST', `/api/tc/messages/draft?office=${office}`, body);
}

// ── guards ──────────────────────────────────────────────────────────────────

test('guard: unentitled tenant → 403 MODULE_NOT_ENTITLED on every messages route', async () => {
  const { baseUrl, close } = await boot({ modules: ['voice'] });
  try {
    for (const [method, path] of [
      ['GET', '/api/tc/messages?office=roland'],
      ['POST', '/api/tc/messages/draft?office=roland'],
      ['POST', `/api/tc/messages/${crypto.randomUUID()}/send?office=roland`],
      ['GET', '/api/tc/messages/inbox?office=roland'],
    ]) {
      const res = await api(baseUrl, method, path, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
      assert.equal(res.body.module, 'tc');
    }
  } finally {
    await close();
  }
});

test('guard: missing or unknown office → 400 INVALID_OFFICE', async () => {
  const { baseUrl, close } = await boot();
  try {
    for (const qs of ['', '?office=riley', '?office=ROLAND']) {
      const res = await api(baseUrl, 'GET', `/api/tc/messages/inbox${qs}`);
      assert.equal(res.status, 400, qs);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
  } finally {
    await close();
  }
});

test('guard: a hygienist (tc.hygiene only) cannot reach messaging', async () => {
  const { baseUrl, close } = await boot({ role: 'hygiene' });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/messages/inbox?office=roland');
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('guard: no tenant context → 403', async () => {
  const { baseUrl, close } = await boot({ user: null });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/messages/inbox?office=roland');
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

// ── drafts ──────────────────────────────────────────────────────────────────

test('draft: the address is assembled server-side from the case row and normalized', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    const sms = await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hello there' });
    assert.equal(sms.status, 201, JSON.stringify(sms.body));
    assert.equal(sms.body.message.toAddress, '+14795550101');
    assert.equal(sms.body.message.status, 'draft');
    assert.equal(sms.body.message.direction, 'outbound');
    assert.equal(sms.body.message.createdBy, 'tc@carein.ai');

    const email = await draft(baseUrl, 'roland', {
      caseId: c.case_id, channel: 'email', body: 'Hello', subject: 'Hi',
    });
    assert.equal(email.body.message.toAddress, 'patient.one@example.test');
    assert.equal(email.body.message.subject, 'Hi');
    assert.ok(auditRows(db).some((r) => r.action === 'CREATE' && r.resource_type === 'tc_message'));
  } finally {
    await close();
  }
});

test('draft: a client-supplied address is refused (strict body), never used', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    for (const key of ['toAddress', 'to_address', 'to', 'phone']) {
      const res = await draft(baseUrl, 'roland', {
        caseId: c.case_id, channel: 'sms', body: 'x', [key]: '+14795550199',
      });
      assert.equal(res.status, 400, key);
      assert.equal(res.body.code, 'VALIDATION_FAILED');
    }
    assert.equal(db.table('tc_messages').length, 0);
  } finally {
    await close();
  }
});

test('draft: no usable phone → 409 NO_ADDRESS; another office’s case → 404', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const noPhone = seedCase(db, { phone: '555-01' });
    const r1 = await draft(baseUrl, 'roland', { caseId: noPhone.case_id, channel: 'sms', body: 'x' });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.code, 'NO_ADDRESS');

    const valleyCase = seedCase(db, { office_id: 'valley', od_patient_id: 7115 });
    const r2 = await draft(baseUrl, 'roland', { caseId: valleyCase.case_id, channel: 'sms', body: 'x' });
    assert.equal(r2.status, 404);
    assert.equal(r2.body.code, 'CASE_NOT_FOUND');
  } finally {
    await close();
  }
});

test('draft from a follow-up: template fill, first name + office name, NEVER the private talking point', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db, { patient_name: 'Test, MangoTest' });
    const followupId = crypto.randomUUID();
    db.table('tc_followups').push({
      followup_id: followupId, case_id: c.case_id, office_id: 'roland', kind: 'followup',
      channel: 'text', status: 'pending', talking_point: 'PRIVATE: spouse decides, push financing',
      nurture_type: null, due_date: '2026-10-08',
    });
    const res = await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', followupId });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const m = res.body.message;
    assert.match(m.body, /^Hi MangoTest, /);
    assert.match(m.body, /Roland/);
    assert.match(m.body, /Reply STOP to opt out\.$/);
    assert.doesNotMatch(m.body, /PRIVATE|spouse|financing/);
    assert.equal(m.templateId, 'followup.default');

    const nurtureId = crypto.randomUUID();
    db.table('tc_followups').push({
      followup_id: nurtureId, case_id: c.case_id, office_id: 'roland', kind: 'nurture',
      channel: 'email', status: 'pending', talking_point: null, nurture_type: 'financing', due_date: '2026-10-08',
    });
    const e = await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'email', followupId: nurtureId });
    assert.equal(e.body.message.templateId, 'nurture.financing');
    assert.ok(e.body.message.subject);

    // A follow-up from another case is refused.
    const other = seedCase(db);
    const bad = await draft(baseUrl, 'roland', { caseId: other.case_id, channel: 'sms', followupId });
    assert.equal(bad.status, 404);
    assert.equal(bad.body.code, 'FOLLOWUP_NOT_FOUND');
  } finally {
    await close();
  }
});

test('edit and discard: drafts only', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'v1' })).body.message;
    const edited = await api(baseUrl, 'PUT', `/api/tc/messages/${d.messageId}?office=roland`, { body: 'v2' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.message.body, 'v2');
    assert.equal(edited.body.message.toAddress, '+14795550101');

    const sneaky = await api(baseUrl, 'PUT', `/api/tc/messages/${d.messageId}?office=roland`, {
      body: 'v3', toAddress: '+14795550199',
    });
    assert.equal(sneaky.status, 400);

    // Not a draft any more → not editable, not discardable.
    db.table('tc_messages').find((r) => r.message_id === d.messageId).status = 'failed';
    const e2 = await api(baseUrl, 'PUT', `/api/tc/messages/${d.messageId}?office=roland`, { body: 'v4' });
    assert.equal(e2.status, 409);
    assert.equal(e2.body.code, 'MESSAGE_NOT_EDITABLE');
    const x2 = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/discard?office=roland`, {});
    assert.equal(x2.status, 409);

    const d2 = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'bye' })).body.message;
    const x = await api(baseUrl, 'POST', `/api/tc/messages/${d2.messageId}/discard?office=roland`, {});
    assert.equal(x.status, 200);
    assert.equal(db.table('tc_messages').some((r) => r.message_id === d2.messageId), false);
    assert.ok(auditRows(db).some((r) => r.action === 'DELETE' && r.resource_id === d2.messageId));
  } finally {
    await close();
  }
});

// ── send: the adapters are stubs in this slice ──────────────────────────────

test('send with the REAL (stub) adapters → 501 FEATURE_DISABLED, row stays a draft, attempt audited', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    for (const channel of ['sms', 'email']) {
      const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel, body: 'x', ...(channel === 'email' ? { subject: 's' } : {}) })).body.message;
      const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
      assert.equal(res.status, 501, channel);
      assert.equal(res.body.code, 'FEATURE_DISABLED');
      assert.equal(db.table('tc_messages').find((r) => r.message_id === d.messageId).status, 'draft');
      assert.ok(
        auditRows(db).some((r) => r.resource_type === 'tc_message.send_attempt' && r.resource_id === d.messageId)
      );
    }
  } finally {
    await close();
  }
});

test('the stub adapters THROW FEATURE_DISABLED even if called directly (fail closed)', async () => {
  for (const ch of ['sms', 'email']) {
    const a = adapters.getAdapter(ch);
    assert.equal(a.enabled(), false);
    await assert.rejects(() => a.send({}, { officeKey: 'roland', officeName: 'x' }), (e) => e.code === 'FEATURE_DISABLED');
  }
});

// ── send: the status machine (with a connected fake adapter) ────────────────

test('send happy path: sent only after the adapter confirms; second click → 409; audited', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const sent = fakeAdapter('sms', async () => ({ provider: 'fake', providerMessageId: 'PM1', status: 'sent', fromAddress: '+14795550000' }));
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;

    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message.status, 'sent');
    assert.equal(res.body.message.providerMessageId, 'PM1');
    assert.equal(res.body.message.provider, 'fake');
    assert.equal(res.body.message.sentBy, 'tc@carein.ai');
    assert.ok(res.body.message.sentAt);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.toAddress, '+14795550101');
    assert.deepEqual(sent[0].office, { officeKey: 'roland', officeName: sent[0].office.officeName });

    const again = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'MESSAGE_NOT_SENDABLE');
    assert.equal(sent.length, 1, 'never handed to the adapter twice');

    const types = auditRows(db).filter((r) => r.resource_id === d.messageId).map((r) => r.resource_type);
    assert.ok(types.includes('tc_message.send_attempt'));
    assert.ok(types.includes('tc_message.sent'));
  } finally {
    await close();
  }
});

test('send: `queued` from the adapter is stored verbatim (a confirmed hand-off)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    fakeAdapter('sms', async () => ({ provider: 'fake', providerMessageId: 'PMQ', status: 'queued' }));
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.body.message.status, 'queued');
  } finally {
    await close();
  }
});

test('no send from sent, delivered, failed, sending, queued, or received', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const sent = fakeAdapter('sms', async () => ({ provider: 'fake', providerMessageId: 'X', status: 'sent' }));
    const c = seedCase(db);
    for (const status of ['sent', 'delivered', 'failed', 'sending', 'queued', 'received']) {
      const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
      db.table('tc_messages').find((r) => r.message_id === d.messageId).status = status;
      const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
      assert.equal(res.status, 409, status);
      assert.equal(res.body.code, 'MESSAGE_NOT_SENDABLE');
    }
    assert.equal(sent.length, 0);
  } finally {
    await close();
  }
});

test('adapter THROWS → failed, provider error preserved on the row, never retried', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    let calls = 0;
    fakeAdapter('sms', async () => {
      calls += 1;
      const e = new Error('Carrier rejected: unreachable handset (30003)');
      e.code = 'PROVIDER_REJECTED';
      throw e;
    });
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'SEND_FAILED');
    assert.equal(res.body.providerCode, 'PROVIDER_REJECTED');
    assert.equal(res.body.message.status, 'failed');

    const row = db.table('tc_messages').find((r) => r.message_id === d.messageId);
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'Carrier rejected: unreachable handset (30003)');
    assert.equal(row.provider_message_id ?? null, null);

    const again = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(again.status, 409);
    assert.equal(calls, 1, 'a failed message is never retried');

    const failedAudit = auditRows(db).find((r) => r.resource_type === 'tc_message.failed');
    assert.ok(failedAudit);
    assert.equal(failedAudit.result, 'ERROR');
  } finally {
    await close();
  }
});

test('adapter FEATURE_DISABLED thrown after claiming enabled → failed (the throw is what counts)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const real = adapters.getAdapter('sms');
    adapters.setAdapterForTests('sms', { ...real, enabled: () => true });
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, 502);
    assert.equal(res.body.providerCode, 'FEATURE_DISABLED');
    assert.equal(db.table('tc_messages').find((r) => r.message_id === d.messageId).status, 'failed');
  } finally {
    await close();
  }
});

test('adapter resolves something that is not a confirmation → failed, not sent', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    fakeAdapter('sms', async () => ({ ok: true }));
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, 502);
    assert.equal(res.body.providerCode, 'ADAPTER_BAD_RESPONSE');
    assert.equal(db.table('tc_messages').find((r) => r.message_id === d.messageId).status, 'failed');
  } finally {
    await close();
  }
});

// ── send: consent gate through the route (each block distinct + audited) ────

async function expectBlock({ setup, code, status = 403, channel = 'sms' }) {
  const { baseUrl, db, close } = await boot();
  try {
    const sent = fakeAdapter(channel, async () => ({ provider: 'fake', providerMessageId: 'NO', status: 'sent' }));
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel, body: 'Hi', ...(channel === 'email' ? { subject: 's' } : {}) })).body.message;
    await setup({ baseUrl, db, c });
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.equal(res.body.code, code);
    assert.equal(sent.length, 0, 'a blocked message never reaches the adapter');
    assert.equal(db.table('tc_messages').find((r) => r.message_id === d.messageId).status, 'draft');
    const blockAudit = auditRows(db).find(
      (r) => r.resource_type === `tc_message.send_blocked.${code.toLowerCase()}` && r.resource_id === d.messageId
    );
    assert.ok(blockAudit, `block ${code} must be audited`);
    assert.equal(blockAudit.result, 'UNAUTHORIZED');
    assert.equal(blockAudit.office, 'roland');
  } finally {
    await close();
  }
}

test('block: manual opt-out → CONSENT_OPTED_OUT (403), audited, row stays draft', () =>
  expectBlock({
    code: 'CONSENT_OPTED_OUT',
    setup: async ({ baseUrl, c }) => {
      const r = await api(baseUrl, 'POST', '/api/tc/messages/consent?office=roland', {
        caseId: c.case_id, channel: 'sms', note: 'Asked us not to text',
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.consent.state, 'opted_out');
      assert.equal(r.body.consent.source, 'manual');
    },
  }));

test('block: email opt-out → CONSENT_OPTED_OUT', () =>
  expectBlock({
    code: 'CONSENT_OPTED_OUT',
    channel: 'email',
    setup: async ({ baseUrl, c }) => {
      await api(baseUrl, 'POST', '/api/tc/messages/consent?office=roland', { caseId: c.case_id, channel: 'email' });
    },
  }));

test('block: OD TxtMsgOk No → OD_TEXT_CONSENT_NO (403)', () =>
  expectBlock({ code: 'OD_TEXT_CONSENT_NO', setup: async () => stubOd({ 'roland:12828': 'No' }) }));

test('block: OD unreadable → OD_CONSENT_UNAVAILABLE (503, fail closed)', () =>
  expectBlock({ code: 'OD_CONSENT_UNAVAILABLE', status: 503, setup: async () => stubOd({}) }));

test('block: quiet hours → QUIET_HOURS (403)', () =>
  expectBlock({ code: 'QUIET_HOURS', setup: async () => messaging.setClockForTests(() => NIGHT) }));

test('email in quiet hours is NOT blocked', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    messaging.setClockForTests(() => NIGHT);
    fakeAdapter('email', async () => ({ provider: 'fake', providerMessageId: 'E1', status: 'sent' }));
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'email', body: 'Hi', subject: 's' })).body.message;
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.message.status, 'sent');
  } finally {
    await close();
  }
});

test('opt-out cannot be undone: POST /consent refuses a state field (no opt-in path)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    const res = await api(baseUrl, 'POST', '/api/tc/messages/consent?office=roland', {
      caseId: c.case_id, channel: 'sms', state: 'opted_in',
    });
    assert.equal(res.status, 400);
    assert.equal(db.table('tc_contact_consent').length, 0);
  } finally {
    await close();
  }
});

test('send: the case phone changed after drafting → 409 ADDRESS_CHANGED, nothing sent', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const sent = fakeAdapter('sms', async () => ({ provider: 'fake', providerMessageId: 'X', status: 'sent' }));
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
    db.table('tc_cases').find((r) => r.case_id === c.case_id).phone = '479-555-0102';
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ADDRESS_CHANGED');
    assert.equal(sent.length, 0);
  } finally {
    await close();
  }
});

test('office scoping: a roland message is a 404 from valley (read, send, edit, discard)', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const sent = fakeAdapter('sms', async () => ({ provider: 'fake', providerMessageId: 'X', status: 'sent' }));
    const c = seedCase(db);
    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
    const s = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=valley`, {});
    assert.equal(s.status, 404);
    const e = await api(baseUrl, 'PUT', `/api/tc/messages/${d.messageId}?office=valley`, { body: 'x' });
    assert.equal(e.status, 404);
    const x = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/discard?office=valley`, {});
    assert.equal(x.status, 404);
    const list = await api(baseUrl, 'GET', `/api/tc/messages?office=valley&caseId=${c.case_id}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.messages, []);
    assert.equal(sent.length, 0);
  } finally {
    await close();
  }
});

// ── reads ───────────────────────────────────────────────────────────────────

test('thread: outbound and inbound for the case, oldest first; malformed id → 404', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    const c = seedCase(db);
    await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'first' });
    db.table('tc_messages').push({
      message_id: crypto.randomUUID(), office_id: 'roland', case_id: c.case_id, direction: 'inbound', channel: 'sms',
      to_address: null, from_address: '+14795550101', body: 'reply', subject: null, template_id: null,
      status: 'received', provider: 'fake', provider_message_id: 'IN1', error: null, created_by: null,
      sent_by: null, created_at: new Date(Date.now() + 1000), sent_at: null,
    });
    const res = await api(baseUrl, 'GET', `/api/tc/messages?office=roland&caseId=${c.case_id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages.map((m) => m.body), ['first', 'reply']);
    assert.ok(auditRows(db).some((r) => r.action === 'READ' && r.resource_type === 'tc_message'));

    const bad = await api(baseUrl, 'POST', '/api/tc/messages/not-a-uuid/send?office=roland', {});
    assert.equal(bad.status, 404);
  } finally {
    await close();
  }
});

test('readiness: per channel — server address, adapter off, consent facts, badge inputs', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    stubOd({ 'roland:12828': '??' });
    const c = seedCase(db);
    const res = await api(baseUrl, 'GET', `/api/tc/messages/consent?office=roland&caseId=${c.case_id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [sms, email] = res.body.channels;
    assert.equal(sms.channel, 'sms');
    assert.equal(sms.address, '+14795550101');
    assert.equal(sms.adapterEnabled, false);
    assert.equal(sms.odTextConsent, 'unknown');
    assert.equal(sms.blockCode, null);
    assert.equal(email.channel, 'email');
    assert.equal(email.odTextConsent, 'not_checked');
    assert.ok(auditRows(db).some((r) => r.resource_type === 'tc_message_consent' && r.resource_id === c.case_id));

    messaging.setClockForTests(() => NIGHT);
    const night = await api(baseUrl, 'GET', `/api/tc/messages/consent?office=roland&caseId=${c.case_id}`);
    assert.equal(night.body.channels[0].quietHours, true);
    assert.equal(night.body.channels[0].blockCode, 'QUIET_HOURS');
    assert.equal(night.body.channels[1].blockCode, null);
  } finally {
    await close();
  }
});

// ── inbound ─────────────────────────────────────────────────────────────────

test('recordInbound: lands unlinked in the inbox; STOP records an opt-out that blocks the next send', async () => {
  const { baseUrl, db, close } = await boot();
  try {
    fakeAdapter('sms', async () => ({ provider: 'fake', providerMessageId: 'X', status: 'sent' }));
    const c = seedCase(db);
    // A request-shaped context for the service: tenant + a system actor.
    const req = { tenant: { id: 'T1' }, user: { email: 'system:inbound' }, originalUrl: '/webhook-test' };
    const tenantDb = require('../../platform/tenantDb');
    const prev = tenantDb.withTenantDb;
    tenantDb.withTenantDb = async (_r, fn) => fn(db);
    try {
      const plain = await messaging.recordInbound(req, { office: 'roland', channel: 'sms', fromAddress: '479.555.0101', body: 'Is Tuesday ok?' });
      assert.equal(plain.optedOut, false);
      assert.equal(plain.message.status, 'received');
      assert.equal(plain.message.fromAddress, '+14795550101');
      const stop = await messaging.recordInbound(req, { office: 'roland', channel: 'sms', fromAddress: '(479) 555-0101', body: '  stop. ' });
      assert.equal(stop.optedOut, true);
    } finally {
      tenantDb.withTenantDb = prev;
    }

    const inbox = await api(baseUrl, 'GET', '/api/tc/messages/inbox?office=roland');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.messages.length, 2);
    const valleyInbox = await api(baseUrl, 'GET', '/api/tc/messages/inbox?office=valley');
    assert.equal(valleyInbox.body.messages.length, 0);

    const consentRow = db.table('tc_contact_consent')[0];
    assert.equal(consentRow.state, 'opted_out');
    assert.equal(consentRow.source, 'stop_keyword');
    assert.equal(consentRow.address, '+14795550101');

    const d = (await draft(baseUrl, 'roland', { caseId: c.case_id, channel: 'sms', body: 'Hi' })).body.message;
    const res = await api(baseUrl, 'POST', `/api/tc/messages/${d.messageId}/send?office=roland`, {});
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CONSENT_OPTED_OUT');
  } finally {
    await close();
  }
});

test('STOP keyword recognition', () => {
  for (const yes of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'cancel', 'End', 'QUIT', 'stopall', 'STOP!']) {
    assert.equal(messaging.isStopKeyword(yes), true, yes);
  }
  for (const no of ['please stop calling me at work', 'STOP IT', 'Tuesday', '', null]) {
    assert.equal(messaging.isStopKeyword(no), false, String(no));
  }
});
