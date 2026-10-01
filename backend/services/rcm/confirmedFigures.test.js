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

/**
 * Every non-test, non-migration `.js` under `backend/`, as { path, source }.
 *
 * Migrations are excluded because they CREATE the table; test files because a
 * suite has to be able to build rows.
 */
function backendSources() {
  const backend = path.join(__dirname, '..', '..');
  /** @type {Array<{ rel: string, source: string }>} */
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'migrations' ||
        entry.name === 'migrations-tenant'
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
      files.push({
        rel: path.relative(backend, full).replace(/\\/g, '/'),
        source: fs.readFileSync(full, 'utf8'),
      });
    }
  };
  walk(backend);
  return files;
}

/*
 * WHY THE SCAN LOOKS FOR SQL AND NOT FOR THE NAME.
 *
 * A comment naming the table — "rows from rcm_eob_field_confirmations for this
 * batch" — is exactly the signposting that should be encouraged, and a scan that
 * banned it would teach people to describe the table without naming it. So both
 * patterns below require the table in a position only a query can put it.
 */
const READS_TABLE = /\b(?:from|join)\s+rcm_eob_field_confirmations\b/i;
const WRITES_TABLE = /\b(?:insert\s+into|update|delete\s+from)\s+rcm_eob_field_confirmations\b/i;

test('exactly ONE file reads rcm_eob_field_confirmations', () => {
  /*
   * The rule the slice rests on. A second reader would be a second opinion about
   * which number is real, and the two would diverge the first time either was
   * edited — which is exactly the class of defect that put a fabricated
   * $1,229.00 on a biller's screen.
   *
   * READS specifically, not writes: the invariant is about who gets to ANSWER
   * "which figure is real", and only a reader answers that. The writer is
   * pinned separately below.
   */
  const readers = backendSources()
    .filter((f) => READS_TABLE.test(f.source))
    .map((f) => f.rel);
  assert.deepEqual(
    readers,
    ['services/rcm/confirmedFigures.js'],
    `only confirmedFigures may read the table; everything else goes through figure(). Found: ${readers.join(', ')}`
  );
});

