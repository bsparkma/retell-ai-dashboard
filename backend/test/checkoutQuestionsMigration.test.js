'use strict';

/**
 * CO-7's tenant migration, 1794400000000_tc_checkout_questions: one new table,
 * its CHECKs (office, role, body length, a reply is never resolved), the FK to
 * the card, the thread index, the column-scoped grant (UPDATE of resolved_at
 * only — no DELETE), a clean down, numbered above every migration before it
 * with numeric order equal to filename order, and the store's columns all
 * present once every migration has run.
 *
 * The REAL up/down and the CHECKs and grants executed against Postgres are
 * scripts/checkout-questions-verify-queries.js (a CI step).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1794400000000_tc_checkout_questions.js');
const questionStore = require('../routes/tc/checkoutQuestionStore');

const SELF = 1794400000000;

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addConstraint: rec('addConstraint'),
    createIndex: rec('createIndex'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    dropConstraint: rec('dropConstraint'),
  };
  migration[direction](pgm);
  return calls;
}

test('one new table, exactly the specified columns; touches no existing table', () => {
  const calls = capture();
  const created = calls.filter((c) => c.op === 'createTable');
  assert.equal(created.length, 1);
  assert.equal(created[0].args[0], 'tc_checkout_questions');
  assert.deepEqual(Object.keys(created[0].args[1]), [
    'question_id',
    'office_id',
    'handoff_id',
    'author_email',
    'author_role',
    'body',
    'created_at',
    'resolved_at',
  ]);
  const cols = created[0].args[1];
  assert.equal(cols.handoff_id.references, 'tc_checkout_handoffs(handoff_id)');
  assert.notEqual(cols.resolved_at.notNull, true, 'resolved_at is nullable: open until resolved');
  for (const c of ['office_id', 'handoff_id', 'author_email', 'author_role', 'body', 'created_at']) {
    assert.equal(cols[c].notNull, true, c);
  }
  assert.equal(calls.filter((c) => c.op === 'addColumns' || c.op === 'dropColumns').length, 0);
  for (const c of calls.filter((x) => x.op === 'addConstraint' || x.op === 'createIndex')) {
    assert.equal(c.args[0], 'tc_checkout_questions');
  }
});

test("the CHECKs: office ('roland','valley'), role 'tc'|'hygienist', body 1..2000, a reply never resolved", () => {
  const checks = Object.fromEntries(
    capture()
      .filter((c) => c.op === 'addConstraint')
      .map((c) => [c.args[1], c.args[2].check])
  );
  assert.equal(checks.tc_checkout_questions_office_check, "office_id IN ('roland', 'valley')");
  assert.equal(checks.tc_checkout_questions_role_check, "author_role IN ('tc', 'hygienist')");
  assert.equal(checks.tc_checkout_questions_body_check, 'char_length(body) BETWEEN 1 AND 2000');
  assert.equal(checks.tc_checkout_questions_resolved_check, "resolved_at IS NULL OR author_role = 'tc'");
});

test('grants: SELECT + INSERT, UPDATE of resolved_at ONLY; no DELETE, no table-wide UPDATE', () => {
  const sql = capture()
    .filter((c) => c.op === 'sql')
    .map((c) => String(c.args[0]))
    .join('\n');
  assert.match(sql, /REVOKE ALL ON TABLE tc_checkout_questions FROM PUBLIC/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE tc_checkout_questions TO %I/);
  assert.match(sql, /GRANT UPDATE \(resolved_at\) ON TABLE tc_checkout_questions TO %I/);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE/);
  assert.doesNotMatch(sql, /GRANT (SELECT, INSERT, )?UPDATE ON/);
});

test('down() drops the table and nothing else', () => {
  const calls = capture('down');
  assert.deepEqual(
    calls.map((c) => [c.op, c.args[0]]),
    [['dropTable', 'tc_checkout_questions']]
  );
});

test('numbered above every earlier tenant migration; numeric order == filename order; unique; uniform width', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f));
  const numbers = files.map((f) => Number(f.split('_')[0]));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
  const byName = [...files].sort();
  const byNumber = [...files].sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
  assert.deepEqual(byName, byNumber);
  assert.ok(numbers.includes(SELF));
  assert.ok(SELF > 1794300000000, "above develop's newest when this was written (AT-0 note history)");
});

test('every column the store reads exists once every tenant migration has run', () => {
  const table = buildTenantSchema().get('tc_checkout_questions');
  assert.ok(table, 'tc_checkout_questions exists in the replayed schema');
  assert.deepEqual(questionStore.COLS.filter((c) => !table.has(c)), []);
});
