'use strict';

/**
 * 1795400000000_tc_email_library_profile, read as source (the real-Postgres proof
 * is scripts/tc-email-library-verify-queries.js, run by CI after migrate).
 *
 *   - the office CHECK is the MT-2b2 format check, inline at addConstraint, and
 *     the migration names no office key
 *   - the app-role grant is SELECT, INSERT, UPDATE and never DELETE, role-guarded
 *   - the column set is exactly the brief's
 *   - its timestamp is unique among the tenant migrations
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const DIR = path.join(__dirname, '..', 'migrations-tenant');
const FILE = '1795400000000_tc_email_library_profile.js';
const src = fs.readFileSync(path.join(DIR, FILE), 'utf8');

/** A recording stand-in for node-pg-migrate's builder. */
function record() {
  const calls = [];
  const pgm = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'func') return (s) => ({ func: s });
        return (...args) => calls.push([name, ...args]);
      },
    }
  );
  return { pgm, calls };
}

test('the office CHECK is the inline format check; no office key is named', () => {
  assert.match(src, /addConstraint\(TABLE, 'tc_email_library_profile_office_check', \{\s*check: "office_id ~ '\^\[a-z\]\[a-z0-9_-\]\{1,31\}\$'",/);
  assert.ok(!/roland|valley/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no office key in code');
  const { pgm, calls } = record();
  require(path.join(DIR, FILE)).up(pgm);
  const office = calls.find((c) => c[0] === 'addConstraint' && c[2] === 'tc_email_library_profile_office_check');
  assert.equal(office[3].check, "office_id ~ '^[a-z][a-z0-9_-]{1,31}$'");
});

test('the columns are the brief: office_id PK, answers jsonb, library_version, updated_by, updated_at', () => {
  const { pgm, calls } = record();
  require(path.join(DIR, FILE)).up(pgm);
  const create = calls.find((c) => c[0] === 'createTable');
  assert.equal(create[1], 'tc_email_library_profile');
  const cols = create[2];
  assert.deepEqual(Object.keys(cols), ['office_id', 'answers', 'library_version', 'updated_by', 'updated_at']);
  assert.deepEqual(cols.office_id, { type: 'text', primaryKey: true });
  assert.equal(cols.answers.type, 'jsonb');
  assert.equal(cols.answers.notNull, true);
  assert.equal(cols.library_version.notNull, true);
  assert.equal(cols.updated_by.notNull, true);
  assert.equal(cols.updated_at.type, 'timestamptz');
});

test('the app role gets SELECT, INSERT, UPDATE only, behind a pg_roles guard', () => {
  const { pgm, calls } = record();
  require(path.join(DIR, FILE)).up(pgm);
  const sql = calls.filter((c) => c[0] === 'sql').map((c) => c[1]).join('\n');
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\) THEN/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I/);
  assert.ok(!/DELETE/i.test(sql), 'no DELETE grant');
  assert.match(sql, /REVOKE ALL ON TABLE %I FROM PUBLIC/);
});

test('the timestamp is unique among tenant migrations', () => {
  const stamps = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.js$/.test(f)).map((f) => f.split('_')[0]);
  assert.equal(stamps.filter((s) => s === '1795400000000').length, 1);
});
