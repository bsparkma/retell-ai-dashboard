'use strict';

/**
 * Item 47's tenant migration, 1791100000000_tc_nurture.js.
 *
 * Every CHECK literal is written INLINE in the migration; this file pins each
 * one to the shared contract the API, the engine and the screen use. It is
 * also the NEWEST migration to widen three shared CHECKs (tc_messages.status,
 * tc_case_events.type, tc_library_config.section), so it is the test that
 * pins those three against the WHOLE current contract enum — the older
 * migrations' tests pin only what they themselves told the database.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const migration = require('../migrations-tenant/1791100000000_tc_nurture.js');
const contract = require('../tc/contract.gen.cjs');
const nurtureStore = require('../services/tcNurture/store');
const messaging = require('../services/messaging');
const { buildTenantSchema } = require('../scripts/lib/tenantSchemaReplay');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-tenant');
const SELF = '1791100000000_tc_nurture.js';

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

/** The IN-list of the CHECK on `table` named `name`. */
function checkList(calls, table, name) {
  const c = calls.find((x) => x.op === 'addConstraint' && x.args[0] === table && x.args[1] === name);
  assert.ok(c, `no CHECK ${name} on ${table}`);
  const m = /IN \(([^)]+)\)/.exec(c.args[2].check);
  assert.ok(m, c.args[2].check);
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
}

test('enrollment CHECKs equal the shared contract enums', () => {
  const calls = capture();
  assert.deepEqual(
    checkList(calls, 'tc_nurture_enrollments', 'tc_nurture_enrollments_office_check'),
    contract.OfficeId.options
  );
  assert.deepEqual(
    checkList(calls, 'tc_nurture_enrollments', 'tc_nurture_enrollments_track_check'),
    contract.NurtureTrackKey.options
  );
  assert.deepEqual(
    checkList(calls, 'tc_nurture_enrollments', 'tc_nurture_enrollments_intensity_check'),
    contract.NurtureIntensity.options
  );
  assert.deepEqual(
    checkList(calls, 'tc_nurture_enrollments', 'tc_nurture_enrollments_status_check'),
    contract.NurtureEnrollmentStatus.options
  );
  assert.deepEqual(
    checkList(calls, 'tc_messages', 'tc_messages_consent_blocked_hint_check'),
    contract.NurtureConsentHint.options
  );
});

test('the three widened shared CHECKs equal the WHOLE current contract vocabulary', () => {
  const calls = capture();
  assert.deepEqual(checkList(calls, 'tc_messages', 'tc_messages_status_check'), contract.MessageStatus.options);
  assert.deepEqual(checkList(calls, 'tc_case_events', 'tc_case_events_type_check'), contract.CaseEventType.options);
  assert.deepEqual(
    checkList(calls, 'tc_library_config', 'tc_library_config_section_check'),
    Object.keys(contract.LibrarySectionSchemas)
  );
});

test('every widening is a strict superset of what came before (additive)', () => {
  const up = capture('up');
  const down = capture('down');
  const pairs = [
    ['tc_messages', 'tc_messages_status_check', ['skipped']],
    [
      'tc_case_events',
      'tc_case_events_type_check',
      ['nurture_paused', 'nurture_resumed', 'nurture_stopped', 'nurture_completed', 'nurture_touch_queued'],
    ],
    ['tc_library_config', 'tc_library_config_section_check', ['nurture_config']],
  ];
  for (const [table, name, added] of pairs) {
    const after = checkList(up, table, name);
    const before = checkList(down, table, name);
    assert.deepEqual(after, [...before, ...added], `${table}.${name}`);
  }
  // The pre-slice event vocabulary is the voice-handoff migration's list.
  const handoff = fs.readFileSync(path.join(MIGRATIONS_DIR, '1786500000000_tc_voice_handoff.js'), 'utf8');
  for (const t of checkList(down, 'tc_case_events', 'tc_case_events_type_check')) {
    assert.ok(handoff.includes(`'${t}'`), `voice handoff migration lists ${t}`);
  }
});

test('ONE ACTIVE enrollment per case is a partial UNIQUE index', () => {
  const idx = capture().find(
    (c) => c.op === 'createIndex' && c.args[2] && c.args[2].name === 'tc_nurture_enrollments_one_active_per_case'
  );
  assert.ok(idx);
  assert.equal(idx.args[0], 'tc_nurture_enrollments');
  assert.deepEqual(idx.args[1], ['case_id']);
  assert.equal(idx.args[2].unique, true);
  assert.equal(idx.args[2].where, "status = 'active'");
});

