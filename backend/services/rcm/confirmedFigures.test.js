'use strict';

/**
 * THE ACCESSOR'S CONTRACT, and the rule that it is the only one.
 *
 * `confirmedFigures` decides confirmed-else-extracted for every surface that
 * renders or judges a money figure on a scanned EOB. Four of them need it — the
 * confirm screen, the match, the workbench verdict and the approval gate — and
 * the whole reason it exists is that four hand-written joins would disagree the
 * first time one was edited. Two screens disagreeing about a dollar figure is
 * the failure this module exists to make impossible.
 *
 * So there are two kinds of test here: the mapping's own behaviour, and a static
 * scan asserting nothing else in the module reads the table.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const confirmedFigures = require('./confirmedFigures');
const { CONFIRMABLE_FIELDS } = require('./rcmVocabulary');

const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const LINE = 'a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90';

/** One confirmation row, with only what a test cares about spelled out. */
function row(over = {}) {
  return {
    claim_id: CLAIM,
    line_id: LINE,
    field: 'line_paid',
    state: 'confirmed',
    extracted_cents: 5700,
    confirmed_cents: 5700,
    confirmed_by: 'user-key-1',
    confirmed_at: new Date('2026-09-30T01:00:00.000Z'),
    ...over,
  };
}

// ─── Three outcomes, not two ─────────────────────────────────────────────────

test('with no confirmation, the extracted figure is reported AS extracted', () => {
  const index = confirmedFigures.indexConfirmations([]);
  const f = confirmedFigures.figure(index, { claimId: CLAIM, lineId: LINE, field: 'line_paid' }, 5700);
  assert.deepEqual(f, {
    cents: 5700,
    stated: true,
    source: 'extracted',
    confirmed: false,
    extractedCents: 5700,
    confirmedByKey: null,
    confirmedAt: null,
  });
});

test('an unstated extracted figure is null and NOT stated — never a zero', () => {
  // The category-subtotal case. 0 would assert the plan paid nothing, which is a
  // claim about a patient's balance; null says nobody printed it.
  const index = confirmedFigures.indexConfirmations([]);
  const f = confirmedFigures.figure(index, { claimId: CLAIM, lineId: LINE, field: 'line_paid' }, null);
  assert.equal(f.cents, null);
  assert.equal(f.stated, false);
  assert.equal(f.confirmed, false);
});

test('a person confirming that the page states NOTHING is a real, confirmed answer', () => {
  /*
   * The distinction the whole slice turns on. `stated: false` with
   * `confirmed: true` means somebody looked at the page and there is genuinely
   * no per-line payment there — which a category-subtotal EOB does not have.
   * Demanding a number here would force an invention, which is the original bug.
   */
  const index = confirmedFigures.indexConfirmations([
    row({ extracted_cents: null, confirmed_cents: null }),
  ]);
  const f = confirmedFigures.figure(index, { claimId: CLAIM, lineId: LINE, field: 'line_paid' }, null);
  assert.equal(f.cents, null);
  assert.equal(f.stated, false);
  assert.equal(f.confirmed, true);
  assert.equal(f.source, 'confirmed');
  assert.equal(f.confirmedByKey, 'user-key-1');
  assert.equal(f.confirmedAt, '2026-09-30T01:00:00.000Z');
});

test('a correction wins over the extraction, and the original is still reported', () => {
  const index = confirmedFigures.indexConfirmations([
    row({ state: 'corrected', extracted_cents: 122900, confirmed_cents: 18400 }),
  ]);
  const f = confirmedFigures.figure(index, { claimId: CLAIM, lineId: LINE, field: 'line_paid' }, 122900);
  assert.equal(f.cents, 18400, 'the figure to USE is the one the person typed');
  assert.equal(f.source, 'corrected');
  assert.equal(f.extractedCents, 122900, 'and what the machine said is never lost');
});

