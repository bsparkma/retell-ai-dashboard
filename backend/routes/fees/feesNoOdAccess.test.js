'use strict';

/**
 * THE GUARD: slice 1 of the fee-schedule module reaches Open Dental in no way
 * at all — not to write, and not to read.
 *
 * Two layers, because either alone can be satisfied while the property is
 * false:
 *
 *  1. BEHAVIOURAL. Drive every route to success with `config/odOffices`,
 *     `config/openDental` and `mysql2` replaced by objects whose every property
 *     access throws. A route that touched one fails its test. A source scan
 *     alone would pass on a module that reached Open Dental through a name this
 *     file did not think to grep for.
 *  2. SOURCE SCAN. Read every file in routes/fees and services/fees and refuse
 *     an import of an Open Dental module or a MySQL driver. A behavioural test
 *     alone would pass on a module whose OD call sits on a branch no test
 *     reached — which is the branch it would sit on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN THE WRITE SLICE LANDS
 * ─────────────────────────────────────────────────────────────────────────────
 * It introduces exactly ONE writer file, and this test grows a one-file
 * allow-list naming it — the way RCM's and HYG's guards did. Deleting this test
 * is how a guard stops guarding, and widening the allow-list to a directory is
 * the same thing more slowly.
 *
 * The write slice ALSO goes through the office-keyed OD cloud API
 * (config/odOffices → the office's client), never MySQL. `mysql2` stays on the
 * forbidden list below permanently: the reference implementation this module's
 * parser came from did all of its work in raw MySQL against Open Dental, and
 * "port the rest of it" is the specific mistake this line exists to stop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withApp, api, filePart } = require('./feesTestUtils');
const fx = require('../../services/fees/feeFixtures');

// ─── 1. behavioural ─────────────────────────────────────────────────────────

/**
 * A stand-in whose every property access throws, including the ones a caller
 * would reach for by accident. A stub returning undefined would let a route
 * "succeed" while having called it.
 */
function tripwire(label) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        throw new Error(`[fees] reached ${label}.${String(prop)} — this slice must not touch Open Dental`);
      },
    }
  );
}

test('every route runs to success with Open Dental wired to a tripwire', async () => {
  const odOffices = require('../../config/odOffices');
  const openDental = require('../../config/openDental');

  const originals = new Map();
  const arm = (mod, label) => {
    const saved = {};
    for (const key of Object.keys(mod)) {
      saved[key] = mod[key];
      Object.defineProperty(mod, key, {
        configurable: true,
        get() {
          throw new Error(`[fees] reached ${label}.${key} — this slice must not touch Open Dental`);
        },
      });
    }
    originals.set(mod, saved);
  };

  arm(odOffices, 'odOffices');
  arm(openDental, 'openDental');

  try {
    await withApp({}, async (app) => {
      // POST, both lanes.
      const pdf = await api(app.baseUrl, 'POST', '/api/fees/imports?office=roland', {
        body: filePart(fx.syntheticFeePdf(fx.PDF_CLEAN), 'northstar.pdf', 'application/pdf'),
      });
      assert.equal(pdf.status, 201);

      const csv = await api(app.baseUrl, 'POST', '/api/fees/imports?office=valley', {
        body: filePart(Buffer.from(fx.CSV_CLEAN, 'utf8'), 'northstar.csv', 'text/csv'),
      });
      assert.equal(csv.status, 201);

      // The failure path too — a refusal is a code path like any other.
      const bad = await api(app.baseUrl, 'POST', '/api/fees/imports?office=roland', {
        body: filePart(Buffer.from(fx.CSV_AMBIGUOUS_FEE, 'utf8'), 'x.csv', 'text/csv'),
      });
      assert.equal(bad.status, 422);

      // GET, both shapes.
      const list = await api(app.baseUrl, 'GET', '/api/fees/imports?office=roland');
      assert.equal(list.status, 200);

      const detail = await api(
        app.baseUrl,
        'GET',
        `/api/fees/imports/${pdf.body.batch.batchId}?office=roland`
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.rows.length, 6);
    });
  } finally {
    for (const [mod, saved] of originals) {
      for (const [key, value] of Object.entries(saved)) {
        Object.defineProperty(mod, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value,
        });
      }
    }
  }
});