test('exactly ONE file writes rcm_eob_field_confirmations', () => {
  /*
   * The write lives in the route, not in the accessor, and that split is
   * deliberate: the accessor is a pure mapping with no I/O so the gate can
   * re-evaluate inside its own transaction and a test can drive it with no
   * database. Putting an INSERT in it would give it a client, a transaction and
   * a reason to be mocked.
   *
   * But there must be exactly one writer, or two routes could record a
   * confirmation with different ideas of what `state` means — and `state` is
   * what puts "corrected by <name>" under a figure.
   */
  const writers = backendSources()
    .filter((f) => WRITES_TABLE.test(f.source))
    .map((f) => f.rel);
  assert.deepEqual(
    writers,
    ['routes/rcm/fieldConfirm.js'],
    `only the confirm route may write the table. Found: ${writers.join(', ')}`
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

// ─── What a claim's lines ARE: read, minus struck, plus added ─────────────────

const ADDED = 'c7d41f08-2e5b-4a9c-b108-6f3a2d9e4b71';

function readLine(over = {}) {
  return {
    line_id: LINE,
    claim_id: CLAIM,
    position: 0,
    code: 'D2750',
    description: 'Crown - porcelain/ceramic',
    billed_cents: 131500,
    allowed_cents: 122900,
    deductible_cents: 0,
    copay_cents: 0,
    paid_cents: 15300,
    ...over,
  };
}

function typedLine(over = {}) {
  return {
    added_line_id: ADDED,
    claim_id: CLAIM,
    code: 'D0220',
    description: 'Intraoral periapical first film',
    billed_cents: 4200,
    allowed_cents: 3100,
    deductible_cents: 0,
    copay_cents: 0,
    paid_cents: 3100,
    added_by: 'user-key-1',
    added_at: new Date('2026-09-30T20:00:00.000Z'),
    ...over,
  };
}

function strikeRow(over = {}) {
  return {
    strike_id: '5a1c9e22-0b47-4d81-9e3f-7c2a6b8d4e90',
    claim_id: CLAIM,
    line_id: LINE,
    added_line_id: null,
    reason: 'A subtotal row, not a procedure.',
    struck_by: 'user-key-1',
    struck_at: new Date('2026-09-30T20:05:00.000Z'),
    withdrawn_at: null,
    withdrawn_by: null,
    ...over,
  };
}

/** The lines for one claim, through the one accessor. */
function linesFor({ extracted = [readLine()], added = [], strikes = [], rows = [] } = {}) {
  return confirmedFigures.effectiveLines({
    claimId: CLAIM,
    extracted,
    added: confirmedFigures.indexAddedLines(added),
    strikes: confirmedFigures.indexStrikes(strikes),
    index: confirmedFigures.indexConfirmations(rows),
  });
}

test('with nothing added and nothing struck, a claim is exactly what the read produced', () => {
  const lines = linesFor();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'extracted');
  assert.equal(lines[0].struck, null);
  assert.deepEqual(
    lines[0].fields.map((f) => f.field),
    ['line_paid', 'line_billed', 'line_allowed', 'line_deductible', 'line_copay']
  );
  const paid = lines[0].fields.find((f) => f.field === 'line_paid');
  assert.equal(paid.cents, 15300);
  assert.equal(paid.source, 'extracted');
  assert.equal(paid.confirmed, false);
});

test('an added line comes AFTER the read lines, in the order she typed them', () => {
  const second = typedLine({
    added_line_id: 'bb4e1a60-9c22-4f7d-83b1-0e5a6c7d8e90',
    code: 'D0274',
    added_at: new Date('2026-09-30T20:10:00.000Z'),
  });
  const lines = linesFor({ added: [typedLine(), second] });
  assert.deepEqual(
    lines.map((l) => `${l.kind}:${l.code}`),
    ['extracted:D2750', 'added:D0220', 'added:D0274']
  );
  // The position is where it sits in the list, not a claim about the page.
  assert.deepEqual(
    lines.map((l) => l.position),
    [0, 1, 2]
  );
});

test('every figure on an added line is typed, confirmed, and has no extraction behind it', () => {
  const [, added] = linesFor({ added: [typedLine()] });
  for (const f of added.fields) {
    assert.equal(f.source, 'added', `${f.field} is added, never corrected`);
    assert.equal(f.confirmed, true, 'typing it off the page IS the confirmation');
    assert.equal(f.extractedCents, null, 'the read produced no figure, not a blank one');
    assert.equal(f.confirmedByKey, 'user-key-1');
    assert.equal(f.confirmedAt, '2026-09-30T20:00:00.000Z');
  }
  const unstated = added.fields.find((f) => f.field === 'line_deductible');
  assert.equal(unstated.cents, 0, 'a typed zero is a figure she read');
  assert.equal(unstated.stated, true);
});

test('a typed NULL on an added line stays unstated, never a zero', () => {
  const [, added] = linesFor({ added: [typedLine({ allowed_cents: null })] });
  const allowed = added.fields.find((f) => f.field === 'line_allowed');
  assert.equal(allowed.cents, null);
  assert.equal(allowed.stated, false);
});

test('a struck line is RETURNED, marked, with the reason and who struck it', () => {
  const lines = linesFor({ strikes: [strikeRow()] });
  assert.equal(lines.length, 1, 'not dropped');
  assert.equal(lines[0].struck.reason, 'A subtotal row, not a procedure.');
  assert.equal(lines[0].struck.struckByKey, 'user-key-1');
  assert.equal(lines[0].struck.struckAt, '2026-09-30T20:05:00.000Z');
});

test('a WITHDRAWN strike is not a strike', () => {
  const lines = linesFor({ strikes: [strikeRow({ withdrawn_at: new Date(), withdrawn_by: 'u' })] });
  assert.equal(lines[0].struck, null);
});

test('a strike naming both targets, or neither, is ignored — the line keeps counting', () => {
  const both = linesFor({ strikes: [strikeRow({ added_line_id: ADDED })] });
  assert.equal(both[0].struck, null);
  const neither = linesFor({ strikes: [strikeRow({ line_id: null })] });
  assert.equal(neither[0].struck, null);
});

test('countableLines drops the struck ones and keeps the added ones', () => {
  const lines = linesFor({ added: [typedLine()], strikes: [strikeRow()] });
  const counted = confirmedFigures.countableLines(lines);
  assert.deepEqual(
    counted.map((l) => l.kind),
    ['added']
  );
  assert.equal(confirmedFigures.hasAddedLine(lines), true);
  assert.equal(confirmedFigures.hasAddedLine(linesFor()), false);
});

test('a struck added line is not countable either, and is not a hand-added line any more', () => {
  const lines = linesFor({
    added: [typedLine()],
    strikes: [strikeRow({ line_id: null, added_line_id: ADDED })],
  });
  assert.equal(confirmedFigures.countableLines(lines).length, 1, 'the read line only');
  assert.equal(confirmedFigures.hasAddedLine(lines), false);
});

// ─── What still has to be checked against the page ───────────────────────────

test('a struck line and an added line each ask for nothing', () => {
  const shape = [{ claimId: CLAIM, lines: linesFor({ added: [typedLine()], strikes: [strikeRow()] }) }];
  const required = confirmedFigures.requiredFields(shape);
  /*
   * The check total and the claim total, and nothing else. Demanding the five
   * figures on a line she has said is not on the page would leave a count that
   * could never reach zero — a wall — and demanding she confirm her own
   * transcription would be ceremony.
   */
  assert.deepEqual(
    required.map((r) => r.field),
    ['check_total', 'claim_total_paid']
  );
});

// ─── Does a claim add up? ────────────────────────────────────────────────────

function sumOf(args) {
  const lines = linesFor(args);
  return confirmedFigures.claimLineSum(confirmedFigures.indexConfirmations(args.rows || []), {
    claimId: CLAIM,
    totalPaidCents: args.totalPaidCents === undefined ? 18400 : args.totalPaidCents,
    lines,
  });
}

test('an incomplete read does not add up, and the difference is named', () => {
  const sum = sumOf({});
  assert.equal(sum.comparable, true);
  assert.equal(sum.lineSumCents, 15300);
  assert.equal(sum.claimTotalCents, 18400);
  assert.equal(sum.differenceCents, -3100);
  assert.equal(sum.ok, false);
});

test('ADDING THE MISSING LINE is what makes it add up', () => {
  const sum = sumOf({ added: [typedLine({ paid_cents: 3100 })] });
  assert.equal(sum.lineSumCents, 18400);
  assert.equal(sum.differenceCents, 0);
  assert.equal(sum.ok, true);
});

test('ONE CENT out is still out — there is no tolerance', () => {
  const sum = sumOf({ added: [typedLine({ paid_cents: 3099 })] });
  assert.equal(sum.ok, false);
  assert.equal(sum.differenceCents, -1);
});

test('an unstated line payment makes the sum unknowable, not zero', () => {
  const sum = sumOf({ extracted: [readLine({ paid_cents: null })] });
  assert.equal(sum.comparable, false);
  assert.equal(sum.lineSumCents, null);
  assert.equal(sum.differenceCents, null, 'no difference is invented from a missing figure');
  assert.equal(sum.ok, false, 'nobody has looked yet');
  assert.equal(sum.unconfirmedUnstatedCount, 1);
});

test('a CONFIRMED absence passes — the document states payment by category', () => {
  const sum = sumOf({
    extracted: [readLine({ paid_cents: null })],
    rows: [
      {
        claim_id: CLAIM,
        line_id: LINE,
        field: 'line_paid',
        state: 'confirmed',
        extracted_cents: null,
        confirmed_cents: null,
        confirmed_by: 'user-key-1',
        confirmed_at: null,
      },
    ],
  });
  assert.equal(sum.ok, true);
  assert.equal(sum.unstatedCount, 1);
  assert.equal(sum.unconfirmedUnstatedCount, 0);
});

test('a claim with every line struck cannot pass as payment-by-category', () => {
  // Nothing was checked against a page. The permissive branch is for a document
  // that states payment at a subtotal, not for one with no lines left.
  const sum = sumOf({ strikes: [strikeRow()] });
  assert.equal(sum.lineCount, 0);
  assert.equal(sum.ok, false);
});

test('a claim total that is not a figure cannot be compared against', () => {
  const sum = sumOf({ totalPaidCents: null });
  assert.equal(sum.comparable, false);
  assert.equal(sum.differenceCents, null);
  assert.equal(sum.ok, false);
});

// ─── The field→column mapping reads either spelling ──────────────────────────

test('extractedFor reads a raw pg row and an already-mapped one identically', () => {
  assert.equal(confirmedFigures.extractedFor('line_paid', { paid_cents: 15300 }), 15300);
  assert.equal(confirmedFigures.extractedFor('line_paid', { paidCents: 15300 }), 15300);
  /*
   * ONE mapping, read two ways. A second FIELD_COLUMNS keyed by camelCase is the
   * drift this avoids: the route and the gate must read the SAME extracted figure
   * for a field, or they will disagree about whether a confirmation is a
   * correction.
   */
  assert.equal(confirmedFigures.extractedFor('line_paid', {}), undefined);
  assert.equal(confirmedFigures.extractedFor('not_a_field', { paid_cents: 1 }), undefined);
});