test('the row\'s own extracted figure wins over the caller\'s, because a re-upload can rewrite the rows', () => {
  // "What did the machine say when she disagreed with it" is the question the
  // trail has to answer, and only the pinned column can answer it.
  const index = confirmedFigures.indexConfirmations([
    row({ state: 'corrected', extracted_cents: 122900, confirmed_cents: 18400 }),
  ]);
  const f = confirmedFigures.figure(index, { claimId: CLAIM, lineId: LINE, field: 'line_paid' }, 99999);
  assert.equal(f.extractedCents, 122900);
});

test('a bigint arriving as a string is still a number', () => {
  // pg returns bigint as a string. A figure compared with === against a number
  // would silently never match.
  const index = confirmedFigures.indexConfirmations([
    row({ extracted_cents: '5700', confirmed_cents: '5700' }),
  ]);
  const f = confirmedFigures.figure(index, { claimId: CLAIM, lineId: LINE, field: 'line_paid' }, '5700');
  assert.equal(f.cents, 5700);
  assert.equal(typeof f.cents, 'number');
});

// ─── Scope keys cannot collide ───────────────────────────────────────────────

test('a check-level field and a claim-level field never collide', () => {
  /*
   * `check_total` has no claim and no line; `claim_total_paid` has a claim. If
   * the key treated a missing id as absent rather than as a distinct value,
   * confirming one would read as confirming the other — and the anchor the whole
   * read reconciles to would be whatever was written last.
   */
  const index = confirmedFigures.indexConfirmations([
    row({ claim_id: null, line_id: null, field: 'check_total', extracted_cents: 18400, confirmed_cents: 18400 }),
    row({ claim_id: CLAIM, line_id: null, field: 'claim_total_paid', extracted_cents: 9200, confirmed_cents: 9200 }),
  ]);
  assert.equal(confirmedFigures.figure(index, { field: 'check_total' }, 18400).cents, 18400);
  assert.equal(
    confirmedFigures.figure(index, { claimId: CLAIM, field: 'claim_total_paid' }, 9200).cents,
    9200
  );
  // The same field on a DIFFERENT line is a different answer.
  assert.equal(
    confirmedFigures.figure(index, { claimId: CLAIM, lineId: 'other-line', field: 'line_paid' }, 111).source,
    'extracted'
  );
});

test('a row whose field is outside the vocabulary is DROPPED, not indexed', () => {
  /*
   * The DB CHECK makes this unreachable through the route, so a row carrying an
   * unknown slug means the constraint was bypassed — a restored dump, a hand-run
   * UPDATE, a half-rolled-back migration.
   *
   * Dropping it degrades to "unconfirmed", which withholds the check. Indexing
   * it would put an unvalidated slug — and a dollar figure — into the structure
   * the gate reconciles against a cheque.
   *
   * Asserted against the Map directly because it is not observable through
   * `figure()`: lookups are built from the vocabulary, so an unknown key is one
   * nothing ever asks for. That makes this a guard on the STRUCTURE, and the
   * structure is what a future caller would iterate.
   */
  const index = confirmedFigures.indexConfirmations([
    row({ field: 'line_invented' }),
    row({ field: '' }),
    row({ field: 'line_paid' }),
  ]);
  assert.equal(index.size, 1, 'only the vocabulary member is kept');
  const fields = [...index.values()].map((r) => r.field);
  assert.deepEqual(fields, ['line_paid']);
  for (const field of fields) {
    assert.ok(CONFIRMABLE_FIELDS.includes(field));
  }
});

test('a non-array of rows is an empty index rather than a crash', () => {
  for (const bad of [null, undefined, 'rows', 42, {}]) {
    assert.equal(confirmedFigures.indexConfirmations(bad).size, 0);
  }
});

// ─── What a check requires ───────────────────────────────────────────────────

