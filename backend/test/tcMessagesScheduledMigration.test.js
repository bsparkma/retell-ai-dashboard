'use strict';

/**
 * 1795600000000_tc_messages_scheduled (EL-2c), statically: what up() and
 * down() tell node-pg-migrate. The real-Postgres proof (every CHECK violation
 * refused, a real enroll-time pass, down() then up()) is
 * scripts/tc-nurture-approve-verify-queries.js, a CI step.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contract = require('../tc/contract.gen.cjs');
const messaging = require('../services/messaging');
const { buildTenantSchema } = require('../scripts/lib/tenantSchemaReplay');

const DIR = path.join(__dirname, '..', 'migrations-tenant');
const FILE = '1795600000000_tc_messages_scheduled.js';
const migration = require(path.join(DIR, FILE));

function record(direction) {
  const calls = [];
  const pgm = new Proxy(
    {},
    {
      get: (_t, op) => (...args) => {
        calls.push({ op: String(op), args });
      },
    }
  );
  migration[direction](pgm);
  return calls;
}

const literals = (check) => [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const constraint = (calls, name) => calls.find((c) => c.op === 'addConstraint' && c.args[1] === name);

test('status CHECK: the WHOLE contract vocabulary, a strict superset of 1791100000000 adding only scheduled', () => {
  const up = constraint(record('up'), migration.STATUS_CHECK);
  assert.ok(up);
  assert.deepEqual(literals(up.args[2].check), [...contract.MessageStatus.options]);
  const down = constraint(record('down'), migration.STATUS_CHECK);
  const before = literals(down.args[2].check);
  const after = literals(up.args[2].check);
  assert.ok(before.every((s) => after.includes(s)), 'superset');
  assert.deepEqual(after.filter((s) => !before.includes(s)), ['scheduled']);
  // And down() restores exactly what 1791100000000 wrote.
  const prior = fs.readFileSync(path.join(DIR, '1791100000000_tc_nurture.js'), 'utf8');
  assert.ok(prior.includes(migration.STATUS_BEFORE));
});

test('the scheduled CHECK is NULL-safe: every term two-valued, all four columns required', () => {
  const c = constraint(record('up'), migration.SCHEDULED_CHECK).args[2].check;
  assert.equal(
    c,
    "status IS DISTINCT FROM 'scheduled' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND scheduled_for IS NOT NULL AND enrollment_id IS NOT NULL)"
  );
  // No bare comparison that could evaluate to NULL (the #359 lesson).
  assert.doesNotMatch(c, /status\s*(=|<>|!=)\s*'scheduled'/);
});

test('skip_reason CHECK lists exactly the contract reasons, and only on a skipped row', () => {
  const c = constraint(record('up'), migration.SKIP_REASON_CHECK).args[2].check;
  assert.match(c, /^skip_reason IS NULL OR \(status = 'skipped' AND skip_reason IN \(/);
  assert.deepEqual(literals(c).filter((x) => x !== 'skipped'), [...contract.MessageSkipReason.options]);
});

test('columns, partial index, no grants; down() returns scheduled rows to draft FIRST, then narrows and drops', () => {
  const up = record('up');
  const cols = up.find((c) => c.op === 'addColumns');
  assert.deepEqual(Object.keys(cols.args[1]), ['scheduled_for', 'approved_by', 'approved_at', 'skip_reason']);
  assert.equal(cols.args[1].scheduled_for.type, 'timestamptz');
  assert.ok(Object.values(cols.args[1]).every((v) => v.notNull === false));
  const idx = up.find((c) => c.op === 'createIndex');
  assert.deepEqual(idx.args[1], ['office_id', 'scheduled_for']);
  assert.equal(idx.args[2].where, "status = 'scheduled'");
  assert.ok(!up.some((c) => c.op === 'sql'), 'no raw SQL, so no grants');

  const down = record('down');
  assert.equal(down[0].op, 'sql');
  assert.equal(down[0].args[0], "UPDATE tc_messages SET status = 'draft' WHERE status = 'scheduled'");
  const drop = down.find((c) => c.op === 'dropColumns');
  assert.deepEqual(drop.args[1], ['scheduled_for', 'approved_by', 'approved_at', 'skip_reason']);
  assert.ok(down.indexOf(drop) > down.findIndex((c) => c.op === 'addConstraint'));
});

test('numbering: sorts after 1795500000000 (PR #359)', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.indexOf(FILE) > files.indexOf('1795500000000_tc_nurture_library.js'));
});

test('every column the messaging service now reads exists after replaying all tenant migrations', () => {
  const schema = buildTenantSchema();
  const msgs = schema.get('tc_messages');
  assert.deepEqual(messaging.MESSAGE_COLS.filter((c) => !msgs.has(c)), []);
  for (const c of ['scheduled_for', 'approved_by', 'approved_at', 'skip_reason']) assert.ok(msgs.has(c), c);
});
