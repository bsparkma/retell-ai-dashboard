'use strict';

/**
 * R6.10's tenant migration, 1793200000000_tc_referral_chart_note: the
 * event-verb CHECK widened to R6.9's verbs + `chart_note_written` (equal to the
 * shared contract), the three nullable columns, the milestone vocabulary CHECK
 * (equal to the contract), the fields / status / note / ids CHECKs, the
 * one-per-milestone unique index, no new referral status, a clean down that
 * clears the facts IN the relabel and restores R6.9's verb CHECK exactly, and
 * numbered above develop's newest (1793100000000).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1793200000000_tc_referral_chart_note.js');
const r69 = require('../migrations-tenant/1793100000000_tc_referral_correspondence.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1793200000000_tc_referral_chart_note.js';
const T = 'tc_referral_events';

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

test('the verb CHECK is dropped and re-added, inline, equal to the contract: R6.9 verbs then `chart_note_written`', () => {
  const calls = capture(migration);
  const dropAt = calls.findIndex((c) => c.op === 'dropConstraint' && c.args[1] === `${T}_verb_check`);
  const addAt = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === `${T}_verb_check`);
  assert.ok(dropAt > -1 && addAt > dropAt, 'drop, then add');
  const [sql] = checksNamed(calls, `${T}_verb_check`);
  assert.match(sql, /^verb IS NULL OR verb IN \(/);
  assert.deepEqual(inList(sql), [...contract.TC_REFERRAL_ALL_EVENT_VERBS]);
  assert.deepEqual([...contract.TC_REFERRAL_ALL_EVENT_VERBS], [...contract.TC_REFERRAL_R69_EVENT_VERBS, 'chart_note_written']);
  assert.deepEqual([...contract.TC_REFERRAL_CHART_NOTE_EVENT_VERBS], ['chart_note_written']);
  // R6.9's own CHECK is exactly the frozen R6.9 list.
  assert.deepEqual(inList(checksNamed(capture(r69), `${T}_verb_check`)[0]), [...contract.TC_REFERRAL_R69_EVENT_VERBS]);
});

test('three nullable columns on tc_referral_events; no default, no backfill', () => {
  const calls = capture(migration);
  assert.deepEqual(
    calls.filter((c) => c.op === 'addColumns').map((c) => [c.args[0], c.args[1]]),
    [
      [
        T,
        {
          chart_note_milestone: { type: 'text' },
          chart_note_commlog_num: { type: 'bigint' },
          chart_note_comm_type: { type: 'integer' },
        },
      ],
    ]
  );
  assert.equal(calls.filter((c) => c.op === 'sql').length, 0, 'no UPDATE on the way up');
});

test('the milestone vocabulary CHECK is inline and equal to the contract', () => {
  const [sql] = checksNamed(capture(migration), `${T}_chart_note_milestone_check`);
  assert.match(sql, /^chart_note_milestone IS NULL OR /);
  assert.deepEqual(inList(sql), [...contract.TC_REFERRAL_CHART_MILESTONES]);
});

test('a chart note row carries all three facts and no other row any; never a move; note 1–2000; ids positive', () => {
  const calls = capture(migration);
  assert.deepEqual(checksNamed(calls, `${T}_chart_note_fields_check`), [
    "(verb IS NOT DISTINCT FROM 'chart_note_written' AND chart_note_milestone IS NOT NULL AND chart_note_commlog_num IS NOT NULL AND chart_note_comm_type IS NOT NULL) OR (verb IS DISTINCT FROM 'chart_note_written' AND chart_note_milestone IS NULL AND chart_note_commlog_num IS NULL AND chart_note_comm_type IS NULL)",
  ]);
  assert.deepEqual(checksNamed(calls, `${T}_chart_note_status_check`), [
    "verb IS DISTINCT FROM 'chart_note_written' OR from_status = to_status",
  ]);
  assert.deepEqual(checksNamed(calls, `${T}_chart_note_note_check`), [
    `verb IS DISTINCT FROM 'chart_note_written' OR char_length(btrim(note)) BETWEEN 1 AND ${contract.TC_REFERRAL_CHART_NOTE_MAX}`,
  ]);
  assert.deepEqual(checksNamed(calls, `${T}_chart_note_ids_check`), [
    '(chart_note_commlog_num IS NULL OR chart_note_commlog_num > 0) AND (chart_note_comm_type IS NULL OR chart_note_comm_type > 0)',
  ]);
});

test('one chart note per milestone per referral: a unique partial index on chart note rows only', () => {
  const idx = capture(migration).filter((c) => c.op === 'createIndex');
  assert.equal(idx.length, 1);
  assert.deepEqual(idx[0].args, [
    T,
    ['office_id', 'referral_id', 'chart_note_milestone'],
    { name: 'tc_referral_events_chart_note_once', unique: true, where: "verb = 'chart_note_written'" },
  ]);
});

test('no new referral status, no new table, no other CHECK touched', () => {
  const calls = capture(migration);
  assert.equal(calls.filter((c) => c.op === 'createTable').length, 0);
  const src = fs.readFileSync(`${MIGRATIONS_DIR}/${FILE}`, 'utf8').replace(/^\s*\*.*$/gm, '');
  assert.doesNotMatch(src, /tc_referrals_status_check|to_status_check|from_status_check|send_fields_check|correspondence_/);
  assert.equal(contract.TcReferralStatus.options.length, 9);
});

test("down() clears the facts IN the relabel, drops index / CHECKs / columns, and restores R6.9's verb CHECK exactly", () => {
  const calls = capture(migration, 'down');
  const relabel = calls.findIndex(
    (c) =>
      c.op === 'sql' &&
      String(c.args[0]) ===
        "UPDATE tc_referral_events SET verb = NULL, chart_note_milestone = NULL, chart_note_commlog_num = NULL, chart_note_comm_type = NULL WHERE verb = 'chart_note_written'"
  );
  const firstDrop = calls.findIndex((c) => c.op === 'dropConstraint' || c.op === 'dropIndex' || c.op === 'dropColumns');
  const dropCols = calls.findIndex((c) => c.op === 'dropColumns');
  const restore = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === `${T}_verb_check`);
  assert.ok(relabel > -1 && firstDrop > relabel && dropCols > relabel && restore > relabel, 'relabel first, while the CHECKs are live');
  assert.deepEqual(calls[dropCols].args[1], ['chart_note_milestone', 'chart_note_commlog_num', 'chart_note_comm_type']);
  assert.ok(calls.some((c) => c.op === 'dropIndex' && c.args[2] && c.args[2].name === 'tc_referral_events_chart_note_once'));
  const dropped = calls.filter((c) => c.op === 'dropConstraint').map((c) => c.args[1]);
  for (const n of ['milestone', 'fields', 'status', 'note', 'ids']) assert.ok(dropped.includes(`${T}_chart_note_${n}_check`), n);
  assert.equal(checksNamed(calls, `${T}_verb_check`)[0], checksNamed(capture(r69), `${T}_verb_check`)[0]);
});

test("numbered above develop's newest (1793100000000); unique; filename order = numeric order", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  assert.ok(files.includes(FILE));
  assert.ok(files.includes('1793100000000_tc_referral_correspondence.js'));
  const nums = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(nums).size, nums.length, 'unique numbers');
  assert.deepEqual([...nums].sort((a, b) => a - b), nums, 'filename order = numeric order');
  assert.ok(Number(FILE.split('_')[0]) > 1793100000000);
});

test('every column the store reads and writes exists once every migration has run', () => {
  const schema = buildTenantSchema();
  const cols = ['chart_note_milestone', 'chart_note_commlog_num', 'chart_note_comm_type'];
  for (const c of cols) assert.ok(schema.get(T).has(c), c);
  const src = fs.readFileSync(`${__dirname}/../routes/tc/referralStore.js`, 'utf8');
  for (const c of cols) assert.match(src, new RegExp(c));
});
