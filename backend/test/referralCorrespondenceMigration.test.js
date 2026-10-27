'use strict';

/**
 * R6.9's tenant migration, 1792800000000_tc_referral_correspondence: the
 * event-verb CHECK widened to R5b's verbs + `correspondence` (equal to the
 * shared contract), the three nullable columns and their vocabulary CHECKs
 * (equal to the contract), the fields / status / note CHECKs, no new referral
 * status, a clean down that restores R5b's verb CHECK exactly, and numbered
 * above develop's newest (1792700000000).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1792800000000_tc_referral_correspondence.js');
const r5b = require('../migrations-tenant/1792500000000_tc_referral_links.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1792800000000_tc_referral_correspondence.js';

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

test('the verb CHECK is dropped and re-added, inline, equal to the contract: R5b verbs then `correspondence`', () => {
  const calls = capture(migration);
  const dropAt = calls.findIndex((c) => c.op === 'dropConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  const addAt = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  assert.ok(dropAt > -1 && addAt > dropAt, 'drop, then add');
  const [sql] = checksNamed(calls, 'tc_referral_events_verb_check');
  assert.match(sql, /^verb IS NULL OR verb IN \(/);
  assert.deepEqual(inList(sql), [...contract.TC_REFERRAL_ALL_EVENT_VERBS]);
  assert.deepEqual([...contract.TC_REFERRAL_ALL_EVENT_VERBS], [...contract.TC_REFERRAL_R5B_EVENT_VERBS, 'correspondence']);
  assert.deepEqual([...contract.TC_REFERRAL_CORRESPONDENCE_EVENT_VERBS], ['correspondence']);
  // R5b's own CHECK is exactly the frozen R5B list.
  assert.deepEqual(inList(checksNamed(capture(r5b), 'tc_referral_events_verb_check')[0]), [...contract.TC_REFERRAL_R5B_EVENT_VERBS]);
});

test('three nullable text columns on tc_referral_events; no default, no backfill', () => {
  const calls = capture(migration);
  const adds = calls.filter((c) => c.op === 'addColumns');
  assert.deepEqual(
    adds.map((c) => [c.args[0], c.args[1]]),
    [
      [
        'tc_referral_events',
        {
          correspondence_direction: { type: 'text' },
          correspondence_party: { type: 'text' },
          correspondence_channel: { type: 'text' },
        },
      ],
    ]
  );
  assert.equal(calls.filter((c) => c.op === 'sql').length, 0, 'no UPDATE on the way up');
});

test("each column's vocabulary CHECK is inline and equal to the contract", () => {
  const calls = capture(migration);
  const t = 'tc_referral_events';
  assert.deepEqual(inList(checksNamed(calls, `${t}_correspondence_direction_check`)[0]), [...contract.TC_REFERRAL_CORRESPONDENCE_DIRECTIONS]);
  assert.deepEqual(inList(checksNamed(calls, `${t}_correspondence_party_check`)[0]), [...contract.TC_REFERRAL_CORRESPONDENCE_PARTIES]);
  assert.deepEqual(inList(checksNamed(calls, `${t}_correspondence_channel_check`)[0]), [...contract.TC_REFERRAL_CORRESPONDENCE_CHANNELS]);
  for (const c of ['direction', 'party', 'channel']) {
    assert.match(checksNamed(calls, `${t}_correspondence_${c}_check`)[0], new RegExp(`^correspondence_${c} IS NULL OR `));
  }
});

test('a correspondence row carries all three facts and no other row any; it is never a move; its note is 1–2000', () => {
  const calls = capture(migration);
  const t = 'tc_referral_events';
  assert.deepEqual(checksNamed(calls, `${t}_correspondence_fields_check`), [
    "(verb IS NOT DISTINCT FROM 'correspondence') = (correspondence_direction IS NOT NULL AND correspondence_party IS NOT NULL AND correspondence_channel IS NOT NULL)",
  ]);
  assert.deepEqual(checksNamed(calls, `${t}_correspondence_status_check`), [
    "verb IS DISTINCT FROM 'correspondence' OR from_status = to_status",
  ]);
  assert.deepEqual(checksNamed(calls, `${t}_correspondence_note_check`), [
    `verb IS DISTINCT FROM 'correspondence' OR char_length(btrim(note)) BETWEEN 1 AND ${contract.TC_REFERRAL_CORRESPONDENCE_NOTE_MAX}`,
  ]);
});

test('no new referral status, no new table, the send-fields CHECK untouched', () => {
  const calls = capture(migration);
  assert.equal(calls.filter((c) => c.op === 'createTable').length, 0);
  const src = fs.readFileSync(`${MIGRATIONS_DIR}/${FILE}`, 'utf8').replace(/^\s*\*.*$/gm, '');
  assert.doesNotMatch(src, /tc_referrals_status_check|to_status_check|from_status_check|send_fields_check|tc_referral_attachments/);
  assert.equal(contract.TcReferralStatus.options.length, 9);
});

test("down() relabels correspondence rows, drops the CHECKs and columns, and restores R5b's verb CHECK exactly", () => {
  const calls = capture(migration, 'down');
  const relabel = calls.findIndex(
    (c) => c.op === 'sql' && String(c.args[0]) === "UPDATE tc_referral_events SET verb = NULL, correspondence_direction = NULL, correspondence_party = NULL, correspondence_channel = NULL WHERE verb = 'correspondence'"
  );
  const dropCols = calls.findIndex((c) => c.op === 'dropColumns');
  const restore = calls.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_referral_events_verb_check');
  assert.ok(relabel > -1 && dropCols > relabel && restore > relabel, 'relabel first');
  assert.deepEqual(calls[dropCols].args[1], ['correspondence_direction', 'correspondence_party', 'correspondence_channel']);
  const dropped = calls.filter((c) => c.op === 'dropConstraint').map((c) => c.args[1]);
  for (const n of ['direction', 'party', 'channel', 'fields', 'status', 'note']) {
    assert.ok(dropped.includes(`tc_referral_events_correspondence_${n}_check`), n);
  }
  assert.equal(checksNamed(calls, 'tc_referral_events_verb_check')[0], checksNamed(capture(r5b), 'tc_referral_events_verb_check')[0]);
});

test("numbered above develop's newest (1792700000000); unique; filename order = numeric order", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  assert.ok(files.includes(FILE));
  assert.ok(files.includes('1792700000000_tc_provider_directory.js'));
  const nums = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(nums).size, nums.length, 'unique numbers');
  assert.deepEqual([...nums].sort((a, b) => a - b), nums, 'filename order = numeric order');
  assert.ok(Number(FILE.split('_')[0]) > 1792700000000);
});

test('every column the store reads and writes exists once every migration has run', () => {
  const schema = buildTenantSchema();
  for (const c of ['correspondence_direction', 'correspondence_party', 'correspondence_channel']) {
    assert.ok(schema.get('tc_referral_events').has(c), c);
  }
  const src = fs.readFileSync(`${__dirname}/../routes/tc/referralStore.js`, 'utf8');
  for (const c of ['correspondence_direction', 'correspondence_party', 'correspondence_channel']) assert.match(src, new RegExp(c));
});
