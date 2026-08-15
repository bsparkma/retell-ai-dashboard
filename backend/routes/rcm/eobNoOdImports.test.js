'use strict';

/**
 * THE RCM MODULE DOES NOT TOUCH OPEN DENTAL — enforced, not asserted in prose.
 *
 * Slice 4 produces PROPOSALS: rows in rcm_* that a human reviews in Slice 7 and
 * that Slice 6 may then post. Between here and there sits a decision nobody has
 * made yet, so an OD client reachable from this module is not a shortcut — it is
 * the difference between "a machine read a document" and "a machine wrote to a
 * patient's chart".
 *
 * HOW THIS TEST WORKS. Static grepping of one file would miss a transitive
 * import, and reading a file's own requires would miss what those requires pull
 * in. So this walks the ACTUAL module graph: it requires the RCM router and the
 * extraction worker, then inspects Node's own module cache for anything under
 * the Open Dental surface. A helpful `require('../../config/odOffices')` three
 * files deep turns this red.
 *
 * When Slice 6 legitimately needs OD, it does NOT get added to the allow-list
 * here: it goes in a NEW module with its own gate, and this test keeps
 * guarding the ingestion path it was written for.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

/** Modules that would mean this graph can reach a patient's chart. */
const OD_SURFACE = [
  'config/odOffices',
  'config/openDental',
  'services/openDentalSync',
  'services/odHealthCheck',
  'platform/odAccess',
  'routes/opendental',
  'routes/opendentalSync',
  'services/officeAgents',
  'config/officeAgents',
];

/** Every currently-loaded module path, normalized to forward slashes. */
function loadedModules() {
  return Object.keys(require.cache).map((p) => p.split(path.sep).join('/'));
}

/** Load `id` into a clean-ish cache and report what OD modules came with it. */
function odModulesReachableFrom(id) {
  const before = new Set(loadedModules());
  require(id);
  return loadedModules()
    .filter((p) => !before.has(p))
    .filter((p) => !p.includes('/node_modules/'))
    .filter((p) => OD_SURFACE.some((od) => p.toLowerCase().includes(od.toLowerCase())));
}

test('the /api/rcm router graph contains no Open Dental module', () => {
  const found = odModulesReachableFrom('./index');
  assert.deepEqual(
    found,
    [],
    'routes/rcm must not reach Open Dental. Proposals are rows in rcm_*; ' +
      'writing to a chart is Slice 6, in its own module. Found: ' + found.join(', ')
  );
});

test('the extraction worker graph contains no Open Dental module', () => {
  const found = odModulesReachableFrom('../../services/rcm/eobExtractionWorker');
  assert.deepEqual(
    found,
    [],
    'the extraction worker must not reach Open Dental. Found: ' + found.join(', ')
  );
});

test('no rcm source file names an Open Dental module in a require', () => {
  // The graph walk above is the real guarantee; this is the cheap, readable
  // one that names the offending file directly when someone adds the import.
  const fs = require('node:fs');
  const roots = [__dirname, path.join(__dirname, '../../services/rcm')];
  const offenders = [];

  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(root, name), 'utf8');
      for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const target = m[1].toLowerCase();
        // `.test.js` files may legitimately NAME these modules in a list of
        // things to forbid — this very file does.
        if (name.endsWith('.test.js')) continue;
        if (
          target.includes('odoffices') ||
          target.includes('opendental') ||
          target.includes('odaccess') ||
          target.includes('officeagents')
        ) {
          offenders.push(`${path.basename(root)}/${name} → ${m[1]}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `Open Dental imports in the RCM module: ${offenders.join(', ')}`);
});

test('no rcm source writes to an Open Dental table or calls the OD API', () => {
  const fs = require('node:fs');
  const roots = [__dirname, path.join(__dirname, '../../services/rcm')];
  /** Words that only appear when someone is talking to Open Dental for real. */
  const SIGNALS = ['getOdOffice(', 'assertOfficeMatch(', 'commlog', 'claimproc', 'patnum'];
  const offenders = [];

  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(path.join(root, name), 'utf8');
      // Strip block and line comments — this file's own prose explains at
      // length why these calls are absent, and prose is not a call site.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const signal of SIGNALS) {
        if (code.toLowerCase().includes(signal.toLowerCase())) {
          offenders.push(`${path.basename(root)}/${name} → ${signal}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `Open Dental usage in the RCM module: ${offenders.join(', ')}`);
});
