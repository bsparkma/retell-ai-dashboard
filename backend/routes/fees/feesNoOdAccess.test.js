'use strict';

/**
 * THE GUARD: exactly ONE file in the fee schedule module may touch Open Dental.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT CHANGED IN SLICE 3, AND WHAT DID NOT
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 1's invariant was FLAT: nothing under routes/fees or services/fees
 * could reach Open Dental at all, and its header said the write slice would
 * "introduce exactly one writer file and this test will grow a one-file
 * allow-list, the way RCM's did — deleting the guard is how a guard stops
 * guarding."
 *
 * This is that edit. The allow-list is `ALLOWED` below and it has ONE entry.
 * What did NOT change:
 *
 *  - Every other file in the module is still forbidden the seam. A second file
 *    importing config/odOffices fails this suite.
 *  - `mysql2` / `mysql` stay banned ABSOLUTELY, for every file including the
 *    allow-listed one. The reference implementation did all of its work in raw
 *    MySQL against Open Dental, and "port the rest of it" is the specific
 *    mistake that ban exists to stop. It is not part of the allow-list and
 *    there is no version of this module in which it should be.
 *  - The ROUTES still reach Open Dental only through the writer. A route that
 *    grew its own client would fail, which is the shape of the regression this
 *    is really watching for.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE LAYERS, BECAUSE ANY ONE OF THEM PASSES WHILE THE PROPERTY IS FALSE
 * ═════════════════════════════════════════════════════════════════════════════
 *  1. SOURCE SCAN of every file except the allow-listed one — no OD import, no
 *     MySQL driver, no write verb, no filesystem write.
 *  2. THE ALLOW-LISTED FILE IS REAL and is the only way through: it exists, it
 *     names the seam, it asserts the office match, and the module's own callers
 *     reach Open Dental only by going through it.
 *  3. BEHAVIOURAL — the read/upload/preview routes still run to success with
 *     Open Dental wired to throwing tripwires. Parsing and previewing must not
 *     have acquired an Open Dental dependency just because posting exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withApp, api, filePart } = require('./feesTestUtils');
const fx = require('../../services/fees/feeFixtures');

// ─── THE ALLOW-LIST. One file, and this constant is the whole of it. ────────

/**
 * The only file in routes/fees or services/fees that may name the Open Dental
 * seam.
 *
 * Adding a second entry is not a refactor. It is a decision that the module now
 * has two places Open Dental can be reached from, and it belongs in a review
 * rather than typed here to make a suite go green.
 */
const ALLOWED = ['odFeesWrites.js'];

/**
 * Modules that ARE the Open Dental seam. Each is a distinct route to a
 * practice's database, named individually so a violation's message says which
 * one somebody reached for.
 */
const OD_IMPORTS = [
  'config/odOffices',
  'config/openDental',
  'platform/odAccess',
  'services/openDentalSync',
  'services/odClient',
];

/** Banned everywhere, allow-list included. See the header. */
const FORBIDDEN_ALWAYS = ['mysql2', 'mysql'];

/** The office client's mutating verbs. */
const WRITE_VERBS = ['apiWriteRaw', 'apiDeleteRaw', 'apiPostRaw', 'apiPutRaw'];

/** Every .js file under routes/fees and services/fees, tests excluded. */
function moduleSources() {
  const dirs = [__dirname, path.join(__dirname, '..', '..', 'services', 'fees')];
  /** @type {Array<{ file: string, name: string, src: string }>} */
  const out = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      // Test files and the test harness are exempt: the harness requires
      // odOffices precisely in order to disarm it, and a guard that refused
      // that could not be written.
      if (name.endsWith('.test.js') || name === 'feesTestUtils.js') continue;
      out.push({
        file: path.join(dir, name),
        name,
        src: fs.readFileSync(path.join(dir, name), 'utf8'),
      });
    }
  }
  return out;
}

/**
 * Strip comments before scanning.
 *
 * This module's files DISCUSS Open Dental at length — the allow-list is
 * explained in three headers — and a scan that counted prose would force the
 * comments explaining the rule to be deleted in order to satisfy it.
 */