test('what must be confirmed is DERIVED from the rows, never a maintained list', () => {
  const required = confirmedFigures.requiredFields([
    { claimId: CLAIM, lines: [{ lineId: LINE }, { lineId: 'line-2' }] },
    { claimId: 'claim-2', lines: [] },
  ]);
  // one check total + two claim totals + five line fields x two lines
  assert.equal(required.length, 1 + 2 + 5 * 2);
  assert.deepEqual(required[0], { claimId: null, lineId: null, field: 'check_total' });
  // Exactly the line-scoped members of the vocabulary, for each line.
  const forLine = required.filter((r) => r.lineId === LINE).map((r) => r.field).sort();
  assert.deepEqual(forLine, [...CONFIRMABLE_FIELDS.filter((f) => f.startsWith('line_'))].sort());
});

test('the outstanding count names the FIRST missing field, so a screen can jump to it', () => {
  const shape = [{ claimId: CLAIM, lines: [{ lineId: LINE }] }];
  const empty = confirmedFigures.allConfirmed(confirmedFigures.indexConfirmations([]), shape);
  assert.equal(empty.ok, false);
  assert.equal(empty.outstanding, 7);
  assert.deepEqual(empty.first, { claimId: null, lineId: null, field: 'check_total' });
});

// ─── Provenance ──────────────────────────────────────────────────────────────

test('only an OCR read needs confirming', () => {
  assert.equal(confirmedFigures.isOcrSourced({ textSource: 'ocr' }), true);
  assert.equal(confirmedFigures.isOcrSourced({ textSource: 'text_layer' }), false);
  // An 835 (nothing was read — the file was parsed) and a not-yet-extracted
  // document both arrive as null, and neither is OCR.
  assert.equal(confirmedFigures.isOcrSourced({ textSource: null }), false);
  assert.equal(confirmedFigures.isOcrSourced(null), false);
  assert.equal(confirmedFigures.isOcrSourced(undefined), false);
  assert.equal(confirmedFigures.isOcrSourced({}), false);
});

// ─── ONE ACCESSOR, and this is what enforces it ──────────────────────────────

test('nothing outside this module reads rcm_eob_field_confirmations', () => {
  /*
   * The rule the slice rests on. A second reader would be a second opinion about
   * which number is real, and the two would diverge the first time either was
   * edited — which is exactly the class of defect that put a fabricated
   * $1,229.00 on a biller's screen.
   *
   * Migrations are exempt: they CREATE the table. Test files are exempt so a
   * suite can build rows. Everything else must go through `figure()`.
   */
  const backend = path.join(__dirname, '..', '..');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'migrations' || entry.name === 'migrations-tenant') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.endsWith('.test.js')) continue;
      if (full === path.join(__dirname, 'confirmedFigures.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      /*
       * SQL USAGE, not any mention. A comment naming the table — "rows from
       * rcm_eob_field_confirmations for this batch" — is exactly the kind of
       * signposting that should be encouraged, and a scan that banned it would
       * teach people to describe the table without naming it.
       *
       * So the pattern is the table in a position only a query can put it:
       * after FROM, JOIN, INTO or UPDATE.
       */
      if (/\b(?:from|join|into|update)\s+rcm_eob_field_confirmations\b/i.test(source)) {
        offenders.push(path.relative(backend, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(backend);

  assert.deepEqual(
    offenders,
    [],
    `these files read rcm_eob_field_confirmations directly instead of going through ` +
      `confirmedFigures: ${offenders.join(', ')}`
  );
});

test('the module names its own queries, so CI can send them to a real Postgres', () => {
  // `scripts/rcm-verify-queries.js` executes every query in QUERIES against a
  // migrated database in CI, so an unknown column is a pipeline failure rather
  // than a 500 on a walk night.
  assert.ok(confirmedFigures.QUERIES.readForBatch.includes('rcm_eob_field_confirmations'));
  assert.ok(confirmedFigures.QUERIES.readForBatch.includes('office_id = $1'));
  assert.ok(confirmedFigures.QUERIES.readForBatch.includes('batch_id = $2'));
  assert.ok(
    !/SELECT\s+\*/i.test(confirmedFigures.QUERIES.readForBatch),
    'columns are named explicitly, per the repo rule'
  );
});
