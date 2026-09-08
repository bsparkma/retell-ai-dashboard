'use strict';

/**
 * The module catalog must agree with the database.
 *
 * This is the one way config/modules.js can be wrong in a way nothing else
 * catches. The catalog decides which toggles the platform console renders; the
 * CHECK constraint in migrations/1785369600000_rename_module_carein_to_voice.js
 * decides which values the database will actually store. Let them drift and the
 * console grows a switch that 500s on click — which is exactly what had already
 * happened to platform/provisionTenant.js, whose local list still said 'carein'
 * two migrations after that name was retired.
 *
 * So the constraint is READ FROM THE MIGRATION SOURCE rather than restated here.
 * A test carrying its own copy of the list is a test that can drift too.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { MODULE_CATALOG, MODULE_NAMES, isKnownModule } = require('./modules');

/**
 * The namespaces the tenant_module CHECK constraint admits, as POSTGRES sees
 * them after every migration has run.
 *
 * Reads the migrations DIRECTORY in filename order and keeps the LAST `check:
 * "module IN (...)"` any of them declares, because that is what the database
 * ends up with: each such migration drops the constraint and re-adds it, so the
 * newest definition is the live one. An earlier version of this helper read one
 * NAMED migration, which was correct while exactly one migration had ever
 * defined the constraint — and would have gone permanently red the moment a
 * second module was added in a new migration, reporting drift that did not
 * exist and hiding drift that did.
 *
 * `down()` bodies also contain a `check:` (they restore the previous
 * vocabulary), so only the `up()` half of each file is scanned. A rollback's
 * narrower list is not what the database has after a forward migration.
 */
function namesFromMigration() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

  /** @type {string|null} */
  let latest = null;
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const up = src.slice(src.indexOf('exports.up'), src.indexOf('exports.down'));
    const scope = up.length > 0 ? up : src;
    // TEXT scan, so every migration must write its CHECK literal INLINE at the
    // addConstraint call. A hoisted `const CHECK = "module IN (...)"` referenced
    // by name inside up() would be invisible here and the guard would silently
    // grade the previous migration's vocabulary. 1788100000000 says so at the top.
    const matches = [...scope.matchAll(/"module IN \(([^)]*)\)"/g)];
    if (matches.length > 0) latest = matches[matches.length - 1][1];
  }

  assert.ok(latest, 'no migration declares a tenant_module module CHECK');
  return latest
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
    .sort();
}

test('the constraint is read from the NEWEST migration that defines it', () => {
  // Guards the helper above, not the catalog: if the scan silently fell back to
  // the original four-name migration, the agreement test below would still pass
  // for as long as the catalog also had four names, and would then fail for the
  // wrong reason on the next module. Naming a value the FIRST definition cannot
  // produce is what makes the scan itself testable.
  assert.ok(namesFromMigration().includes('hyg'), 'the hyg migration must be the one that wins');
});

test('the catalog names exactly the namespaces the CHECK constraint allows', () => {
  assert.deepEqual(
    [...MODULE_NAMES].sort(),
    namesFromMigration(),
    'a toggle the database will refuse is worse than no toggle'
  );
});

test("'carein' is gone — the pre-rename namespace must not come back", () => {
  assert.equal(isKnownModule('carein'), false);
  assert.equal(MODULE_NAMES.includes('carein'), false);
});

test('isKnownModule is total and fails closed', () => {
  // 'hyg' was on this list until it became a real module (migration
  // 1788100000000). 'perio' stands in as the next name nobody has registered.
  for (const bad of [null, undefined, '', 'VOICE', 'perio', 42, {}, ['voice']]) {
    assert.equal(isKnownModule(bad), false, `${JSON.stringify(bad)} must not pass`);
  }
  for (const good of MODULE_NAMES) assert.equal(isKnownModule(good), true);
});

test('every catalog entry carries the copy the console renders', () => {
  for (const entry of MODULE_CATALOG) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length > 0, `${entry.module} needs a label`);
    assert.ok(entry.blurb.length > 0, `${entry.module} needs a blurb`);
  }
});

test('the catalog is frozen — configuration, not runtime state', () => {
  assert.equal(Object.isFrozen(MODULE_CATALOG), true);
  assert.equal(Object.isFrozen(MODULE_NAMES), true);
});