function codeOf(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─── 1. source scan ─────────────────────────────────────────────────────────

test('only the allow-listed file imports the Open Dental seam', () => {
  const sources = moduleSources();
  assert.ok(sources.length >= 8, `expected to scan the whole module, saw ${sources.length} files`);

  for (const { name, src } of sources) {
    if (ALLOWED.includes(name)) continue;
    const code = codeOf(src);
    for (const seam of OD_IMPORTS) {
      assert.equal(
        new RegExp(`require\\(['"\`][^'"\`]*${seam.replace(/\//g, '\\/')}`).test(code),
        false,
        `${name} must not require ${seam} — only ${ALLOWED.join(', ')} may reach Open Dental`
      );
    }
  }
});

test('no file in this module imports a MySQL driver — allow-list included', () => {
  // Absolute, and deliberately NOT subject to the allow-list. Hard rule 6:
  // never write directly to Open Dental MySQL.
  for (const { name, src } of moduleSources()) {
    const code = codeOf(src);
    for (const driver of FORBIDDEN_ALWAYS) {
      assert.equal(
        new RegExp(`require\\(['"\`]${driver}['"\`]`).test(code),
        false,
        `${name} must not require ${driver} — the MySQL ban has no exceptions`
      );
    }
  }
});

test('only the allow-listed file names an Open Dental WRITE or DELETE verb', () => {
  for (const { name, src } of moduleSources()) {
    if (ALLOWED.includes(name)) continue;
    const code = codeOf(src);
    for (const verb of WRITE_VERBS) {
      assert.equal(
        new RegExp(`\\.${verb}\\s*\\(`).test(code),
        false,
        `${name} calls ${verb} — only ${ALLOWED.join(', ')} may write to Open Dental`
      );
    }
  }
});

test('no file in this module writes to the filesystem', () => {
  // Unchanged from slice 1: the bytes go buffer → parser → out of scope. A fee
  // schedule is an executed payer contract, the container filesystem is
  // ephemeral, and the one mounted volume in prod is the call store's AzureFile
  // share. The reference used multer diskStorage into `uploads/`.
  for (const { name, src } of moduleSources()) {
    const code = codeOf(src);
    for (const call of ['writeFile', 'writeFileSync', 'createWriteStream', 'diskStorage']) {
      assert.equal(
        new RegExp(`\\b${call}\\s*\\(`).test(code),
        false,
        `${name} calls ${call} — uploads are never written to disk`
      );
    }
  }
});

// ─── 2. the allow-listed file is real, and is the only way through ──────────

test('the allow-listed writer EXISTS and actually names the seam', () => {
  // An allow-list is only a guarantee if the file it names is real. One that
  // points at a deleted file permits nothing and proves nothing — and would
  // keep passing while the module reached Open Dental some other way.
  const sources = moduleSources();
  for (const allowed of ALLOWED) {
    const writer = sources.find((s) => s.name === allowed);
    assert.ok(writer, `${allowed} is on the allow-list but does not exist`);
    assert.match(
      codeOf(writer.src),
      /require\('\.\.\/\.\.\/config\/odOffices'\)/,
      `${allowed} is the allow-listed writer but does not reach the office-keyed seam`
    );
  }
});

test('the writer goes through the office-keyed registry, with the match asserted', () => {
  const writer = moduleSources().find((s) => s.name === 'odFeesWrites.js');
  const code = codeOf(writer.src);
  // `assertOfficeMatch(key, getOdOffice(key))` is the idiom the per-office slice
  // established and is the safety heart of this seam. A writer that called
  // getOdOffice WITHOUT the assertion would compile, work, and post one
  // practice's fee schedule into the other practice's database.
  assert.match(code, /assertOfficeMatch\(/, 'the writer must assert the office match');
  assert.match(code, /getOdOffice\(/, 'the writer must resolve the office handle');
});

test('the posting job and the posting routes reach Open Dental ONLY through the writer', () => {
  // The shape of the regression this is really watching for: a route or a
  // service that grew its own client because the writer was inconvenient.
  const sources = moduleSources();
  for (const name of ['postJob.js', 'posting.js']) {
    const file = sources.find((s) => s.name === name);
    assert.ok(file, `${name} is missing`);
    assert.match(
      codeOf(file.src),
      /require\(['"][^'"]*odFeesWrites['"]\)/,
      `${name} must reach Open Dental through the allow-listed writer`
    );
  }
});

test('nothing in the module auto-posts — review-then-send has no back door', () => {
  // The upload route must not reach the posting job, and no file may schedule
  // one. A "post automatically when the parse is clean" convenience is the one
  // change that would break this slice's central promise while looking helpful.
  const sources = moduleSources();
  const uploader = sources.find((s) => s.name === 'imports.js');
  assert.ok(uploader);
  assert.doesNotMatch(
    codeOf(uploader.src),
    /postJob|runPost|odFeesWrites/,
    'the upload route must not be able to start a post'
  );
  for (const { name, src } of sources) {
    assert.doesNotMatch(
      codeOf(src),
      /setInterval\s*\(|cron\.schedule\s*\(/,
      `${name} schedules something — posting is a human action, never a timer`
    );
  }
});

// ─── 3. behavioural: the READ surface still needs no Open Dental ────────────

test('upload, list and preview still run to success with Open Dental tripwired', async () => {
  // Parsing and previewing must not have acquired an Open Dental dependency
  // just because posting exists. These are the routes an office uses before it
  // has decided anything, and they should work when the practice's Open Dental
  // credentials are absent or its server is down.
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
          throw new Error(`[fees] reached ${label}.${key} — this surface must not touch Open Dental`);
        },
      });
    }
    originals.set(mod, saved);
  };

  arm(odOffices, 'odOffices');
  arm(openDental, 'openDental');

  try {
    await withApp({}, async (app) => {
      const pdf = await api(app.baseUrl, 'POST', '/api/fees/imports?office=roland', {
        body: filePart(fx.syntheticFeePdf(fx.PDF_CLEAN), 'northstar.pdf', 'application/pdf'),
      });
      assert.equal(pdf.status, 201);

      const bad = await api(app.baseUrl, 'POST', '/api/fees/imports?office=roland', {
        body: filePart(Buffer.from(fx.CSV_AMBIGUOUS_FEE, 'utf8'), 'x.csv', 'text/csv'),
      });
      assert.equal(bad.status, 422);

      const list = await api(app.baseUrl, 'GET', '/api/fees/imports?office=roland');
      assert.equal(list.status, 200);

      const detail = await api(
        app.baseUrl,
        'GET',
        `/api/fees/imports/${pdf.body.batch.batchId}?office=roland`
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.rows.length, 6);

      // And PROGRESS: an operator checking on a batch that has never been
      // posted is asking this platform's own database a question, and must not
      // be answered with an Open Dental outage.
      const progress = await api(
        app.baseUrl,
        'GET',
        `/api/fees/imports/${pdf.body.batch.batchId}/progress?office=roland`
      );
      assert.equal(progress.status, 200);
      assert.equal(progress.body.progress.rowsWritten, 0);
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
  const tripwire = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        throw new Error(`reached odOffices.${String(prop)} — must not touch Open Dental`);
      },
    }
  );
  assert.throws(() => tripwire.getOdOffice, /must not touch Open Dental/);
});
