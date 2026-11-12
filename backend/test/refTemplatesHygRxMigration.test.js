'use strict';

/**
 * 1794500000000_ref_templates_hyg_rx — ONE tenant migration for two parts:
 *
 *   Part 1  tc_referral_templates: keyed by (office, kind), office CHECK
 *           ('roland','valley'), the two kinds, body ≤ 2000, SELECT / INSERT /
 *           UPDATE for carein_app and never DELETE.
 *   Part 2  hyg_visit.rx_needed (≤ 1000) and hyg_visit.pharmacy (≤ 200, one
 *           line), NOT NULL DEFAULT '', no grant change.
 *
 * The real-Postgres half (CHECKs evaluated, the real down() and up()) is
 * scripts/ref-templates-hyg-rx-verify-queries.js, which CI runs after migrate.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1794500000000_ref_templates_hyg_rx.js');
const templateStore = require('../routes/tc/referralTemplateStore');
const visitStore = require('../services/hyg/visitStore');
const tcContract = require('../tc/contract.gen.cjs');
const hygContract = require('../hyg/contract.gen.cjs');

const SELF = 1794500000000;

function capture(direction = 'up') {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const pgm = {
    func: (expr) => ({ __func: expr }),
    sql: rec('sql'),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
  };
  migration[direction](pgm);
  return calls;
}

test('part 1: one new table keyed by (office, kind), with exactly the stated columns', () => {
  const calls = capture();
  const tables = calls.filter((c) => c.op === 'createTable');
  assert.deepEqual(tables.map((c) => c.args[0]), ['tc_referral_templates']);
  assert.deepEqual(Object.keys(tables[0].args[1]).sort(), [...templateStore.COLS].sort());
  const pk = calls.find((c) => c.op === 'addConstraint' && c.args[2].primaryKey);
  assert.deepEqual(pk.args[2].primaryKey, ['office_id', 'template_kind']);
});

test("part 1: the CHECKs — office ('roland','valley'), the contract's kinds, the body cap", () => {
  const c = migration.TEMPLATE_CHECKS;
  assert.equal(c.tc_referral_templates_office_check, "office_id IN ('roland', 'valley')");
  for (const kind of tcContract.REFERRAL_TEMPLATE_KINDS) assert.ok(c.tc_referral_templates_kind_check.includes(`'${kind}'`), kind);
  assert.equal((c.tc_referral_templates_kind_check.match(/'/g) || []).length, tcContract.REFERRAL_TEMPLATE_KINDS.length * 2);
  const max = Number(/length\(body\) <= (\d+)/.exec(c.tc_referral_templates_body_length_check)[1]);
  assert.equal(max, tcContract.REFERRAL_TEMPLATE_BODY_MAX);
  assert.equal(tcContract.ReferralTemplateSaveRequest.safeParse({ body: 'x'.repeat(max) }).success, true);
  assert.equal(tcContract.ReferralTemplateSaveRequest.safeParse({ body: 'x'.repeat(max + 1) }).success, false);
});

test('part 1: carein_app gets SELECT, INSERT, UPDATE — never DELETE — and PUBLIC nothing', () => {
  const sql = capture().filter((c) => c.op === 'sql').map((c) => c.args[0]).join('\n');
  assert.match(sql, /REVOKE ALL ON TABLE tc_referral_templates FROM PUBLIC/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE tc_referral_templates TO %I/);
  assert.ok(!/DELETE/.test(sql));
});

test('part 2: two NOT NULL DEFAULT \'\' columns on hyg_visit, bounded as the contract is', () => {
  const calls = capture();
  const add = calls.filter((c) => c.op === 'addColumns');
  assert.equal(add.length, 1);
  assert.equal(add[0].args[0], 'hyg_visit');
  assert.deepEqual(Object.keys(add[0].args[1]).sort(), ['pharmacy', 'rx_needed']);
  for (const col of Object.values(add[0].args[1])) {
    assert.equal(col.notNull, true);
    assert.equal(col.default, '');
  }
  const c = migration.RX_CHECKS;
  const rxMax = Number(/length\(rx_needed\) <= (\d+)/.exec(c.hyg_visit_rx_needed_length_check)[1]);
  const phMax = Number(/length\(pharmacy\) <= (\d+)/.exec(c.hyg_visit_pharmacy_length_check)[1]);
  assert.equal(rxMax, hygContract.HYG_RX_NEEDED_MAX);
  assert.equal(phMax, hygContract.HYG_PHARMACY_MAX);
  assert.ok(c.hyg_visit_pharmacy_single_line_check.includes("position(E'\\n' in pharmacy) = 0"));
  assert.ok(c.hyg_visit_pharmacy_single_line_check.includes("position(E'\\r' in pharmacy) = 0"));
  // No grant change: hyg_visit's table-level grant (1788200000000) covers new columns.
  const sql = calls.filter((x) => x.op === 'sql').map((x) => x.args[0]).join('\n');
  assert.ok(!/hyg_visit/.test(sql));
});

test('touches no other table', () => {
  const touched = new Set(
    capture()
      .filter((c) => ['createTable', 'addConstraint', 'addColumns', 'dropTable', 'dropColumns', 'dropConstraint'].includes(c.op))
      .map((c) => c.args[0])
  );
  assert.deepEqual([...touched].sort(), ['hyg_visit', 'tc_referral_templates']);
});

test('down() undoes exactly what up() did', () => {
  const calls = capture('down');
  assert.deepEqual(
    calls.filter((c) => c.op === 'dropConstraint').map((c) => [c.args[0], c.args[1]]).sort(),
    Object.keys(migration.RX_CHECKS).map((n) => ['hyg_visit', n]).sort()
  );
  const cols = calls.find((c) => c.op === 'dropColumns');
  assert.equal(cols.args[0], 'hyg_visit');
  assert.deepEqual([...cols.args[1]].sort(), ['pharmacy', 'rx_needed']);
  assert.deepEqual(calls.filter((c) => c.op === 'dropTable').map((c) => c.args[0]), ['tc_referral_templates']);
  assert.equal(calls.filter((c) => c.op === 'createTable' || c.op === 'addColumns').length, 0);
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
  assert.ok(SELF > 1794400000000, "above develop's newest when this was written (CO-7 checkout questions)");
});

test('every column the stores read exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  const table = schema.get('tc_referral_templates');
  assert.ok(table, 'tc_referral_templates exists in the replayed schema');
  assert.deepEqual(templateStore.COLS.filter((c) => !table.has(c)), []);
  const visit = schema.get('hyg_visit');
  const named = visitStore.VISIT_COLUMNS.split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(named.includes('rx_needed') && named.includes('pharmacy'));
  assert.deepEqual(named.filter((c) => !visit.has(c)), []);
});
