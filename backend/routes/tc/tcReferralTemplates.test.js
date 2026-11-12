'use strict';

/**
 * Per-office referral note templates (Beau's ruling: both places, per-office
 * wording) — the TC routes.
 *
 *   - save / load per office, both kinds, read back and audited
 *   - CROSS-OFFICE ISOLATION: roland's wording never answers for valley, and a
 *     save for one office never touches the other's row
 *   - an unknown placeholder (or a stray brace) is refused 400 BY NAME and
 *     nothing is stored
 *   - editing takes the referral policies' rule (admin.all); a tc / office user
 *     reads them (the forms prefill from them) but cannot change them
 *   - an unknown kind is a 404; a body that names an office is a 400
 *
 * No Open Dental anywhere on this path. No patient data: a template is wording.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const ENV_KEYS = ['TC_REFERRALS_ENABLED_ROLAND', 'TC_REFERRALS_ENABLED_VALLEY'];

function switchReferrals(t, byOffice) {
  const orig = registry.getPlatformSetting;
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    tcReferrals.resetCacheForTests();
  });
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const LIST = (office) => `/api/tc/referrals/templates?office=${office}`;
const ONE = (office, kind) => `/api/tc/referrals/templates/${kind}?office=${office}`;

const MESSAGE = 'Dear {specialist_name}, please see our patient for {reason} (teeth {teeth}). Thank you, {referring_provider}.';
const NOTE = 'Called {specialist_name} ({specialty}) about the referral.';

test('save / load per office: both kinds start blank, a save round-trips and is audited', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl, db } = await boot(t);

  let res = await api(baseUrl, 'GET', LIST('roland'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.office, 'roland');
  assert.equal(res.body.canEdit, true);
  assert.deepEqual(
    res.body.templates.map((x) => [x.kind, x.body, x.updatedAt]),
    [
      ['specialist_message', '', null],
      ['correspondence_note', '', null],
    ],
    'never saved = blank = no prefill'
  );

  const put = await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), { body: MESSAGE + '  \n' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.template.kind, 'specialist_message');
  assert.equal(put.body.template.body, MESSAGE, 'trailing whitespace is not wording');
  assert.equal(put.body.template.updatedBy, 'tc@carein.ai');

  const put2 = await api(baseUrl, 'PUT', ONE('roland', 'correspondence_note'), { body: NOTE });
  assert.equal(put2.status, 200, JSON.stringify(put2.body));

  res = await api(baseUrl, 'GET', LIST('roland'));
  assert.deepEqual(
    res.body.templates.map((x) => [x.kind, x.body]),
    [
      ['specialist_message', MESSAGE],
      ['correspondence_note', NOTE],
    ]
  );

  // A second save of the same kind updates the one row (and says it existed).
  const again = await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), { body: 'Shorter {reason}.' });
  assert.equal(again.status, 200);
  assert.equal(db.table('tc_referral_templates').length, 2, 'one row per (office, kind)');

  // Clearing it: blank = no prefill.
  const cleared = await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), { body: '   ' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.template.body, '');

  const audits = auditRows(db).filter((a) => a.resource_type === 'tc_referral_template');
  assert.deepEqual(
    audits.map((a) => [a.action, a.resource_id, a.prior_state, a.office]),
    [
      ['UPDATE', 'roland:specialist_message', 'default', 'roland'],
      ['UPDATE', 'roland:correspondence_note', 'default', 'roland'],
      ['UPDATE', 'roland:specialist_message', 'stored', 'roland'],
      ['UPDATE', 'roland:specialist_message', 'stored', 'roland'],
    ]
  );
  for (const a of audits) assert.ok(!JSON.stringify(a).includes('Dear'), 'the audit row never carries the wording');
});

test('cross-office isolation: one office never reads or overwrites the other\'s wording', async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);

  assert.equal((await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), { body: 'Roland wording {reason}' })).status, 200);

  let valley = await api(baseUrl, 'GET', LIST('valley'));
  assert.equal(valley.status, 200);
  assert.equal(valley.body.office, 'valley');
  assert.equal(valley.body.templates.find((x) => x.kind === 'specialist_message').body, '', "roland's text is not valley's");

  assert.equal((await api(baseUrl, 'PUT', ONE('valley', 'specialist_message'), { body: 'Valley wording {teeth}' })).status, 200);
  const roland = await api(baseUrl, 'GET', LIST('roland'));
  valley = await api(baseUrl, 'GET', LIST('valley'));
  assert.equal(roland.body.templates.find((x) => x.kind === 'specialist_message').body, 'Roland wording {reason}');
  assert.equal(valley.body.templates.find((x) => x.kind === 'specialist_message').body, 'Valley wording {teeth}');

  const rows = db.table('tc_referral_templates');
  assert.deepEqual(rows.map((r) => r.office_id).sort(), ['roland', 'valley']);

  // A body cannot redirect a save to another office (strict schema).
  const forged = await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), { body: 'x', office: 'valley' });
  assert.equal(forged.status, 400);
  assert.equal(
    (await api(baseUrl, 'GET', LIST('valley'))).body.templates.find((x) => x.kind === 'specialist_message').body,
    'Valley wording {teeth}'
  );

  // An office outside the frozen pair is refused by requireOffice.
  assert.equal((await api(baseUrl, 'GET', LIST('elsewhere'))).status, 400);
});

test('an unknown placeholder is refused 400 by name, and nothing is stored', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl, db } = await boot(t);

  const unknown = await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), {
    body: 'Dear {specialist_name}, re {patient_name}.',
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'REFERRAL_TEMPLATE_UNKNOWN_PLACEHOLDER');
  assert.match(unknown.body.error, /\{patient_name\}/, 'the refusal names the token');
  assert.equal(db.table('tc_referral_templates').length, 0);

  const stray = await api(baseUrl, 'PUT', ONE('roland', 'correspondence_note'), { body: 'Called about {reason' });
  assert.equal(stray.status, 400);
  assert.equal(stray.body.code, 'REFERRAL_TEMPLATE_MALFORMED_PLACEHOLDER');
  assert.equal(db.table('tc_referral_templates').length, 0);

  const tooLong = await api(baseUrl, 'PUT', ONE('roland', 'correspondence_note'), { body: 'x'.repeat(2001) });
  assert.equal(tooLong.status, 400);

  // Every menu name is accepted.
  const all = await api(baseUrl, 'PUT', ONE('roland', 'correspondence_note'), {
    body: '{specialist_name} {specialty} {referring_provider} {teeth} {reason}',
  });
  assert.equal(all.status, 200, JSON.stringify(all.body));
});

test('editing is admin-only (the policies\' rule); a tc or office user reads them', async (t) => {
  switchReferrals(t, { roland: true });
  for (const role of ['tc', 'office']) {
    await t.test(role, async (tt) => {
      const { baseUrl, db } = await boot(tt, { role });
      const res = await api(baseUrl, 'GET', LIST('roland'));
      assert.equal(res.status, 200);
      assert.equal(res.body.canEdit, false);
      const put = await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), { body: 'Hi {reason}' });
      assert.equal(put.status, 403);
      assert.equal(put.body.code, 'FORBIDDEN');
      assert.equal(db.table('tc_referral_templates').length, 0);
    });
  }
});

test('an unknown kind is a 404', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl } = await boot(t);
  const res = await api(baseUrl, 'PUT', ONE('roland', 'patient_letter'), { body: 'x' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'REFERRAL_TEMPLATE_NOT_FOUND');
});

test('dark: with referrals off for the office, both routes refuse', async (t) => {
  switchReferrals(t, null);
  const { baseUrl } = await boot(t);
  assert.equal((await api(baseUrl, 'GET', LIST('roland'))).status, 403);
  assert.equal((await api(baseUrl, 'PUT', ONE('roland', 'specialist_message'), { body: 'x' })).status, 403);
});

test('the send path never reads a template (the gateway is unchanged)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'referralSend.js'), 'utf8');
  assert.ok(!/referralTemplate|tc_referral_templates|fillReferralTemplate/.test(src));
});