test('the tripwire itself trips — a guard that cannot fail is not a guard', () => {
  // Proves layer 1 can detect what it claims to. Without this, a Proxy that
  // silently returned undefined would make the test above pass unconditionally.
  assert.throws(() => tripwire('odOffices').getOdOffice, /must not touch Open Dental/);
});

// ─── 2. source scan ─────────────────────────────────────────────────────────

/** Every .js file under routes/fees and services/fees, tests excluded. */
function moduleSources() {
  const dirs = [__dirname, path.join(__dirname, '..', '..', 'services', 'fees')];
  /** @type {Array<{ file: string, src: string }>} */
  const out = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      // Test files and the test harness are exempt: the harness above requires
      // odOffices precisely in order to disarm it, and a guard that refused
      // that could not be written.
      if (name.endsWith('.test.js') || name === 'feesTestUtils.js') continue;
      out.push({ file: path.join(dir, name), src: fs.readFileSync(path.join(dir, name), 'utf8') });
    }
  }
  return out;
}

/**
 * Modules this slice must not import. Each is a distinct route to Open Dental,
 * and naming them individually is what makes a violation's message say which
 * one somebody reached for.
 */
const FORBIDDEN_IMPORTS = [
  'config/odOffices',
  'config/openDental',
  'platform/odAccess',
  'services/openDentalSync',
  'services/odClient',
  'mysql2',
  'mysql',
];

test('no file in this module imports Open Dental or a MySQL driver', () => {
  const sources = moduleSources();
  assert.ok(sources.length >= 6, `expected to scan the whole module, saw ${sources.length} files`);

  for (const { file, src } of sources) {
    // Strip block and line comments first: this file's own siblings DISCUSS
    // Open Dental at length, and a scan that counted prose would force the
    // comments explaining why there is no OD access to be deleted.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of FORBIDDEN_IMPORTS) {
      assert.equal(
        new RegExp(`require\\(['"\`][^'"\`]*${forbidden.replace(/\//g, '\\/')}`).test(code),
        false,
        `${path.basename(file)} must not require ${forbidden} — slice 1 reaches no Open Dental`
      );
    }
  }
});

test('no file in this module calls an Open Dental write verb', () => {
  // The office client's mutating verbs. RCM's and HYG's guards scan for the
  // same names; a call to one of these on ANY object is the signal, because the
  // object it is called on is exactly what a future refactor would rename.
  const WRITE_VERBS = ['apiPostRaw', 'apiPutRaw', 'apiDeleteRaw', 'apiPost', 'apiPut', 'apiDelete'];
  for (const { file, src } of moduleSources()) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const verb of WRITE_VERBS) {
      assert.equal(
        new RegExp(`\\.${verb}\\s*\\(`).test(code),
        false,
        `${path.basename(file)} calls ${verb} — slice 1 writes nothing to Open Dental`
      );
    }
  }
});

test('no file in this module writes to the filesystem', () => {
  // D8: the bytes go buffer → parser → out of scope. A fee schedule is an
  // executed payer contract, the container filesystem is ephemeral, and the one
  // mounted volume in prod is the call store's AzureFile share — a pile of
  // payer PDFs on either is a pile nobody scheduled for deletion. The reference
  // used multer diskStorage into `uploads/`.
  for (const { file, src } of moduleSources()) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const call of ['writeFile', 'writeFileSync', 'createWriteStream', 'diskStorage']) {
      assert.equal(
        new RegExp(`\\b${call}\\s*\\(`).test(code),
        false,
        `${path.basename(file)} calls ${call} — uploads are never written to disk`
      );
    }
  }
});
