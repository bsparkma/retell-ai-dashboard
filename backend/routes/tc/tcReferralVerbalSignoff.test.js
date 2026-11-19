'use strict';

/**
 * Referral sign-off MODE, per office: doctor | verbal | off (referral-verbal-signoff).
 *
 *   C   the compat mapping: an old boolean row reads true -> doctor, false -> off;
 *       a stored mode wins; the env pin forces doctor even over verbal; the
 *       default is doctor; signoffRequired is derived from the mode
 *   MIG the migration: column, backfill, CHECKs equal to the shared list
 *   V   mode 'verbal': a tc.full user approves / declines / sends back with a
 *       NAMED doctor from the provider directory; the event and the audit row
 *       carry both people; approve auto-sends like the doctor's approve
 *   P   the doctor is a directory id: unknown / inactive / another office's -> 422;
 *       a typed name -> 400 (strict)
 *   D   mode 'doctor': the verbal routes refuse 409 even when called directly,
 *       by any role; the doctor's own approve answers exactly as before (no
 *       `verbal` key, no source_ref) — pinned
 *   O   mode 'off': the verbal routes refuse; submit approves exactly as before
 *   S   settings: signoffMode round-trips; verbal + auto-send is allowed;
 *       off + auto-send is still refused; the legacy boolean still works
 *   R   roles: a doctor (sign-off only) cannot reach the tc.full verbal routes
 *
 * Test patients only (roland 12827); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const transitions = require('./referralTransitions');
const store = require('./referralStore');
const referralSend = require('./referralSend');
const migration = require('../../migrations-tenant/1795100000000_tc_referral_signoff_mode.js');
const { contract } = require('./helpers');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-11-18T15:00:00.000Z');
const ENV_PIN = 'REFERRAL_SIGNOFF_REQUIRED_ROLAND';

function switchReferrals(t) {
  const orig = registry.getPlatformSetting;
  const keep = { a: process.env[ENV_PIN], b: process.env.TC_REFERRALS_ENABLED_ROLAND };
  delete process.env[ENV_PIN];
  delete process.env.TC_REFERRALS_ENABLED_ROLAND;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  transitions.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    if (keep.a === undefined) delete process.env[ENV_PIN];
    else process.env[ENV_PIN] = keep.a;
    if (keep.b === undefined) delete process.env.TC_REFERRALS_ENABLED_ROLAND;
    else process.env.TC_REFERRALS_ENABLED_ROLAND = keep.b;
    tcReferrals.resetCacheForTests();
    transitions.setClockForTests(null);
  });
}

/** Count (and stub) the post-approval auto-send, so these tests send nothing. */
function stubAutoSend(t) {
  const orig = referralSend.sendAfterApproval;
  const calls = [];
  referralSend.sendAfterApproval = async (_req, args) => {
    calls.push(args);
    return null;
  };
  t.after(() => {
    referralSend.sendAfterApproval = orig;
  });
  return calls;
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const REF = (path = '', office = 'roland') => `/api/tc/referrals${path}?office=${office}`;
const SIGN = (path = '', office = 'roland') => `/api/tc/referrals/signoff${path}?office=${office}`;

function seedCase(db) {
  const row = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(row);
  return row;
}

function setMode(db, mode, { autosend = false } = {}) {
  db.table('tc_referral_settings').push({
    office_id: 'roland',
    signoff_required: mode !== 'off',
    signoff_mode: mode,
    autosend_on_approval: autosend,
    updated_by: 'boss@carein.ai',
  });
}

function provider(db, { office = 'roland', name = 'Synthetic Doctor', active = true } = {}) {
  const row = {
    provider_id: randomUUID(),
    office_id: office,
    name,
    credential_suffix: 'DDS',
    active,
    od_prov_num: null,
    created_by: 'boss@carein.ai',
    created_at: NOW,
    updated_by: 'boss@carein.ai',
    updated_at: NOW,
  };
  db.table('tc_provider_directory').push(row);
  return row;
}

/** A referral awaiting sign-off, through the real create + submit routes. */
async function pending(baseUrl, db) {
  const r = await api(baseUrl, 'POST', REF(), {
    source: { caseId: seedCase(db).case_id },
    referral: { reason: 'Possible cracked tooth, needs endo eval', urgency: 'soon', teeth: [3] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = await api(baseUrl, 'POST', REF(`/${r.body.referral.referralId}/submit`), {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const row = db.table('tc_referrals').find((x) => x.referral_id === r.body.referral.referralId);
  assert.equal(row.status, 'pending_signoff');
  return row;
}

const referralAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_referral');

// ── C: the compat mapping ───────────────────────────────────────────────────

test('C: an old boolean row maps true -> doctor, false -> off; a stored mode wins; default doctor; signoffRequired derived', (t) => {
  const keep = process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY;
  delete process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY;
  t.after(() => {
    if (keep === undefined) delete process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY;
    else process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY = keep;
  });
  const r = (row) => {
    const p = store.resolvePolicies('valley', row);
    return [p.signoffMode.value, p.signoffMode.source, p.signoffRequired.value, p.signoffRequired.source];
  };
  assert.deepEqual(r(null), ['doctor', 'default', true, 'default']);
  assert.deepEqual(r({ signoff_required: true, autosend_on_approval: false }), ['doctor', 'office', true, 'office']);
  assert.deepEqual(r({ signoff_required: false, autosend_on_approval: false }), ['off', 'office', false, 'office']);
  assert.deepEqual(r({ signoff_required: true, signoff_mode: 'verbal' }), ['verbal', 'office', true, 'office']);
  assert.deepEqual(r({ signoff_required: true, signoff_mode: 'doctor' }), ['doctor', 'office', true, 'office']);
  assert.deepEqual(r({ signoff_required: false, signoff_mode: 'off' }), ['off', 'office', false, 'office']);
  // An unknown stored word is not a mode: the boolean answers.
  assert.deepEqual(r({ signoff_required: true, signoff_mode: 'whatever' }), ['doctor', 'office', true, 'office']);
});

test('C: the env pin forces doctor — the strictest — even over a stored verbal or off', (t) => {
  const keep = process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY;
  process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY = 'true';
  t.after(() => {
    if (keep === undefined) delete process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY;
    else process.env.REFERRAL_SIGNOFF_REQUIRED_VALLEY = keep;
  });
  for (const mode of ['verbal', 'off', 'doctor']) {
    const p = store.resolvePolicies('valley', { signoff_required: mode !== 'off', signoff_mode: mode });
    assert.deepEqual(p.signoffMode, { value: 'doctor', source: 'env' }, mode);
    assert.deepEqual(p.signoffRequired, { value: true, source: 'env' }, mode);
  }
});

test('C: the store, the shared contract and the migration name the same three modes', () => {
  assert.deepEqual([...store.SIGNOFF_MODES], [...contract.TC_REFERRAL_SIGNOFF_MODES]);
  assert.deepEqual([...transitions.VERBAL_VERBS], [...contract.TC_REFERRAL_VERBAL_VERBS]);
});

// ── MIG ─────────────────────────────────────────────────────────────────────

function capture(mig, direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (s) => ({ func: s }),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    sql: rec('sql'),
  };
  mig[direction](pgm);
  return calls;
}
const checkOf = (calls, name) => {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  return c ? String(c.args[2].check) : null;
};

test('MIG: signoff_mode NOT NULL default doctor, backfilled true -> doctor / false -> off, CHECK = the shared list, coherent with signoff_required', () => {
  const calls = capture(migration);
  const col = calls.find((c) => c.op === 'addColumns' && c.args[0] === 'tc_referral_settings');
  assert.deepEqual(col.args[1], { signoff_mode: { type: 'text', notNull: true, default: 'doctor' } });
  const backfill = calls.find((c) => c.op === 'sql');
  assert.equal(
    backfill.args[0],
    "UPDATE tc_referral_settings SET signoff_mode = CASE WHEN signoff_required THEN 'doctor' ELSE 'off' END"
  );
  // The backfill runs before the CHECKs are added.
  assert.ok(calls.indexOf(backfill) < calls.findIndex((c) => c.op === 'addConstraint'));
  const modes = /IN \(([^)]+)\)/.exec(checkOf(calls, 'tc_referral_settings_signoff_mode_check'))[1];
  assert.deepEqual(modes.split(',').map((s) => s.trim().replace(/^'|'$/g, '')), [...contract.TC_REFERRAL_SIGNOFF_MODES]);
  assert.equal(checkOf(calls, 'tc_referral_settings_signoff_mode_coherent_check'), "signoff_required = (signoff_mode <> 'off')");
});

test('MIG: the verbal doctor columns are nullable, paired, and only on approve / decline / return; down undoes all of it', () => {
  const calls = capture(migration);
  const col = calls.find((c) => c.op === 'addColumns' && c.args[0] === 'tc_referral_events');
  assert.deepEqual(col.args[1], { verbal_provider_id: { type: 'uuid' }, verbal_provider_name: { type: 'text' } });
  assert.match(checkOf(calls, 'tc_referral_events_verbal_fields_check'), /IS NULL AND .* IS NULL\) OR \(.* IS NOT NULL AND .* IS NOT NULL/);
  assert.equal(checkOf(calls, 'tc_referral_events_verbal_verb_check'), "verbal_provider_id IS NULL OR verb IN ('approve', 'decline', 'return')");
  assert.match(checkOf(calls, 'tc_referral_events_verbal_name_check'), /BETWEEN 1 AND 200/);
  const down = capture(migration, 'down');
  const dropped = down.filter((c) => c.op === 'dropConstraint').map((c) => c.args[1]).sort();
  const added = calls.filter((c) => c.op === 'addConstraint').map((c) => c.args[1]).sort();
  assert.deepEqual(dropped, added);
  assert.ok(down.some((c) => c.op === 'dropColumns' && c.args[0] === 'tc_referral_settings' && c.args[1].includes('signoff_mode')));
  assert.ok(down.some((c) => c.op === 'dropColumns' && c.args[0] === 'tc_referral_events' && c.args[1].includes('verbal_provider_id')));
});

// ── V: mode 'verbal' ────────────────────────────────────────────────────────

test('V: in verbal mode a tc.full user approves with the doctor named — event + audit carry both people; auto-send runs as on a doctor approve', async (t) => {
  switchReferrals(t);
  const sends = stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'tc', user: { email: 'tc@carein.ai', name: 'TC', tenantId: 'x' } });
  setMode(db, 'verbal', { autosend: true });
  const doc = provider(db, { name: 'Synthetic Doctor' });
  const row = await pending(baseUrl, db);
  const auditsBefore = referralAudits(db).length;

  const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/verbal-approve`), { providerId: doc.provider_id, note: 'OK by phone' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'approved');
  const last = r.body.referral.events.at(-1);
  assert.deepEqual(
    [last.verb, last.fromStatus, last.toStatus, last.actor, last.note, last.verbal],
    ['approve', 'pending_signoff', 'approved', 'tc@carein.ai', 'OK by phone', { providerId: doc.provider_id, providerName: 'Synthetic Doctor' }]
  );
  const stored = db.table('tc_referral_events').at(-1);
  assert.deepEqual([stored.verbal_provider_id, stored.verbal_provider_name], [doc.provider_id, 'Synthetic Doctor']);
  const audits = referralAudits(db).slice(auditsBefore);
  assert.deepEqual(
    audits.map((a) => [a.action, a.resource_id, a.prior_state, a.source_ref, a.user_id]),
    [['UPDATE', row.referral_id, 'pending_signoff', `verbal_provider:${doc.provider_id}`, 'tc@carein.ai']]
  );
  // Exactly the doctor's approve: the auto-send ran once, after the approval, for this office.
  assert.deepEqual(sends, [{ office: 'roland', referralId: row.referral_id }]);
  // And the shared contract parses what the server answered.
  assert.ok(contract.TcReferral.safeParse(r.body.referral).success);
});

test('V: verbal decline (reason required) and send-back (question required) record the doctor too, and never auto-send', async (t) => {
  switchReferrals(t);
  const sends = stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'office' });
  setMode(db, 'verbal', { autosend: true });
  const doc = provider(db);

  const a = await pending(baseUrl, db);
  assert.equal((await api(baseUrl, 'POST', REF(`/${a.referral_id}/verbal-decline`), { providerId: doc.provider_id })).status, 400);
  const d = await api(baseUrl, 'POST', REF(`/${a.referral_id}/verbal-decline`), { providerId: doc.provider_id, reason: 'Treat in house' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.referral.status, 'declined');
  assert.deepEqual(d.body.referral.events.at(-1).verbal, { providerId: doc.provider_id, providerName: doc.name });
  assert.equal(d.body.referral.events.at(-1).note, 'Treat in house');

  const b = await pending(baseUrl, db);
  assert.equal((await api(baseUrl, 'POST', REF(`/${b.referral_id}/verbal-return`), { providerId: doc.provider_id, comment: '  ' })).status, 400);
  const ret = await api(baseUrl, 'POST', REF(`/${b.referral_id}/verbal-return`), { providerId: doc.provider_id, comment: 'Which tooth?' });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.equal(ret.body.referral.status, 'draft');
  assert.deepEqual([ret.body.referral.events.at(-1).verb, ret.body.referral.events.at(-1).verbal.providerId], ['return', doc.provider_id]);
  assert.deepEqual(sends, []);
});

test('V: a verbal move still follows the table — not awaiting sign-off is the ordinary 409, nothing recorded', async (t) => {
  switchReferrals(t);
  stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  setMode(db, 'verbal');
  const doc = provider(db);
  const row = await pending(baseUrl, db);
  row.status = 'approved';
  const before = db.table('tc_referral_events').length;
  const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/verbal-approve`), { providerId: doc.provider_id });
  assert.deepEqual([r.status, r.body.code, r.body.currentStatus], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED', 'approved']);
  assert.equal(db.table('tc_referral_events').length, before);
});

// ── P: the doctor is a directory id ─────────────────────────────────────────

test('P: an unknown, inactive or other-office provider is 422; a typed name or extra field is 400 — nothing moves', async (t) => {
  switchReferrals(t);
  stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  setMode(db, 'verbal');
  const row = await pending(baseUrl, db);
  const inactive = provider(db, { active: false });
  const elsewhere = provider(db, { office: 'valley' });
  const ok = provider(db);
  const eventsBefore = db.table('tc_referral_events').length;
  const auditsBefore = referralAudits(db).length;
  for (const providerId of [randomUUID(), inactive.provider_id, elsewhere.provider_id]) {
    const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/verbal-approve`), { providerId });
    assert.deepEqual([r.status, r.body.code], [422, 'VERBAL_PROVIDER_INVALID'], providerId);
  }
  for (const body of [{}, { providerName: 'Dr. Typed' }, { providerId: 'not-a-uuid' }, { providerId: ok.provider_id, providerName: 'x' }, { providerId: ok.provider_id, office: 'valley' }]) {
    const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/verbal-approve`), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(row.status, 'pending_signoff');
  assert.equal(db.table('tc_referral_events').length, eventsBefore);
  assert.equal(referralAudits(db).length, auditsBefore);
});

// ── D: mode 'doctor' — structural, and unchanged ────────────────────────────

test('D: in doctor mode (stored, default, or env-pinned) every verbal route refuses 409 for tc and admin alike — nothing moves', async (t) => {
  switchReferrals(t);
  const sends = stubAutoSend(t);
  for (const setup of ['stored', 'default', 'env_over_verbal']) {
    for (const role of ['tc', 'admin']) {
      const { baseUrl, db } = await boot(t, { role });
      if (setup === 'stored') setMode(db, 'doctor');
      if (setup === 'env_over_verbal') setMode(db, 'verbal');
      if (setup === 'env_over_verbal') process.env[ENV_PIN] = 'true';
      const doc = provider(db);
      const row = await pending(baseUrl, db);
      const eventsBefore = db.table('tc_referral_events').length;
      const auditsBefore = referralAudits(db).length;
      for (const [path, body] of [
        ['verbal-approve', { providerId: doc.provider_id }],
        ['verbal-decline', { providerId: doc.provider_id, reason: 'x' }],
        ['verbal-return', { providerId: doc.provider_id, comment: 'x' }],
      ]) {
        const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/${path}`), body);
        assert.deepEqual([r.status, r.body.code, r.body.signoffMode], [409, 'SIGNOFF_NOT_VERBAL', 'doctor'], `${setup}/${role}/${path}`);
      }
      assert.equal(row.status, 'pending_signoff');
      assert.equal(db.table('tc_referral_events').length, eventsBefore);
      assert.equal(referralAudits(db).length, auditsBefore);
      delete process.env[ENV_PIN];
    }
  }
  assert.deepEqual(sends, []);
});

test('D: the doctor\'s own approve in doctor mode answers exactly as before — no verbal key, no source_ref, same event row', async (t) => {
  switchReferrals(t);
  stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  setMode(db, 'doctor');
  const row = await pending(baseUrl, db);
  const doctor = await boot(t, { role: 'doctor', db, user: { email: 'doc@carein.ai', name: 'Doc', tenantId: 'x' } });
  const auditsBefore = referralAudits(db).length;
  const r = await api(doctor.baseUrl, 'POST', SIGN(`/${row.referral_id}/approve`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const last = r.body.referral.events.at(-1);
  assert.deepEqual(Object.keys(last).sort(), ['actor', 'at', 'chartNote', 'correspondence', 'eventId', 'fromStatus', 'note', 'toStatus', 'verb']);
  assert.deepEqual([last.verb, last.actor, last.note], ['approve', 'doc@carein.ai', '']);
  const stored = db.table('tc_referral_events').at(-1);
  assert.ok(!('verbal_provider_id' in stored) && !('verbal_provider_name' in stored), 'the ordinary insert names no verbal column');
  const audits = referralAudits(db).slice(auditsBefore);
  assert.deepEqual(audits.map((a) => [a.prior_state, a.source_ref ?? null]), [['pending_signoff', null]]);
  // And the event INSERT is the one it always was.
  assert.ok(
    db.log.some((l) =>
      l.sql.startsWith('INSERT INTO tc_referral_events (event_id, office_id, referral_id, from_status, to_status, actor, at, note, verb) VALUES')
    )
  );
});

test('D: in verbal mode the doctor still signs from their own routes, as a plain approve', async (t) => {
  switchReferrals(t);
  stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  setMode(db, 'verbal');
  const row = await pending(baseUrl, db);
  const doctor = await boot(t, { role: 'doctor', db });
  const r = await api(doctor.baseUrl, 'POST', SIGN(`/${row.referral_id}/approve`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.events.at(-1).verbal, undefined);
});

// ── O: mode 'off' ───────────────────────────────────────────────────────────

test('O: in off mode submit approves as before and the verbal routes refuse 409', async (t) => {
  switchReferrals(t);
  stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  setMode(db, 'off');
  const doc = provider(db);
  const c = await api(baseUrl, 'POST', REF(), {
    source: { caseId: seedCase(db).case_id },
    referral: { reason: 'Possible cracked tooth, needs endo eval', urgency: 'soon', teeth: [3] },
  });
  const id = c.body.referral.referralId;
  const s = await api(baseUrl, 'POST', REF(`/${id}/submit`), {});
  assert.equal(s.body.referral.status, 'approved');
  assert.equal(s.body.referral.events.at(-1).note, "Sign-off isn't required for this office");
  const row = db.table('tc_referrals').find((x) => x.referral_id === id);
  row.status = 'pending_signoff';
  const r = await api(baseUrl, 'POST', REF(`/${id}/verbal-approve`), { providerId: doc.provider_id });
  assert.deepEqual([r.status, r.body.code, r.body.signoffMode], [409, 'SIGNOFF_NOT_VERBAL', 'off']);
  assert.equal(row.status, 'pending_signoff');
});

// ── S: settings ─────────────────────────────────────────────────────────────

test('S: signoffMode round-trips and is stored coherently; verbal + auto-send is allowed; off + auto-send is still refused', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const SETTINGS = REF('/settings');
  let s = await api(baseUrl, 'GET', SETTINGS);
  assert.deepEqual(s.body.signoffMode, { value: 'doctor', source: 'default' });

  const auditsBefore = auditRows(db).filter((a) => a.resource_type === 'tc_referral_settings').length;
  s = await api(baseUrl, 'PUT', SETTINGS, { signoffMode: 'verbal', autosendOnApproval: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.signoffMode, s.body.signoffRequired.value, s.body.autosendOnApproval.value], [{ value: 'verbal', source: 'office' }, true, true]);
  const row = db.table('tc_referral_settings')[0];
  assert.deepEqual([row.signoff_mode, row.signoff_required], ['verbal', true]);

  // Back to doctor: the audit slug says what it WAS, in the old grammar plus the new word.
  s = await api(baseUrl, 'PUT', SETTINGS, { signoffMode: 'doctor' });
  assert.equal(s.status, 200);
  const settingsAudits = auditRows(db).filter((a) => a.resource_type === 'tc_referral_settings').slice(auditsBefore);
  assert.deepEqual(settingsAudits.map((a) => a.prior_state), ['signoff_on:autosend_off', 'signoff_verbal:autosend_on']);

  // off + auto-send: refused, exactly as today.
  const bad = await api(baseUrl, 'PUT', SETTINGS, { signoffMode: 'off' });
  assert.deepEqual([bad.status, bad.body.code], [409, 'REFERRAL_POLICY_UNSAFE']);
  assert.equal(db.table('tc_referral_settings')[0].signoff_mode, 'doctor');

  // Both forms at once, or an unknown mode: 400.
  assert.equal((await api(baseUrl, 'PUT', SETTINGS, { signoffMode: 'doctor', signoffRequired: true })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', SETTINGS, { signoffMode: 'nobody' })).status, 400);
});

test('S: the legacy boolean still works — false is off, true keeps a stored verbal, true from off is doctor', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const SETTINGS = REF('/settings');
  await api(baseUrl, 'PUT', SETTINGS, { signoffMode: 'verbal' });
  let s = await api(baseUrl, 'PUT', SETTINGS, { signoffRequired: true });
  assert.equal(s.body.signoffMode.value, 'verbal');
  s = await api(baseUrl, 'PUT', SETTINGS, { signoffRequired: false });
  assert.deepEqual([s.body.signoffMode.value, s.body.signoffRequired.value], ['off', false]);
  assert.deepEqual([db.table('tc_referral_settings')[0].signoff_mode, db.table('tc_referral_settings')[0].signoff_required], ['off', false]);
  s = await api(baseUrl, 'PUT', SETTINGS, { signoffRequired: true });
  assert.equal(s.body.signoffMode.value, 'doctor');
});

// ── R: roles ────────────────────────────────────────────────────────────────

test('R: a doctor (sign-off only, no tc.full) cannot reach the verbal routes — 403 before anything is read', async (t) => {
  switchReferrals(t);
  stubAutoSend(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  setMode(db, 'verbal');
  const doc = provider(db);
  const row = await pending(baseUrl, db);
  const doctor = await boot(t, { role: 'doctor', db });
  const r = await api(doctor.baseUrl, 'POST', REF(`/${row.referral_id}/verbal-approve`), { providerId: doc.provider_id });
  assert.equal(r.status, 403);
  assert.equal(row.status, 'pending_signoff');
});
