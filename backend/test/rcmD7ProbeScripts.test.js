'use strict';

/**
 * THE TWO D-7 SCRIPTS ARE OPERATIONAL TOOLING THAT TOUCHES A LIVE PRACTICE
 * DATABASE. WHAT IS PINNED HERE IS HOW THEY BEHAVE WHEN THEY ARE *NOT* RUN.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS — two defects the 2026-08-24 staging run exposed
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The probe ran and PASSED (Riley is entitled on Insurance and Documents; the
 * sweep was clean). Running it is also what surfaced these two, and both had to
 * be fixed before that transcript could stand as §9(a) evidence — the canon for
 * these scripts is *"the thing that was run is the thing that was reviewed,"* and
 * what ran on the night needed a wrapper around it.
 *
 *   DEFECT 1 — NEITHER SCRIPT LOADED SECRETS.
 *   `config/odOffices` reads the per-office customer key from `process.env`, and
 *   only `server.js` ever called `loadSecrets()` to put it there. A standalone
 *   script never does, so the probe died on `OFFICE_OD_KEY_MISSING` before
 *   issuing anything. The operator worked around it with a `node -e` wrapper.
 *   A script whose documented invocation does not work is a script that gets
 *   improvised at the console, at a quiet hour, against a live chart database.
 *
 *   DEFECT 2 — THE READ SWEEP RE-RAN THE WRITE PROBE.
 *   The sweep imported `GHOST` from the probe, and the probe called `main()` at
 *   module load. So requiring it *re-issued every write verb*, interleaved with
 *   the sweep's reads. Harmless that night — same ghost id, same 404s — but a
 *   script named "read sweep" issued writes, and `rcmNoOdWrites.test.js` did not
 *   catch it because that guard scans for write VERBS, not for EXECUTION ON
 *   IMPORT. The verb was legitimately present in a file that legitimately owns
 *   it; the bug was that importing the file ran it.
 *
 * So the claims below are deliberately about the import boundary and the call
 * ORDER, which is what each defect actually was:
 *
 *   1. requiring either script reaches Open Dental zero times;
 *   2. `loadSecrets()` runs before the first `getOdOffice()` in both;
 *   3. neither script requires the other — the shared ghost id lives in its own
 *      one-constant module, so there is no file whose import can run anything.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WRITE_PROBE = require.resolve('../scripts/rcm-d7-write-probe.js');
const READ_SWEEP = require.resolve('../scripts/rcm-d7-read-sweep.js');
const GHOST_MODULE = require.resolve('../scripts/rcm-d7-ghost.js');
const OD_OFFICES = require.resolve('../config/odOffices.js');
const SECRETS = require.resolve('../config/secrets.js');

/**
 * Install a fake module into the require cache under a real resolved path, so a
 * `require('../config/odOffices')` inside the script under test gets this
 * instead. Returns a restore function.
 */
function stubModule(resolvedPath, exports) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    path: path.dirname(resolvedPath),
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
  return () => {
    if (previous) require.cache[resolvedPath] = previous;
    else delete require.cache[resolvedPath];
  };
}

/**
 * An office handle whose every reachable method records itself instead of
 * reaching Open Dental. Recording rather than throwing is deliberate: a throw
 * would be swallowed by the script's own error handling and could read as "no
 * call happened" when a call very much did.
 */
function recordingOdOffices(calls) {
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        // `handle.client.client` is the raw axios instance the probe reaches for.
        if (prop === 'client') return client;
        return (...args) => {
          calls.push(`client.${prop}(${args[0] === undefined ? '' : String(args[0])})`);
          return Promise.resolve({ ok: false, status: 404, data: [] });
        };
      },
    }
  );

  const handle = Object.freeze({
    officeKey: 'valley',
    officeName: 'Valley Fort Smith',
    commTypeDefNum: 451,
    client,
  });

  return {
    getOdOffice(key) {
      calls.push(`getOdOffice(${key})`);
      return handle;
    },
    assertOfficeMatch(key, h) {
      calls.push(`assertOfficeMatch(${key})`);
      return h;
    },
  };
}

/**
 * Load a script fresh with odOffices and secrets stubbed, hand it to `body`, and
 * only then restore.
 *
 * The stubs MUST outlive the require: the script's `require('../config/secrets')`
 * is deliberately lazy (inside main()), so it resolves when main() is CALLED, not
 * when the module is loaded. Restoring before then would silently hand main() the
 * real Key Vault loader and make this test prove nothing.
 */
