'use strict';

/**
 * /api/webhooks/email/unsubscribe — the PUBLIC unsubscribe link (queue item
 * 40), end to end: send a real (fake-ACS) email, take the link out of what
 * ACS was handed, click it, and watch the gate refuse the next email.
 *
 * Also: GET never acts (link scanners), every token outcome is the same page
 * byte for byte, the tenant is resolved from config and never guessed, the
 * office + address come from the token's row and nothing else, and a second
 * click (or an existing manual opt-out) changes nothing.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const { DONE_PAGE } = require('./emailWebhooks');
const {
  bootEmailApp,
  resetEmailHarness,
  seedCase,
  seedTemplate,
  apiJson,
  unsubscribeUrlOf,
} = require('./emailTestUtils');

test.afterEach(() => resetEmailHarness());

/** Draft + Send one email for a case; returns the link ACS was handed. */
async function sendOne(baseUrl, acsCalls, tcCase, n = 0) {
  const d = await apiJson(baseUrl, 'POST', `/api/tc/messages/draft?office=${tcCase.office_id}`, {
    caseId: tcCase.case_id,
    channel: 'email',
    body: 'Hello from the office.',
    subject: 'Hello',
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = await apiJson(baseUrl, 'POST', `/api/tc/messages/${d.body.message.messageId}/send?office=${tcCase.office_id}`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return unsubscribeUrlOf(acsCalls, n);
}

/** The local URL for a public link (same path + query, our test server). */
function local(baseUrl, publicUrl) {
  const u = new URL(publicUrl);
  return baseUrl + u.pathname + u.search;
}

async function click(baseUrl, url, init = {}) {
  const res = await fetch(url, { method: 'POST', ...init });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function postForm(baseUrl, token) {
  return click(baseUrl, `${baseUrl}/api/webhooks/email/unsubscribe`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: token }).toString(),
  });
}

test('round trip: send → click the link → tc_contact_consent (unsubscribe_link) → the next send is blocked', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const link = await sendOne(baseUrl, acsCalls, c);

    // The button on the page posts the form.
    const token = new URL(link).searchParams.get('t');
    const r = await postForm(baseUrl, token);
    assert.equal(r.status, 200);
    assert.equal(r.text, DONE_PAGE);

    const rows = db.table('tc_contact_consent');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].office_id, 'roland');
    assert.equal(rows[0].channel, 'email');
    assert.equal(rows[0].address, 'patient.one@example.test');
    assert.equal(rows[0].state, 'opted_out');
    assert.equal(rows[0].source, 'unsubscribe_link');
    assert.equal(rows[0].updated_by, 'system:unsubscribe_link');
    const audit = db.table('audit_log');
    assert.ok(audit.some((a) => a.resource_type === 'tc_contact_consent' && a.user_id === 'system:email-unsubscribe'));
    assert.ok(audit.some((a) => a.resource_type === 'tc_message.unsubscribe_link'));

    // The gate now refuses the next email to that address in that office.
    const d = await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', {
      caseId: c.case_id,
      channel: 'email',
      body: 'Another',
      subject: 'Again',
    });
    const blocked = await apiJson(baseUrl, 'POST', `/api/tc/messages/${d.body.message.messageId}/send?office=roland`, {});
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'CONSENT_OPTED_OUT');
    assert.equal(acsCalls.filter((x) => x.method === 'POST').length, 1, 'ACS was not called again');
    const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=roland&caseId=${c.case_id}`);
    assert.equal(ready.body.channels.find((x) => x.channel === 'email').consentState, 'opted_out');
  } finally {
    await close();
  }
});

test('RFC 8058 one-click: POST to the List-Unsubscribe URL itself records it', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const link = await sendOne(baseUrl, acsCalls, c);
    const r = await click(baseUrl, local(baseUrl, link), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(r.status, 200);
    assert.equal(db.table('tc_contact_consent')[0].source, 'unsubscribe_link');
  } finally {
    await close();
  }
});

test('GET never acts: a link scanner opening the link changes nothing and touches no database', async () => {
  const { baseUrl, db, acsCalls, seenTenantIds, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const link = await sendOne(baseUrl, acsCalls, c);
    const before = db.log.length;
    const tenantsBefore = seenTenantIds.length;
    const res = await fetch(local(baseUrl, link));
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<form method="post"/);
    assert.match(html, /name="t" value="[A-Za-z0-9_-]{43}"/);
    assert.equal(db.table('tc_contact_consent').length, 0);
    assert.equal(db.log.length, before, 'zero queries');
    assert.equal(seenTenantIds.length, tenantsBefore, 'no tenant database opened');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.doesNotMatch(html, /Roland|patient\.one|example\.test/i, 'the page names nobody');
  } finally {
    await close();
  }
});

test('constant shape: valid, repeated, unknown, malformed and missing tokens all get the identical page', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const token = new URL(await sendOne(baseUrl, acsCalls, c)).searchParams.get('t');
    const answers = [];
    for (const t of [
      token,
      token, // again: idempotent
      crypto.randomBytes(32).toString('base64url'), // well-formed, never issued
      'short',
      '"><script>alert(1)</script>',
      '',
    ]) {
      answers.push(await postForm(baseUrl, t));
    }
    answers.push(await click(baseUrl, `${baseUrl}/api/webhooks/email/unsubscribe`)); // no token at all
    for (const a of answers) {
      assert.equal(a.status, 200);
      assert.equal(a.text, DONE_PAGE, 'byte-for-byte the same page');
    }
    assert.equal(db.table('tc_contact_consent').length, 1, 'only the real token recorded anything, once');
  } finally {
    await close();
  }
});

test('the token is the ONLY input: a body or query naming an office or address is ignored', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const token = new URL(await sendOne(baseUrl, acsCalls, c)).searchParams.get('t');
    const r = await click(baseUrl, `${baseUrl}/api/webhooks/email/unsubscribe?office=valley&address=other@example.test`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token, office: 'valley', email: 'other@example.test' }).toString(),
    });
    assert.equal(r.status, 200);
    const rows = db.table('tc_contact_consent');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].office_id, 'roland', "the token's row decides the office");
    assert.equal(rows[0].address, 'patient.one@example.test');
  } finally {
    await close();
  }
});

test('per office: an unsubscribe from a roland email does not opt the address out at valley', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp({ env: { ACS_EMAIL_FROM_VALLEY: 'donotreply@valley.example.test' } });
  try {
    const roland = seedCase(db);
    const valley = seedCase(db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'Stedi TestValley' });
    const token = new URL(await sendOne(baseUrl, acsCalls, roland)).searchParams.get('t');
    await postForm(baseUrl, token);
    const ok = await sendOne(baseUrl, acsCalls, valley, 1);
    assert.ok(ok, 'valley still sends to the same address');
    assert.deepEqual(
      db.table('tc_contact_consent').map((r) => r.office_id),
      ['roland']
    );
  } finally {
    await close();
  }
});

test('an existing MANUAL opt-out is left exactly as it was (note and attribution kept)', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const token = new URL(await sendOne(baseUrl, acsCalls, c)).searchParams.get('t');
    const manual = await apiJson(baseUrl, 'POST', '/api/tc/messages/consent?office=roland', {
      caseId: c.case_id,
      channel: 'email',
      note: 'Asked at the front desk',
    });
    assert.equal(manual.status, 200);
    await postForm(baseUrl, token);
    const rows = db.table('tc_contact_consent');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'manual');
    assert.equal(rows[0].note, 'Asked at the front desk');
    assert.equal(rows[0].updated_by, 'tc@carein.ai');
  } finally {
    await close();
  }
});

test('the kill switch does not stop an unsubscribe from being recorded', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const token = new URL(await sendOne(baseUrl, acsCalls, c)).searchParams.get('t');
    delete process.env.TC_EMAIL_ENABLED; // email switched off after the send
    const r = await postForm(baseUrl, token);
    assert.equal(r.status, 200);
    assert.equal(db.table('tc_contact_consent').length, 1);
  } finally {
    await close();
  }
});

test('tenant: never guessed. No slug, unknown, suspended or unentitled → 503, nothing recorded, no DB opened', async () => {
  const cases = [
    { env: { TC_EMAIL_TENANT_SLUG: undefined } },
    { env: { TC_EMAIL_TENANT_SLUG: 'someone-else' } },
    { tenant: { tenant_id: 'T1', slug: 'carein', status: 'suspended' } },
  ];
  for (const opts of cases) {
    const { baseUrl, db, seenTenantIds, close } = await bootEmailApp(opts);
    try {
      const r = await postForm(baseUrl, crypto.randomBytes(32).toString('base64url'));
      assert.equal(r.status, 503, JSON.stringify(opts));
      assert.doesNotMatch(r.text, /Your request has been received/);
      assert.equal(seenTenantIds.length, 0);
      assert.equal(db.table('tc_contact_consent').length, 0);
    } finally {
      await close();
      resetEmailHarness();
    }
  }
  // Entitlement: a tenant without 'tc' is refused the same way. The send has
  // to happen first (it needs 'tc'), so this checks the router directly.
  const { baseUrl, db, seenTenantIds, close } = await bootEmailApp({ modules: ['voice'] });
  try {
    const r = await postForm(baseUrl, crypto.randomBytes(32).toString('base64url'));
    assert.equal(r.status, 503);
    assert.equal(seenTenantIds.length, 0);
    assert.equal(db.table('tc_contact_consent').length, 0);
  } finally {
    await close();
  }
});

test('the database failing is a 503 "could not confirm", never the success page', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const token = new URL(await sendOne(baseUrl, acsCalls, c)).searchParams.get('t');
    db.onQuery(/unsubscribe_token_hash = \$1/, () => {
      throw new Error('connection reset');
    });
    const r = await postForm(baseUrl, token);
    assert.equal(r.status, 503);
    assert.match(r.text, /could not confirm/);
    assert.equal(db.table('tc_contact_consent').length, 0);
  } finally {
    await close();
  }
});

test('every email gets its own token; a token from one email opts out only its own address', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const a = seedCase(db);
    const b = seedCase(db, { patient_name: 'Test 2 Stedi', od_patient_id: 12827, email: 'patient.two@example.test' });
    const la = await sendOne(baseUrl, acsCalls, a, 0);
    const lb = await sendOne(baseUrl, acsCalls, b, 1);
    assert.notEqual(la, lb);
    await postForm(baseUrl, new URL(lb).searchParams.get('t'));
    assert.deepEqual(
      db.table('tc_contact_consent').map((r) => r.address),
      ['patient.two@example.test']
    );
  } finally {
    await close();
  }
});

test('template email round trip too (the wrapper path carries the same link)', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    const r = await apiJson(baseUrl, 'POST', '/api/tc/communications/send?office=roland', {
      caseId: c.case_id,
      templateId: tpl.template_id,
    });
    assert.equal(r.status, 200);
    const link = unsubscribeUrlOf(acsCalls, 0);
    await postForm(baseUrl, new URL(link).searchParams.get('t'));
    assert.equal(db.table('tc_contact_consent')[0].source, 'unsubscribe_link');
  } finally {
    await close();
  }
});
