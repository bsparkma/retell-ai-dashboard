'use strict';

/**
 * AT-0's tenant migration, 1794300000000_at0_note_history.js — the static
 * half. Every CHECK literal is INLINE in the migration; this file pins each to
 * the shared contract, pins the numbering, and pins that down() reverses up()
 * without stranding a row. The live half — the CHECKs, trigger and grants
 * evaluated by Postgres, and the real down()/up() with rows present — is
 * scripts/at0-note-history-verify-queries.js (a CI step).
 *
 * This is now the NEWEST migration to widen tc_case_events.type, so it is the
 * test that pins that CHECK against the WHOLE current CaseEventType.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const migration = require('../migrations-tenant/1794300000000_at0_note_history.js');
const contract = require('../tc/contract.gen.cjs');
const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
    dropIndex: rec('dropIndex'),
  };
  migration[direction](pgm);
  return calls;
}

function checkOf(calls, table, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[0] === table && x.args[1] === name);
  assert.ok(c, `no CHECK ${name} on ${table}`);
  return c.args[2].check;
}

/** The single-quoted IN-list of a CHECK. */
function inList(check) {
  const m = /IN \(([^)]+)\)/.exec(check);
  assert.ok(m, check);
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
}

test('tc_case_events.type CHECK equals the WHOLE current contract vocabulary', () => {
  assert.deepEqual(inList(checkOf(capture(), 'tc_case_events', 'tc_case_events_type_check')), contract.CaseEventType.options);
});

test('the widening is a strict superset: the previous list plus notes_updated, nothing else', () => {
  const after = inList(checkOf(capture('up'), 'tc_case_events', 'tc_case_events_type_check'));
  const before = inList(checkOf(capture('down'), 'tc_case_events', 'tc_case_events_type_check'));
  assert.deepEqual(after, [...before, 'notes_updated']);
  // The pre-slice list is exactly what item 47's migration told the database.
  const nurture = fs.readFileSync(`${MIGRATIONS_DIR}/1791100000000_tc_nurture.js`, 'utf8');
  for (const t of before) assert.ok(nurture.includes(`'${t}'`), `item 47's migration lists '${t}'`);
});

test('tc_preauth_events CHECKs equal the shared contract (office, type)', () => {
  const calls = capture();
  assert.deepEqual(inList(checkOf(calls, 'tc_preauth_events', 'tc_preauth_events_office_check')), contract.OfficeId.options);
  assert.deepEqual(inList(checkOf(calls, 'tc_preauth_events', 'tc_preauth_events_type_check')), contract.PreauthEventType.options);
  assert.equal(checkOf(calls, 'tc_preauth_events', 'tc_preauth_events_changes_check'), "jsonb_typeof(changes) = 'object'");
});

test('tc_preauth_events: office NOT NULL, NO foreign key to the pre-auth (history outlives the row), append-only grants', () => {
  const calls = capture();
  const t = calls.find((c) => c.op === 'createTable' && c.args[0] === 'tc_preauth_events').args[1];
  assert.equal(t.office_id.notNull, true);
  assert.equal(t.preauth_id.notNull, true);
  assert.equal(t.preauth_id.references, undefined, 'no FK — a deleted row must keep its history');
  assert.equal(t.changes.notNull, true);
  const grants = calls.filter((c) => c.op === 'sql' && /GRANT/.test(c.args[0])).map((c) => c.args[0]).join('\n');
  assert.match(grants, /GRANT SELECT, INSERT ON TABLE tc_preauth_events TO/);
  assert.doesNotMatch(grants, /UPDATE|DELETE/, 'the app role can never rewrite or erase history');
});

test('letter_snapshot: only on rows that record an email going out; the shape CHECK cannot pass on NULL; write-once trigger', () => {
  const calls = capture();
  assert.deepEqual(
    inList(checkOf(calls, 'tc_referral_events', 'tc_referral_events_letter_snapshot_verb_check')),
    ['send', 'send_conflict', 'patient_email_sent']
  );
  const shape = checkOf(calls, 'tc_referral_events', 'tc_referral_events_letter_snapshot_shape_check');
  assert.match(shape, /^letter_snapshot IS NULL OR COALESCE\(.*, false\)$/);
  assert.match(shape, /'specialist', 'patient'/);
  const sql = calls.filter((c) => c.op === 'sql').map((c) => c.args[0]).join('\n');
  assert.match(sql, /BEFORE UPDATE OF letter_snapshot ON tc_referral_events/);
  assert.match(sql, /IS DISTINCT FROM OLD\.letter_snapshot/);
});

test('down() reverses up(): keeps notes revisions as note_added, then narrows; drops the column, trigger, function and table', () => {
  const down = capture('down');
  const sqlIdx = down.findIndex((c) => c.op === 'sql' && /UPDATE tc_case_events/.test(c.args[0]));
  const narrowIdx = down.findIndex((c) => c.op === 'addConstraint' && c.args[1] === 'tc_case_events_type_check');
  assert.ok(sqlIdx >= 0 && sqlIdx < narrowIdx, 'rows are rewritten BEFORE the narrowed CHECK is added');
  const rewrite = down[sqlIdx].args[0];
  assert.match(rewrite, /SET type = 'note_added'/);
  assert.match(rewrite, /detail = NULL/);
  assert.match(rewrite, /left\(/, 'capped at the contract description length');
  assert.doesNotMatch(down.map((c) => JSON.stringify(c.args)).join('\n'), /DELETE FROM tc_case_events/);
  assert.ok(down.some((c) => c.op === 'dropTable' && c.args[0] === 'tc_preauth_events'));
  assert.ok(down.some((c) => c.op === 'dropColumns' && c.args[0] === 'tc_referral_events' && c.args[1].includes('letter_snapshot')));
  const sql = down.filter((c) => c.op === 'sql').map((c) => c.args[0]).join('\n');
  assert.match(sql, /DROP TRIGGER IF EXISTS tc_referral_events_letter_snapshot_write_once/);
  assert.match(sql, /DROP FUNCTION IF EXISTS tc_referral_events_letter_snapshot_write_once/);
});

test('numbered strictly above 1794200000000 and the newest; uniform width; unique; numeric order = filename order', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  assert.deepEqual([...files].sort(), [...files].sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0])));
  assert.ok(1794300000000 > 1794200000000);
  assert.equal(Math.max(...numbers), 1794300000000);
});

test('the store sees the new column and table once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  assert.ok(schema.get('tc_referral_events').has('letter_snapshot'));
  assert.deepEqual(
    [...schema.get('tc_preauth_events')].sort(),
    ['actor', 'changes', 'event_id', 'office_id', 'preauth_id', 'ts', 'type']
  );
});