async function withScript(scriptPath, { odOffices, secrets }, body) {
  const restoreOd = stubModule(OD_OFFICES, odOffices);
  const restoreSecrets = stubModule(SECRETS, secrets);
  delete require.cache[scriptPath];
  delete require.cache[GHOST_MODULE];
  try {
    return await body(require(scriptPath));
  } finally {
    delete require.cache[scriptPath];
    delete require.cache[GHOST_MODULE];
    restoreSecrets();
    restoreOd();
  }
}

/** Source with comments removed — prose may name a file the code must not require. */
function codeOf(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

for (const [label, scriptPath] of [
  ['rcm-d7-write-probe.js', WRITE_PROBE],
  ['rcm-d7-read-sweep.js', READ_SWEEP],
]) {
  test(`requiring ${label} issues zero Open Dental calls`, async () => {
    /*
     * This is defect 2 stated as a property rather than as a story about one
     * night: IMPORTING an operational script must not RUN it. The sweep is the
     * proximate reason — it imported the probe's ghost id — but the claim is
     * broader, because anything that requires one of these files (this test, a
     * future doc generator, a REPL) would otherwise fire live writes.
     */
    const calls = [];
    await withScript(
      scriptPath,
      {
        odOffices: recordingOdOffices(calls),
        secrets: { loadSecrets: async () => {} },
      },
      () => {}
    );
    assert.deepEqual(
      calls,
      [],
      `requiring ${label} reached Open Dental. Guard main() behind ` +
        '`require.main === module`. Calls: ' +
        calls.join(', ')
    );
  });

  test(`${label} calls loadSecrets before it touches odOffices`, async () => {
    /*
     * Defect 1. `customerKeyFor` reads `process.env` on every call, so the ORDER
     * is the whole of the fix: as long as loadSecrets() has resolved before the
     * first getOdOffice(), a top-level require of odOffices is fine.
     *
     * getOdOffice is made to throw so main() unwinds immediately — the order of
     * the two entries is the claim, and nothing after it needs to run.
     */
    const order = [];
    const sentinel = new Error('stub: stop here');
    await withScript(
      scriptPath,
      {
        odOffices: {
          getOdOffice() {
            order.push('getOdOffice');
            throw sentinel;
          },
          assertOfficeMatch: (_key, handle) => handle,
        },
        secrets: {
          loadSecrets: async () => {
            order.push('loadSecrets');
          },
        },
      },
      async (mod) => {
        assert.equal(
          typeof mod.main,
          'function',
          `${label} must export main() so this is testable`
        );
        await assert.rejects(
          () => mod.main(),
          (e) => e === sentinel
        );
      }
    );
    assert.deepEqual(
      order,
      ['loadSecrets', 'getOdOffice'],
      `${label} reached Open Dental config before the customer key was loaded from ` +
        'Key Vault. Order was: ' +
        order.join(' -> ')
    );
  });
}

test('the two D-7 scripts share the ghost id through a module that requires nothing', () => {
  /*
   * The fix for defect 2 is not only the `require.main` guard — it is also that
   * the sweep no longer has any reason to import the probe. One constant, no
   * requires, so importing it can never run anything. Keeping the ids in one
   * place still matters: two scripts disagreeing about which ids to check would
   * make the sweep worthless.
   */
  const ghost = require(GHOST_MODULE);
  assert.equal(ghost.GHOST, 999888777);

  assert.ok(
    !/\brequire\s*\(/.test(codeOf(GHOST_MODULE)),
    'the ghost module must require nothing — that is the whole point of it'
  );

  // What is banned is the IMPORT, not the mention. Both files legitimately name
  // the other — the probe's last line prints `NOW RUN: … rcm-d7-read-sweep.js`,
  // which is the operator instruction that makes the pair a pair. Telling a
  // human to run the next script is the opposite of running it on import.
  const probeCode = codeOf(WRITE_PROBE);
  const sweepCode = codeOf(READ_SWEEP);
  assert.ok(
    !/require\s*\(\s*['"][^'"]*rcm-d7-write-probe/.test(sweepCode),
    'the read sweep must not require the write probe — that is defect 2'
  );
  assert.ok(
    !/require\s*\(\s*['"][^'"]*rcm-d7-read-sweep/.test(probeCode),
    'and the probe must not require the sweep either'
  );
  for (const [label, code] of [
    ['probe', probeCode],
    ['sweep', sweepCode],
  ]) {
    assert.ok(
      code.includes("require('./rcm-d7-ghost')"),
      `the ${label} must take GHOST from the shared one-constant module`
    );
  }
});