test('the enrollment table: office NOT NULL, case FK, stop needs a reason, index bounded by the 12-touch cap', () => {
  const calls = capture();
  const t = calls.find((c) => c.op === 'createTable' && c.args[0] === 'tc_nurture_enrollments').args[1];
  assert.equal(t.office_id.notNull, true);
  assert.equal(t.case_id.notNull, true);
  assert.equal(t.case_id.references, 'tc_cases');
  assert.equal(t.stop_reason.notNull, undefined);
  const checks = Object.fromEntries(
    calls.filter((c) => c.op === 'addConstraint').map((c) => [c.args[1], c.args[2].check])
  );
  assert.match(checks.tc_nurture_enrollments_stop_reason_check, /status <> 'stopped' OR/);
  assert.match(checks.tc_nurture_enrollments_index_check, new RegExp(`<= ${contract.NURTURE_CAPS.maxTouchesPerEnrollment}`));
});

test('tc_messages gains nullable columns only; enrollment_id is SET NULL', () => {
  const add = capture().find((c) => c.op === 'addColumns' && c.args[0] === 'tc_messages').args[1];
  assert.deepEqual(Object.keys(add).sort(), [
    'consent_blocked_hint',
    'enrollment_id',
    'skipped_at',
    'skipped_by',
    'touch_key',
  ]);
  for (const col of Object.values(add)) assert.notEqual(col.notNull, true);
  assert.equal(add.enrollment_id.references, 'tc_nurture_enrollments');
  assert.equal(add.enrollment_id.onDelete, 'SET NULL');
});

test('CHECK literals are inline at the addConstraint call', () => {
  const src = fs.readFileSync(path.join(MIGRATIONS_DIR, SELF), 'utf8');
  assert.match(src, /check: "track_key IN \('no_show_recovery', 'warm_followup', 'reactivation', 'large_case'\)"/);
  assert.match(src, /check: "intensity_at_enroll IN \('gentle', 'standard', 'assertive'\)"/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/tc\/contract/);
});

test('grants: the new table, CRUD, role-guarded', () => {
  assert.deepEqual(migration.TABLES, ['tc_nurture_enrollments']);
  const sql = capture().filter((c) => c.op === 'sql').map((c) => String(c.args[0])).join('\n');
  assert.match(sql, /ARRAY\['tc_nurture_enrollments'\]/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
});

test('down() removes the rows a narrowed CHECK would refuse, then the table', () => {
  const calls = capture('down');
  const sql = calls.filter((c) => c.op === 'sql').map((c) => String(c.args[0]));
  assert.ok(sql.some((s) => /DELETE FROM tc_case_events WHERE type IN \('nurture_paused'/.test(s)));
  assert.ok(sql.some((s) => s === "DELETE FROM tc_messages WHERE status = 'skipped'"));
  assert.ok(sql.some((s) => s === "DELETE FROM tc_library_config WHERE section = 'nurture_config'"));
  assert.ok(calls.some((c) => c.op === 'dropTable' && c.args[0] === 'tc_nurture_enrollments'));
});

test('sorts after everything applied on staging AND after open PR #238 (1791000000000)', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.js$/.test(f)).sort();
  const self = files.indexOf(SELF);
  assert.ok(self >= 0);
  assert.ok(self > files.indexOf('1790900000000_tc_library_opportunities_config.js'));
  assert.ok(Number(SELF.split('_')[0]) > 1791000000000);
});

test('every column the nurture slice reads exists after replaying all tenant migrations', () => {
  const schema = buildTenantSchema();
  const enr = schema.get('tc_nurture_enrollments');
  assert.ok(enr, 'replay found tc_nurture_enrollments');
  assert.deepEqual(nurtureStore.ENROLLMENT_COLS.filter((c) => !enr.has(c)), []);
  const msgs = schema.get('tc_messages');
  for (const c of [...messaging.MESSAGE_COLS, 'enrollment_id', 'touch_key', 'consent_blocked_hint', 'skipped_by', 'skipped_at']) {
    assert.ok(msgs.has(c), `tc_messages.${c}`);
  }
  const cases = schema.get('tc_cases');
  for (const c of ['case_id', 'office_id', 'patient_name', 'phone', 'email', 'status', 'nurture_unsubscribed', 'nurture_enrolled_at']) {
    assert.ok(cases.has(c), `tc_cases.${c}`);
  }
});
