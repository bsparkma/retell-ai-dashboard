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

/** The namespaces the tenant_module CHECK constraint admits, per the migration. */
function namesFromMigration() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '1785369600000_rename_module_carein_to_voice.js'),
    'utf8'
  );
  const m = src.match(/check:\s*"module IN \(([^)]*)\)"/);
  assert.ok(m, 'could not find the tenant_module CHECK in the rename migration');
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
    .sort();
}

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
  for (const bad of [null, undefined, '', 'VOICE', 'hyg', 42, {}, ['voice']]) {
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
