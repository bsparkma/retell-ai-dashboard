'use strict';

/**
 * ITEM 20 — the designated test patients live in ONE place, and the switch that
 * limits hygiene writes to them resolves the way the brief says.
 *
 *   - config/testPatients.js is the only file that declares the list; the probe
 *     scripts and the hygiene gate import it. A second copy fails this suite.
 *   - The switch: on / off / anything else = ON / unset = ON only on staging.
 *
 * NO PHI: the numbers are the designated fixtures and a synthetic 4242424.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const tp = require('../config/testPatients');
const gate = require('../config/hygFixtureGate');

const BACKEND = path.join(__dirname, '..');

test('the list is frozen, office-keyed, and exactly the designated fixtures', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(tp.DESIGNATED_TEST_PATIENTS)), {
    roland: [12827, 12828],
    valley: [7115],
  });
  assert.ok(Object.isFrozen(tp.DESIGNATED_TEST_PATIENTS));
  assert.ok(Object.isFrozen(tp.DESIGNATED_TEST_PATIENTS.roland));
  assert.throws(() => {
    'use strict';
    tp.DESIGNATED_TEST_PATIENTS.roland.push(1);
  });
});

test('membership is (office, PatNum): 7115 is valley only, 11373 is nobody, strings of digits count', () => {
  assert.equal(tp.isDesignatedTestPatient('roland', 12827), true);
  assert.equal(tp.isDesignatedTestPatient('roland', '12828'), true);
  assert.equal(tp.isDesignatedTestPatient('valley', 7115), true);
  assert.equal(tp.isDesignatedTestPatient('roland', 7115), false, 'roland 7115 is a different, real person');
  assert.equal(tp.isDesignatedTestPatient('valley', 12827), false);
  assert.equal(tp.isDesignatedTestPatient('roland', 11373), false, '11373 was rejected as a fixture');
  assert.equal(tp.isDesignatedTestPatient('unknown', 12827), false);
  assert.equal(tp.isDesignatedTestPatient('constructor', 12827), false, 'no prototype keys');
  assert.equal(tp.isDesignatedTestPatient('roland', 12827.5), false);
  assert.equal(tp.isDesignatedTestPatient('roland', null), false);
});

test('11373 appears nowhere in the list file except the sentence saying it must not', () => {
  const src = fs.readFileSync(require.resolve('../config/testPatients'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /11373/);
});

test('ONE PLACE: no other backend file declares its own fixture list; the hyg probes import this one', () => {
  // A literal that pairs an office key with a fixture PatNum array is a list.
  const LIST = /\b(roland|valley)\s*:\s*(Object\.freeze\()?\s*\[\s*(12827|12828|7115)\b/;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(c|m)?js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) {
        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (LIST.test(code)) offenders.push(path.relative(BACKEND, full));
      }
    }
  };
  walk(BACKEND);
  assert.deepEqual(offenders, [path.join('config', 'testPatients.js')]);

  for (const script of [
    'scripts/diag-hyg-groupnotes.js',
    'scripts/probe-hyg-groupnote.js',
    'scripts/probe-hyg-perio-arch.js',
    'scripts/probe-hyg-perio-v2.js',
  ]) {
    const src = fs.readFileSync(path.join(BACKEND, script), 'utf8');
    assert.match(src, /config\/testPatients/, `${script} reads the shared list`);
  }
  const gateSrc = fs.readFileSync(require.resolve('../config/hygFixtureGate'), 'utf8');
  assert.match(gateSrc, /require\('\.\/testPatients'\)/);
});

test('the v2 probe narrows the shared list to roland 12828 and cannot widen it', () => {
  const probe = require('../scripts/probe-hyg-perio-v2');
  assert.deepEqual(JSON.parse(JSON.stringify(probe.FIXTURES)), { roland: [12828] });
  for (const [office, pats] of Object.entries(probe.FIXTURES)) {
    for (const p of pats) assert.ok(tp.isDesignatedTestPatient(office, p), `${office} ${p} is designated`);
  }
});

// ── the switch ──────────────────────────────────────────────────────────────

test('the switch: on / off, case and spaces ignored', () => {
  gate._resetWarningsForTests();
  assert.deepEqual(gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: 'on' }), { on: true, source: 'env', raw: 'on' });
  assert.equal(gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: ' ON ' }).on, true);
  assert.deepEqual(gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: 'off' }), { on: false, source: 'env', raw: 'off' });
  assert.equal(gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: 'Off' }).on, false);
  // Explicit wins over the staging default, in both directions.
  assert.equal(
    gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: 'off', AZURE_KEY_VAULT_NAME: 'kv-carein-staging' }).on,
    false
  );
  assert.equal(
    gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: 'on', AZURE_KEY_VAULT_NAME: 'kv-carein-prod' }).on,
    true
  );
});

test('the switch: ANY other value is ON (fail closed), and is said once, not per request', () => {
  gate._resetWarningsForTests();
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (const v of ['yes', 'true', 'false', '1', '0', '', 'of', 'onn', 'disabled']) {
      const r = gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: v, AZURE_KEY_VAULT_NAME: 'kv-carein-prod' });
      assert.deepEqual(r, { on: true, source: 'env-unrecognized', raw: v }, JSON.stringify(v));
    }
    gate.resolveFixturesOnly({ HYG_OD_WRITES_FIXTURES_ONLY: 'yes' });
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 9, 'once per distinct bad value');
  assert.match(warnings[0], /treating it as ON/);
});

test('the switch unset: ON on staging (by Key Vault name), OFF on prod, dev boxes and tests', () => {
  assert.deepEqual(gate.resolveFixturesOnly({ NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: 'kv-carein-staging' }), {
    on: true,
    source: 'staging-default',
    raw: null,
  });
  assert.equal(gate.resolveFixturesOnly({ NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: 'kv-carein-prod' }).on, false);
  assert.equal(gate.resolveFixturesOnly({ NODE_ENV: 'production' }).on, false, 'no vault named = not provably staging');
  assert.equal(gate.resolveFixturesOnly({}).on, false);
});

test('the gate: null for a test patient or when off; the 422 refusal otherwise', () => {
  const on = { HYG_OD_WRITES_FIXTURES_ONLY: 'on' };
  assert.equal(gate.refuseUnlessTestPatient({ office: 'roland', patNum: 12828, env: on }), null);
  assert.equal(gate.refuseUnlessTestPatient({ office: 'valley', patNum: 7115, env: on }), null);
  assert.equal(gate.refuseUnlessTestPatient({ office: 'roland', patNum: 4242424, env: {} }), null);
  const refused = gate.refuseUnlessTestPatient({ office: 'roland', patNum: 4242424, env: on });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 422);
  assert.equal(refused.code, 'HYG_TEST_PATIENTS_ONLY');
  assert.doesNotMatch(refused.error, /4242424/, 'the refusal never echoes the PatNum it refused');
});

test('the gate is read on every call — no boot-time cache', () => {
  const env = { HYG_OD_WRITES_FIXTURES_ONLY: 'off' };
  assert.equal(gate.refuseUnlessTestPatient({ office: 'roland', patNum: 4242424, env }), null);
  env.HYG_OD_WRITES_FIXTURES_ONLY = 'on';
  assert.notEqual(gate.refuseUnlessTestPatient({ office: 'roland', patNum: 4242424, env }), null);
});
