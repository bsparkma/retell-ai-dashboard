'use strict';

/**
 * MT-2d: the office-settings parity tripwire is RETIRED, and stays retired.
 *
 * office_setting is the only table the ten per-office settings are written to
 * and served from, so there is nothing to compare. This pins that:
 *   - the module is gone and nothing in the running backend requires it;
 *   - no non-test source still prints the "office settings parity" log line;
 *   - officeSettings exposes no refresh-listener hook for one to re-attach to;
 *   - server.js arms nothing for it.
 * The office REGISTRY's parity tripwire (config/officeAgents.js,
 * config/odOffices.js) is a different thing and is NOT retired; it is pinned
 * here as still present so this test cannot be "fixed" by deleting it too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '__fixtures__', 'migrations', 'migrations-tenant', 'test']);

/** Every non-test .js/.cjs source file under backend/. */
function sourceFiles(dir = BACKEND, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (!/\.(c?js)$/.test(entry.name)) continue;
    if (/\.test\.c?js$/.test(entry.name) || /TestUtils\.js$/.test(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

test('the parity module is gone and no source requires it', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'officeSettingsParity.js')), false);
  const offenders = sourceFiles().filter((f) => /officeSettingsParity/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(BACKEND, f)), []);
});

test('no running source prints the "office settings parity" line', () => {
  const offenders = sourceFiles().filter((f) => /office settings parity/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(BACKEND, f)), []);
});

test('officeSettings has no refresh-listener hook any more', () => {
  const officeSettings = require('./officeSettings');
  assert.equal('onRefresh' in officeSettings, false);
});

test('server.js arms nothing for office-settings parity; the office REGISTRY parity remains', () => {
  const server = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /officeSettingsParity|settingsParity\.(arm|settled)/);
  assert.match(server, /officeRegistry\.refreshFromDb\(\)/, 'the registry read that feeds the registry parity stays');
  const agents = fs.readFileSync(path.join(BACKEND, 'config', 'officeAgents.js'), 'utf8');
  assert.match(agents, /officeRegistry\.onRefresh\(/, 'office registry parity listener is still registered');
});
