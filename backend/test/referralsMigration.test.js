'use strict';

/**
 * Item 52's tenant migration, 1791800000000_tc_referrals: five new tables,
 * the status CHECK carrying EXACTLY the nine statuses (pinned equal to the
 * shared contract), every child bound to its parent by a composite office
 * FK, CHECK literals inline, a role-guarded grant, and a clean down.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildTenantSchema, MIGRATIONS_DIR } = require('../scripts/lib/tenantSchemaReplay');
const migration = require('../migrations-tenant/1791800000000_tc_referrals.js');
const contract = require('../tc/contract.gen.cjs');

const FILE = '1791800000000_tc_referrals.js';

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
    createIndex: rec('createIndex'),
  };
  migration[direction](pgm);
  return calls;
}

function check(calls, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[1] === name);
  assert.ok(c, name);
  return String(c.args[2].check);
}

function inList(sql) {
  return /IN \(([^)]+)\)/.exec(sql)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

test('five new tables; the only change to an existing table is a UNIQUE pair on tc_cases', () => {
  const calls = capture();
  assert.deepEqual(calls.filter((c) => c.op === 'createTable').map((c) => c.args[0]), migration.TABLES);
  assert.deepEqual(migration.TABLES, [
    'tc_referral_directory',
    'tc_referrals',
    'tc_referral_events',
    'tc_referral_attachments',
    'tc_referral_settings',
  ]);
  const touched = calls
    .filter((c) => ['addConstraint', 'createIndex'].includes(c.op) && !migration.TABLES.includes(c.args[0]))
    .map((c) => [c.op, c.args[0], c.args[1]]);
  assert.deepEqual(touched, [['addConstraint', 'tc_cases', 'tc_cases_office_case_unique']]);
  assert.ok(!calls.some((c) => c.op === 'sql' && /ALTER TABLE|audit_log|DROP/i.test(String(c.args[0]))));
});

test('the status CHECK carries EXACTLY the nine statuses, equal to the contract, inline', () => {
  const calls = capture();
  const nine = ['draft', 'pending_signoff', 'approved', 'sent', 'acknowledged', 'patient_seen', 'closed', 'declined', 'cancelled'];
  assert.deepEqual(inList(check(calls, 'tc_referrals_status_check')), nine);
  assert.deepEqual([...contract.TcReferralStatus.options], nine);
  assert.deepEqual(inList(check(calls, 'tc_referral_events_to_status_check')), nine);
  assert.match(check(calls, 'tc_referral_events_from_status_check'), /^from_status IS NULL OR from_status IN \(/);
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');
  assert.match(src, /'draft', 'pending_signoff', 'approved', 'sent', 'acknowledged', 'patient_seen', 'closed', 'declined', 'cancelled'/);
});

test('urgency, attachment type and office CHECKs equal the contract', () => {
  const calls = capture();
  assert.deepEqual(inList(check(calls, 'tc_referrals_urgency_check')), [...contract.TcReferralUrgency.options]);
  assert.deepEqual(inList(check(calls, 'tc_referral_attachments_type_check')), [...contract.TC_REFERRAL_ATTACHMENT_TYPES]);
  assert.match(check(calls, 'tc_referral_attachments_size_check'), new RegExp(`<= ${contract.TC_REFERRAL_ATTACHMENT_MAX_BYTES}`));
  for (const t of migration.TABLES) {
    assert.deepEqual(inList(check(calls, `${t}_office_check`)), ['roland', 'valley'], t);
  }
});

test('every child points at its parent through a composite (office_id, id) FK', () => {
  const calls = capture();
  const fk = (name) => calls.find((c) => c.args[1] === name).args[2].foreignKeys;
  assert.deepEqual(fk('tc_referrals_case_fk'), {
    columns: ['office_id', 'tc_case_id'],
    references: 'tc_cases(office_id, case_id)',
    onDelete: 'RESTRICT',
  });
  assert.deepEqual(fk('tc_referrals_directory_fk'), {
    columns: ['office_id', 'directory_entry_id'],
    references: 'tc_referral_directory(office_id, entry_id)',
    onDelete: 'RESTRICT',
  });
  for (const name of ['tc_referral_events_referral_fk', 'tc_referral_attachments_referral_fk']) {
    assert.deepEqual(fk(name), {
      columns: ['office_id', 'referral_id'],
      references: 'tc_referrals(office_id, referral_id)',
      onDelete: 'CASCADE',
    });
  }
});

test('the policy defaults are sign-off ON and auto-send OFF; the directory email CHECK matches the contract rule', () => {
  const calls = capture();
  const settings = calls.find((c) => c.op === 'createTable' && c.args[0] === 'tc_referral_settings').args[1];
  assert.equal(settings.signoff_required.default, true);
  assert.equal(settings.autosend_on_approval.default, false);
  const email = check(calls, 'tc_referral_directory_email_check');
  assert.match(email, /^email = '' OR email ~ /);
  assert.ok(contract.DIRECTORY_EMAIL_RE.test('a@b.co') && !contract.DIRECTORY_EMAIL_RE.test('a b@c.d'));
});

test('carein_app CRUD grant on all five, role-guarded', () => {
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /SELECT 1 FROM pg_roles WHERE rolname = r/);
  for (const t of migration.TABLES) assert.match(sql, new RegExp(`'${t}'`));
});

test('down() drops children before parents, and the tc_cases pair', () => {
  const calls = capture('down');
  assert.deepEqual(calls.filter((c) => c.op === 'dropTable').map((c) => c.args[0]), [
    'tc_referral_settings',
    'tc_referral_attachments',
    'tc_referral_events',
    'tc_referrals',
    'tc_referral_directory',
  ]);
  assert.ok(calls.some((c) => c.op === 'dropConstraint' && c.args[1] === 'tc_cases_office_case_unique'));
});

test("numbered after develop's newest (item 50b); uniform width; unique", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_/.test(f)).sort();
  const numbers = files.map((f) => Number(f.split('_')[0]));
  const mine = files.indexOf(FILE);
  const prev = files.indexOf('1791700000000_tc_checkout_attestation.js');
  assert.ok(prev >= 0 && mine > prev, 'sorts after 1791700000000_tc_checkout_attestation.js');
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, 'filename order = numeric order');
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(files.every((f) => f.split('_')[0].length === 13));
});

test('every column the routes read exists once every tenant migration has run', () => {
  const schema = buildTenantSchema();
  const { DIRECTORY_COLS } = require('../routes/tc/referralStore');
  for (const c of DIRECTORY_COLS) assert.ok(schema.get('tc_referral_directory').has(c), c);
  for (const c of ['office_id', 'signoff_required', 'autosend_on_approval', 'updated_by', 'updated_at']) {
    assert.ok(schema.get('tc_referral_settings').has(c), c);
  }
  for (const c of ['referral_id', 'office_id', 'directory_entry_id', 'status', 'status_changed_by']) {
    assert.ok(schema.get('tc_referrals').has(c), c);
  }
});
