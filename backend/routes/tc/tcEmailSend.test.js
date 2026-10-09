'use strict';

/**
 * TC email through the item-38 pipeline (queue item 40), end to end over
 * HTTP with a FAKE ACS:
 *
 *   - drafting from a library template (a snapshot; minimum necessary);
 *   - the approval click sends rendered HTML + the unsubscribe link;
 *   - the honest status ladder (sent / queued / failed, never delivered);
 *   - ONE send path: /communications/send and /messages/:id/send converge on
 *     the same service function (spied), and the wrapper keeps the legacy log;
 *   - the gates: opt-out, the legacy nurture unsubscribe, the kill switch, a
 *     per-office sender; email ignores quiet hours;
 *   - /communications/render previews without sending.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const messaging = require('../../services/messaging');
const {
  NIGHT,
  bootEmailApp,
  resetEmailHarness,
  seedCase,
  seedTemplate,
  apiJson,
} = require('../emailTestUtils');
const { auditRows } = require('./tcTestUtils');

test.afterEach(() => resetEmailHarness());

async function draftFromTemplate(baseUrl, tcCase, tpl, extra = {}) {
  return apiJson(baseUrl, 'POST', `/api/tc/messages/draft?office=${tcCase.office_id}`, {
    caseId: tcCase.case_id,
    channel: 'email',
    emailTemplateId: tpl.template_id,
    ...extra,
  });
}

// ── drafting ────────────────────────────────────────────────────────────────

test('a template draft is a SNAPSHOT: first name filled, case.* never, body is the readable text', async () => {
  const { baseUrl, db, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    const res = await draftFromTemplate(baseUrl, c, tpl);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const m = res.body.message;
    assert.equal(m.status, 'draft');
    assert.equal(m.emailTemplated, true);
    assert.equal(m.templateId, tpl.template_id);
    assert.equal(m.subject, 'Following up, MangoTest');
    assert.equal(m.toAddress, 'patient.one@example.test', 'server-assembled, normalized');
    assert.match(m.body, /Hi MangoTest/);
    assert.match(m.body, /Thanks for coming in to Roland\./);
    assert.match(m.body, /TC User/, 'sender.name is the drafting TC');
    assert.doesNotMatch(m.body, /\{\{|treatment plan|Total fee/i, 'the stock highlight block is dropped');
    const row = db.table('tc_messages')[0];
    assert.ok(Array.isArray(row.email_blocks));
    assert.equal(row.email_blocks[0].headline, 'Hi MangoTest');
    assert.equal(row.email_preheader, 'A note from Roland');
    // Editing the library template afterwards does not change the draft.
    tpl.blocks[0].headline = 'CHANGED';
    const shown = await apiJson(baseUrl, 'POST', '/api/tc/communications/render?office=roland', { messageId: m.messageId });
    assert.equal(shown.status, 200);
    assert.match(shown.body.email.html, /Hi MangoTest/);
    assert.doesNotMatch(shown.body.email.html, /CHANGED/);
  } finally {
    await close();
  }
});

test('template drafts: email only, no typed body alongside, office-scoped template', async () => {
  const { baseUrl, db, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    const valleyTpl = seedTemplate(db, { office_id: 'valley' });
    const sms = await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', {
      caseId: c.case_id,
      channel: 'sms',
      emailTemplateId: tpl.template_id,
    });
    assert.equal(sms.status, 400);
    assert.equal(sms.body.code, 'EMAIL_TEMPLATE_INVALID');
    const withBody = await draftFromTemplate(baseUrl, c, tpl, { body: 'typed' });
    assert.equal(withBody.status, 400);
    assert.equal(withBody.body.code, 'EMAIL_TEMPLATE_INVALID');
    const other = await draftFromTemplate(baseUrl, c, valleyTpl);
    assert.equal(other.status, 404, "another office's template is not found");
    assert.equal(other.body.code, 'EMAIL_TEMPLATE_NOT_FOUND');
    const empty = seedTemplate(db, { blocks: [{ id: 'hl', type: 'highlight' }, { id: 'd', type: 'divider' }] });
    const nothing = await draftFromTemplate(baseUrl, c, empty);
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.code, 'BODY_REQUIRED');
    assert.equal(db.table('tc_messages').length, 0);
  } finally {
    await close();
  }
});

test("a template draft's body cannot be edited (only its subject); a plain draft's can", async () => {
  const { baseUrl, db, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    const m = (await draftFromTemplate(baseUrl, c, tpl)).body.message;
    const changed = await apiJson(baseUrl, 'PUT', `/api/tc/messages/${m.messageId}?office=roland`, { body: 'new words' });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'MESSAGE_NOT_EDITABLE');
    const subj = await apiJson(baseUrl, 'PUT', `/api/tc/messages/${m.messageId}?office=roland`, {
      body: m.body,
      subject: 'A new subject',
    });
    assert.equal(subj.status, 200);
    assert.equal(subj.body.message.subject, 'A new subject');
  } finally {
    await close();
  }
});

// ── the approval click ──────────────────────────────────────────────────────

test('Send: rendered HTML + text + one-time unsubscribe link go to ACS; the row is `sent`, never delivered', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp({ acsStatus: 'Running', acsPolls: [{ status: 'Succeeded' }] });
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    const m = (await draftFromTemplate(baseUrl, c, tpl)).body.message;
    const sent = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=roland`, {});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.message.status, 'sent');
    assert.equal(sent.body.message.provider, 'acs');
    assert.equal(sent.body.message.providerMessageId, 'op-1');
    assert.equal(sent.body.message.fromAddress, 'donotreply@roland.example.test');

    const post = acsCalls.find((x) => x.method === 'POST');
    assert.equal(post.headers['Operation-Id'], m.messageId);
    assert.deepEqual(post.body.recipients, { to: [{ address: 'patient.one@example.test' }] });
    assert.equal(post.body.content.subject, 'Following up, MangoTest');
    assert.match(post.body.content.html, /Hi MangoTest/);
    assert.match(post.body.content.plainText, /Unsubscribe: https:\/\/dashboard\.example\.test\/api\/webhooks\/email\/unsubscribe\?t=/);
    const link = post.body.headers['List-Unsubscribe'].slice(1, -1);
    assert.ok(post.body.content.html.includes(`href="${link}"`), 'the same link is in the body');
    const token = new URL(link).searchParams.get('t');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new URL(link).search, `?t=${token}`, 'nothing but the opaque token in the URL');

    const row = db.table('tc_messages')[0];
    assert.equal(row.unsubscribe_token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(token), 'the token itself is never stored');
    assert.ok(!('unsubscribe_token_hash' in sent.body.message), 'the hash never leaves the database');
    assert.ok(
      auditRows(db).some((a) => a.resource_type === 'tc_message.sent' && a.resource_id === m.messageId),
      'terminal status audited'
    );
  } finally {
    await close();
  }
});

test('Send: ACS still running after the bounded reads → `queued`; ACS Failed → `failed` with the code', async () => {
  {
    const { baseUrl, db, close } = await bootEmailApp({ acsStatus: 'Running', acsPolls: [{ status: 'Running' }, { status: 'Running' }, { status: 'Running' }] });
    try {
      const c = seedCase(db);
      const m = (await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', { caseId: c.case_id, channel: 'email', body: 'Hello', subject: 'Hi' })).body.message;
      const r = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=roland`, {});
      assert.equal(r.status, 200);
      assert.equal(r.body.message.status, 'queued');
    } finally {
      await close();
    }
  }
  {
    const { baseUrl, db, acsCalls, close } = await bootEmailApp({
      acsStatus: 'Running',
      acsPolls: [{ status: 'Failed', error: { code: 'EmailDroppedAllRecipientsSuppressed', message: 'to patient.one@example.test' } }],
    });
    try {
      const c = seedCase(db);
      const m = (await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', { caseId: c.case_id, channel: 'email', body: 'Hello', subject: 'Hi' })).body.message;
      const r = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=roland`, {});
      assert.equal(r.status, 502);
      assert.equal(r.body.code, 'SEND_FAILED');
      assert.equal(r.body.providerCode, 'ACS_EmailDroppedAllRecipientsSuppressed');
      assert.equal(r.body.message.status, 'failed');
      assert.ok(!/@/.test(r.body.message.error), 'no address in the stored error');
      // Never retried: a failed row is not sendable.
      const again = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=roland`, {});
      assert.equal(again.status, 409);
      assert.equal(acsCalls.filter((x) => x.method === 'POST').length, 1);
    } finally {
      await close();
    }
  }
});

test('a plain email (no template) is escaped HTML with the footer; a missing subject stays a draft', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const noSubject = (await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', { caseId: c.case_id, channel: 'email', body: 'Hi <b>there</b>' })).body.message;
    const refused = await apiJson(baseUrl, 'POST', `/api/tc/messages/${noSubject.messageId}/send?office=roland`, {});
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'SUBJECT_REQUIRED');
    assert.equal(db.table('tc_messages')[0].status, 'draft');
    assert.equal(acsCalls.length, 0);

    await apiJson(baseUrl, 'PUT', `/api/tc/messages/${noSubject.messageId}?office=roland`, { body: 'Hi <b>there</b>', subject: 'Hello' });
    const ok = await apiJson(baseUrl, 'POST', `/api/tc/messages/${noSubject.messageId}/send?office=roland`, {});
    assert.equal(ok.status, 200);
    const html = acsCalls.find((x) => x.method === 'POST').body.content.html;
    assert.match(html, /Hi &lt;b&gt;there&lt;\/b&gt;/);
    assert.match(html, /you are a patient of Roland/);
  } finally {
    await close();
  }
});

// ── gates ───────────────────────────────────────────────────────────────────

test('email is exempt from quiet hours (22:00 Central sends)', async () => {
  const { baseUrl, db, close } = await bootEmailApp({ now: NIGHT });
  try {
    const c = seedCase(db);
    const m = (await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', { caseId: c.case_id, channel: 'email', body: 'Hello', subject: 'Hi' })).body.message;
    const r = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=roland`, {});
    assert.equal(r.status, 200);
  } finally {
    await close();
  }
});

test('the legacy nurture unsubscribe blocks email (stricter), never SMS; readiness says so first', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db, { nurture_unsubscribed: true });
    const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=roland&caseId=${c.case_id}`);
    const email = ready.body.channels.find((x) => x.channel === 'email');
    const sms = ready.body.channels.find((x) => x.channel === 'sms');
    assert.equal(email.blockCode, 'CONSENT_OPTED_OUT');
    assert.equal(email.consentState, 'opted_out');
    assert.equal(sms.blockCode, null, 'SMS is not touched by the nurture flag');
    const m = (await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', { caseId: c.case_id, channel: 'email', body: 'Hello', subject: 'Hi' })).body.message;
    const r = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=roland`, {});
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CONSENT_OPTED_OUT');
    assert.equal(db.table('tc_messages')[0].status, 'draft');
    assert.equal(acsCalls.length, 0);
    assert.ok(auditRows(db).some((a) => a.resource_type === 'tc_message.send_blocked.consent_opted_out'));
  } finally {
    await close();
  }
});

test('kill switch off / office without a sender → 501, draft stays a draft, ACS never called', async () => {
  for (const [env, office, reason] of [
    [{ TC_EMAIL_ENABLED: undefined }, 'roland', 'switched_off'],
    [{ ACS_EMAIL_ENDPOINT: undefined }, 'roland', 'not_configured'],
    [{}, 'valley', 'office_not_configured'],
  ]) {
    const { baseUrl, db, acsCalls, close } = await bootEmailApp({ env });
    try {
      const c = seedCase(db, { office_id: office, od_patient_id: office === 'valley' ? 7115 : 12828 });
      const ready = await apiJson(baseUrl, 'GET', `/api/tc/messages/consent?office=${office}&caseId=${c.case_id}`);
      const email = ready.body.channels.find((x) => x.channel === 'email');
      assert.equal(email.adapterEnabled, false, reason);
      assert.equal(email.adapterReason, reason);
      const m = (await apiJson(baseUrl, 'POST', `/api/tc/messages/draft?office=${office}`, { caseId: c.case_id, channel: 'email', body: 'Hello', subject: 'Hi' })).body.message;
      const r = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=${office}`, {});
      assert.equal(r.status, 501, reason);
      assert.equal(r.body.code, 'FEATURE_DISABLED');
      assert.equal(r.body.reason, reason);
      assert.equal(db.table('tc_messages')[0].status, 'draft');
      assert.equal(acsCalls.length, 0);
    } finally {
      await close();
      resetEmailHarness();
    }
  }
});

// ── ONE send path ───────────────────────────────────────────────────────────

test('ONE send path: /communications/send and /messages/:id/send both go through messaging.sendMessage', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  const original = messaging.sendMessage;
  const spyCalls = [];
  messaging.sendMessage = async (...args) => {
    spyCalls.push(args[2]);
    return original(...args);
  };
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    // The legacy wrapper.
    const legacy = await apiJson(baseUrl, 'POST', '/api/tc/communications/send?office=roland', {
      caseId: c.case_id,
      templateId: tpl.template_id,
    });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    // The approval click.
    const m = (await draftFromTemplate(baseUrl, c, tpl)).body.message;
    const click = await apiJson(baseUrl, 'POST', `/api/tc/messages/${m.messageId}/send?office=roland`, {});
    assert.equal(click.status, 200);

    assert.equal(spyCalls.length, 2, 'both routes called the one service function');
    assert.deepEqual(spyCalls, [legacy.body.message.messageId, m.messageId]);
    // Both are tc_messages rows, sent the same way.
    const rows = db.table('tc_messages');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'sent' && r.provider === 'acs' && r.unsubscribe_token_hash));
    assert.equal(acsCalls.filter((x) => x.method === 'POST').length, 2);

    // Legacy-log continuity: only the wrapper writes tc_communications.
    const log = db.table('tc_communications');
    assert.equal(log.length, 1);
    assert.equal(log[0].comm_id, legacy.body.commId);
    assert.equal(log[0].status, 'sent');
    assert.equal(log[0].template_id, tpl.template_id);
    assert.equal(log[0].template_name, 'Consult follow-up');
    assert.equal(log[0].to_email, 'patient.one@example.test');
    assert.equal(log[0].provider_message_id, 'op-1');
    assert.equal(log[0].sender, 'tc@carein.ai');
    const listed = await apiJson(baseUrl, 'GET', '/api/tc/communications?office=roland');
    assert.equal(listed.body.communications.length, 1);
  } finally {
    messaging.sendMessage = original;
    await close();
  }
});

test('the wrapper is ONE message: strict body, no address, no list; a refusal logs nothing and leaves a draft', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db, { nurture_unsubscribed: true });
    const tpl = seedTemplate(db);
    for (const bad of [
      { caseId: c.case_id, templateId: tpl.template_id, to: 'someone@example.test' },
      { caseId: c.case_id, templateId: tpl.template_id, toEmail: 'someone@example.test' },
      { caseIds: [c.case_id], templateId: tpl.template_id },
      [{ caseId: c.case_id, templateId: tpl.template_id }],
      { caseId: c.case_id },
    ]) {
      const r = await apiJson(baseUrl, 'POST', '/api/tc/communications/send?office=roland', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const refused = await apiJson(baseUrl, 'POST', '/api/tc/communications/send?office=roland', {
      caseId: c.case_id,
      templateId: tpl.template_id,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'CONSENT_OPTED_OUT');
    assert.ok(refused.body.draftMessageId);
    assert.equal(db.table('tc_communications').length, 0, 'nothing was attempted, nothing logged');
    assert.equal(db.table('tc_messages')[0].status, 'draft');
    assert.equal(acsCalls.length, 0);
  } finally {
    await close();
  }
});

test('the wrapper logs an ACS refusal as an `error` communication', async () => {
  const { baseUrl, db, close } = await bootEmailApp({ acsStatus: 'Failed' });
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    const r = await apiJson(baseUrl, 'POST', '/api/tc/communications/send?office=roland', {
      caseId: c.case_id,
      templateId: tpl.template_id,
    });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'SEND_FAILED');
    const log = db.table('tc_communications');
    assert.equal(log.length, 1);
    assert.equal(log[0].status, 'error');
    assert.ok(log[0].error);
    assert.equal(r.body.commId, log[0].comm_id);
  } finally {
    await close();
  }
});

// ── render ──────────────────────────────────────────────────────────────────

test('/communications/render: a template for a case, without writing or sending anything', async () => {
  const { baseUrl, db, acsCalls, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db);
    const r = await apiJson(baseUrl, 'POST', '/api/tc/communications/render?office=roland', {
      caseId: c.case_id,
      templateId: tpl.template_id,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.email.subject, 'Following up, MangoTest');
    assert.match(r.body.email.html, /^<!doctype html>/);
    assert.match(r.body.email.html, /Unsubscribe from these emails/);
    assert.doesNotMatch(r.body.email.html, /\?t=/, 'a preview has no live unsubscribe link');
    assert.equal(db.table('tc_messages').length, 0);
    assert.equal(acsCalls.length, 0);
    assert.ok(auditRows(db).some((a) => a.resource_type === 'tc_email_render'));
    // Office-scoped: valley cannot render roland's case or template.
    const cross = await apiJson(baseUrl, 'POST', '/api/tc/communications/render?office=valley', {
      caseId: c.case_id,
      templateId: tpl.template_id,
    });
    assert.equal(cross.status, 404);
    // An SMS draft is not an email.
    const sms = (await apiJson(baseUrl, 'POST', '/api/tc/messages/draft?office=roland', { caseId: c.case_id, channel: 'sms', body: 'hi' })).body.message;
    const smsRender = await apiJson(baseUrl, 'POST', '/api/tc/communications/render?office=roland', { messageId: sms.messageId });
    assert.equal(smsRender.status, 404);
  } finally {
    await close();
  }
});

test('render works with a legacy-imported template whose blocks do not parse today', async () => {
  const { baseUrl, db, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    const tpl = seedTemplate(db, {
      blocks: [{ type: 'text', html: '<p>Legacy {{patient.firstName}}</p>' }, { type: 'carousel' }, null, { type: 'button' }],
    });
    const r = await apiJson(baseUrl, 'POST', '/api/tc/communications/render?office=roland', {
      caseId: c.case_id,
      templateId: tpl.template_id,
    });
    assert.equal(r.status, 200);
    assert.match(r.body.email.html, /Legacy MangoTest/);
  } finally {
    await close();
  }
});
