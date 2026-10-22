'use strict';

/**
 * R5's tenant migration, 1792100000000_tc_referral_email: the event-verb CHECK
 * widened to R6's verbs + send / send_failed / send_conflict (equal to the
 * shared contract), the send columns and their all-or-nothing CHECK, the
 * one-email claim pair, a role-guarded grant, a clean down that restores R6's
 * CHECK exactly, and numbered after R6's.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792100000000_tc_referral_email.js');
const r6 = require('../migrations-tenant/1792000000000_tc_referral_r6.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792100000000_tc_referral_email.js';

function capture(mig, direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
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

function verbList(sql) {
  return /IN \(([^)]+)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

test('the verb CHECK is dropped and re-added, inline, equal to the contract: R6 verbs then the three send verbs', () => {
  const calls = capture(migration);
  const dropAt = calls.findIndex((c) => c.op === 'dropConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  const addAt = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  assert.ok(dropAt > -1 && addAt > dropAt, 'drop, then add');
  const [sql] = checksNamed(calls, 'tc_referral_events_verb_check');
  assert.match(sql, /^verb IS NULL OR verb IN \(/);
  assert.deepEqual(verbList(sql), [...contract.TC_REFERRAL_ALL_EVENT_VERBS]);
  assert.deepEqual(
    [...contract.TC_REFERRAL_ALL_EVENT_VERBS],
    [...contract.TC_REFERRAL_EVENT_VERBS, 'send', 'send_failed', 'send_conflict']
  );
});

test('send columns are nullable, all-or-nothing on send / send_conflict rows, and the token hash is unique where set', () => {
  const calls = capture(migration);
  const adds = calls.filter((c) => c.op === 'addColumns');
  assert.deepEqual(adds.map((c) => [c.args[0], Object.keys(c.args[1])]), [
    ['tc_referral_events', ['acs_message_id', 'recipient_address', 'unsubscribe_token_hash']],
    ['tc_referrals', ['send_attempt_id', 'send_attempt_at']],
  ]);
  for (const c of adds) for (const col of Object.values(c.args[1])) assert.notEqual(col.notNull, true);
  assert.deepEqual(checksNamed(calls, 'tc_referral_events_send_fields_check'), [
    "(verb IN ('send', 'send_conflict')) = (acs_message_id IS NOT NULL AND recipient_address IS NOT NULL AND unsubscribe_token_hash IS NOT NULL)",
  ]);
  assert.deepEqual(checksNamed(calls, 'tc_referrals_send_attempt_check'), [
    '(send_attempt_id IS NULL) = (send_attempt_at IS NULL)',
  ]);
  const idx = calls.filter((c) => c.op === 'createIndex');
  assert.equal(idx.length, 1);
  assert.deepEqual(idx[0].args[1], ['unsubscribe_token_hash']);
  assert.equal(idx[0].args[2].unique, true);
  assert.equal(idx[0].args[2].where, 'unsubscribe_token_hash IS NOT NULL');
});

test('the status CHECK is untouched', () => {
  const src = fs.readFileSync(`${MIGRATIONS_DIR}/${FILE}`, 'utf8');
  assert.doesNotMatch(src, /status_check|to_status|from_status/i);
});

test('the grant is role-guarded and names exactly the two tables', () => {
  const sql = capture(migration).filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /ARRAY\['tc_referrals', 'tc_referral_events'\]/);
  assert.deepEqual(migration.TABLES, ['tc_referrals', 'tc_referral_events']);
});

test("down() removes what up() added and restores R6's verb CHECK exactly, relabelling send rows first", () => {
  const calls = capture(migration, 'down');
  assert.deepEqual(
    calls.filter((c) => c.op === 'dropColumns').map((c) => [c.args[0], c.args[1]]),
    [
      ['tc_referrals', ['send_attempt_id', 'send_attempt_at']],
      ['tc_referral_events', ['acs_message_id', 'recipient_address', 'unsubscribe_token_hash']],
    ]
  );
  const relabel = calls.findIndex((c) => c.op === 'sql' && /SET verb = NULL WHERE verb IN \('send', 'send_failed', 'send_conflict'\)/.test(String(c.args[0])));
  const restore = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  assert.ok(relabel > -1 && restore > relabel, 'relabel, then restore');
  const [restored] = checksNamed(calls, 'tc_referral_events_verb_check');
  const [r6Check] = checksNamed(capture(r6), 'tc_referral_events_verb_check');
  assert.equal(restored, r6Check);
});

test("numbered after R6's; filename order = numeric order; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.ok(files.indexOf(FILE) > files.indexOf('1792000000000_tc_referral_r6.js'));
  assert.ok(Number(FILE.split('_')[0]) > 1792000000000);
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('every column the send writes and reads exists once every migration has run', () => {
  const schema = buildTenantSchema();
  for (const c of ['send_attempt_id', 'send_attempt_at']) assert.ok(schema.get('tc_referrals').has(c), c);
  for (const c of ['verb', 'acs_message_id', 'recipient_address', 'unsubscribe_token_hash']) {
    assert.ok(schema.get('tc_referral_events').has(c), c);
  }
  const src = fs.readFileSync(`${__dirname}/../routes/tc/referralStore.js`, 'utf8');
  for (const c of ['send_attempt_id', 'send_attempt_at', 'acs_message_id', 'recipient_address', 'unsubscribe_token_hash']) {
    assert.match(src, new RegExp(c), `the store names ${c}`);
  }
});
