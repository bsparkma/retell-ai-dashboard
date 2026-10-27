'use strict';

/**
 * R5b's tenant migration, 1792500000000_tc_referral_links: the event-verb
 * CHECK widened to R5's verbs + the four R5b adds (equal to the shared
 * contract), patient_email_sent joining the send-fields CHECK, the
 * scheduled_date column, the hashed link-token table and its CHECKs, the
 * role-guarded grant, a clean down that restores R5's CHECKs exactly, no new
 * referral status, and numbered above develop's newest (1792400000000).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792500000000_tc_referral_links.js');
const r5 = require('../migrations-tenant/1792100000000_tc_referral_email.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792500000000_tc_referral_links.js';

function capture(mig, direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (s) => ({ func: s }),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
    dropIndex: rec('dropIndex'),
    sql: rec('sql'),
  };
  mig[direction](pgm);
  return calls;
}

function checksNamed(calls, name) {
  return calls.filter((x) => x.op === 'addConstraint' && x.args[1] === name).map((c) => String(c.args[2].check));
}

function inList(sql) {
  return /IN \(([^)]+)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

test('the verb CHECK is dropped and re-added, inline, equal to the contract: R5 verbs then the four R5b verbs', () => {
  const calls = capture(migration);
  const dropAt = calls.findIndex((c) => c.op === 'dropConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  const addAt = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  assert.ok(dropAt > -1 && addAt > dropAt, 'drop, then add');
  const [sql] = checksNamed(calls, 'tc_referral_events_verb_check');
  assert.match(sql, /^verb IS NULL OR verb IN \(/);
  // R6.9: this migration is history; its list is the frozen R5B one (the live
  // vocabulary, TC_REFERRAL_ALL_EVENT_VERBS, is pinned by 1792800000000's test).
  assert.deepEqual(inList(sql), [...contract.TC_REFERRAL_R5B_EVENT_VERBS]);
  assert.deepEqual(
    [...contract.TC_REFERRAL_R5B_EVENT_VERBS],
    [...contract.TC_REFERRAL_R5_EVENT_VERBS, 'patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed']
  );
  assert.deepEqual([...contract.TC_REFERRAL_LINK_EVENT_VERBS], ['patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed']);
});

test('patient_email_sent carries the email it records, like send / send_conflict; nothing else gains fields', () => {
  const [sql] = checksNamed(capture(migration), 'tc_referral_events_send_fields_check');
  assert.equal(
    sql,
    "(verb IN ('send', 'send_conflict', 'patient_email_sent')) = (acs_message_id IS NOT NULL AND recipient_address IS NOT NULL AND unsubscribe_token_hash IS NOT NULL)"
  );
  // The unsubscribe resolver reads exactly the rows this CHECK makes carry a hash.
  const messaging = fs.readFileSync(`${__dirname}/../services/messaging/index.js`, 'utf8');
  assert.match(messaging, /\['send', 'send_conflict', 'patient_email_sent'\]/);
});

test('the token table: hash PK (hex sha-256), office + composite FK, audience/purpose vocab, expiry after creation, one per kind', () => {
  const calls = capture(migration);
  const create = calls.find((c) => c.op === 'createTable');
  assert.equal(create.args[0], 'tc_referral_link_tokens');
  assert.deepEqual(Object.keys(create.args[1]), ['token_hash', 'office_id', 'referral_id', 'audience', 'purpose', 'created_at', 'expires_at', 'used_at']);
  assert.equal(create.args[1].token_hash.primaryKey, true);
  assert.equal(create.args[1].used_at.notNull, undefined, 'NULL until used');
  assert.equal(create.args[1].expires_at.notNull, true);
  assert.equal('token' in create.args[1], false, 'the token itself is never a column');
  const t = 'tc_referral_link_tokens';
  assert.deepEqual(checksNamed(calls, `${t}_hash_check`), ["token_hash ~ '^[0-9a-f]{64}$'"]);
  assert.deepEqual(inList(checksNamed(calls, `${t}_office_check`)[0]), ['roland', 'valley']);
  assert.deepEqual(inList(checksNamed(calls, `${t}_audience_check`)[0]), ['specialist', 'patient']);
  assert.deepEqual(inList(checksNamed(calls, `${t}_purpose_check`)[0]), ['received', 'scheduled']);
  assert.deepEqual(checksNamed(calls, `${t}_patient_purpose_check`), ["audience <> 'patient' OR purpose = 'scheduled'"]);
  assert.deepEqual(checksNamed(calls, `${t}_expiry_check`), ['expires_at > created_at']);
  const fk = calls.find((c) => c.op === 'addConstraint' && c.args[1] === `${t}_referral_fk`).args[2].foreignKeys;
  assert.deepEqual(fk.columns, ['office_id', 'referral_id']);
  assert.equal(fk.references, 'tc_referrals(office_id, referral_id)');
  const unique = calls.find((c) => c.op === 'addConstraint' && c.args[1] === `${t}_one_per_kind`).args[2].unique;
  assert.deepEqual(unique, ['office_id', 'referral_id', 'audience', 'purpose']);
});

test('scheduled_date is one nullable date; no new referral status', () => {
  const calls = capture(migration);
  const adds = calls.filter((c) => c.op === 'addColumns');
  assert.deepEqual(adds.map((c) => [c.args[0], c.args[1]]), [['tc_referrals', { scheduled_date: { type: 'date' } }]]);
  const src = fs.readFileSync(`${MIGRATIONS_DIR}/${FILE}`, 'utf8').replace(/^\s*\*.*$/gm, '');
  assert.doesNotMatch(src, /tc_referrals_status_check|to_status_check|from_status_check/);
  assert.equal(contract.TcReferralStatus.options.length, 9);
});

test('the grant is role-guarded, revokes PUBLIC on the new table, and names exactly the three tables', () => {
  const sql = capture(migration).filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
  assert.match(sql, /REVOKE ALL ON TABLE %I FROM PUBLIC', 'tc_referral_link_tokens'/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /ARRAY\['tc_referral_link_tokens', 'tc_referrals', 'tc_referral_events'\]/);
  assert.deepEqual(migration.TABLES, ['tc_referral_link_tokens', 'tc_referrals', 'tc_referral_events']);
});

test("down() drops the table and column and restores R5's two CHECKs exactly, relabelling R5b rows first", () => {
  const calls = capture(migration, 'down');
  assert.ok(calls.some((c) => c.op === 'dropTable' && c.args[0] === 'tc_referral_link_tokens'));
  assert.ok(calls.some((c) => c.op === 'dropColumns' && c.args[0] === 'tc_referrals' && c.args[1].includes('scheduled_date')));
  const relabel = calls.findIndex(
    (c) =>
      c.op === 'sql' &&
      /SET verb = NULL, acs_message_id = NULL, recipient_address = NULL, unsubscribe_token_hash = NULL WHERE verb IN \('patient_scheduled', 'patient_email_sent', 'patient_email_skipped', 'patient_email_failed'\)/.test(
        String(c.args[0])
      )
  );
  const restoreVerb = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  const restoreFields = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_referral_events_send_fields_check');
  assert.ok(relabel > -1 && restoreVerb > relabel && restoreFields > relabel, 'relabel, then restore');
  const r5Calls = capture(r5);
  assert.equal(checksNamed(calls, 'tc_referral_events_verb_check')[0], checksNamed(r5Calls, 'tc_referral_events_verb_check')[0]);
  assert.equal(checksNamed(calls, 'tc_referral_events_send_fields_check')[0], checksNamed(r5Calls, 'tc_referral_events_send_fields_check')[0]);
});

test("numbered above develop's newest (1792400000000); filename order = numeric order; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.includes('1792400000000_tc_email_identity_referral_bcc.js'));
  assert.ok(files.indexOf(FILE) > files.indexOf('1792400000000_tc_email_identity_referral_bcc.js'));
  assert.ok(Number(FILE.split('_')[0]) > 1792400000000);
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('every column the links read and write exists once every migration has run', () => {
  const schema = buildTenantSchema();
  assert.ok(schema.get('tc_referrals').has('scheduled_date'));
  for (const c of ['token_hash', 'office_id', 'referral_id', 'audience', 'purpose', 'created_at', 'expires_at', 'used_at']) {
    assert.ok(schema.get('tc_referral_link_tokens').has(c), c);
  }
  const src = fs.readFileSync(`${__dirname}/../routes/tc/referralStore.js`, 'utf8');
  for (const c of ['scheduled_date', 'tc_referral_link_tokens', 'used_at', 'expires_at']) assert.match(src, new RegExp(c));
});
