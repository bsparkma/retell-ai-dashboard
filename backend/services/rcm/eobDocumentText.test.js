'use strict';

/**
 * The seam: the only place a document becomes a string.
 *
 * Driven from the THREE COMMITTED FIXTURES in test/fixtures/rcm/eob, not from
 * PDFs built in the test body — the property under test is "what pdf-parse finds
 * in a real rasterised page", and a PDF written to have no text layer proves
 * nothing about a PDF that has no text layer because it is a picture.
 *
 * The claims:
 *   1. A TEXT-LAYER PDF NEVER CALLS OCR. Not "usually"; never. The escalation
 *      lives on the far side of a read that already failed, so a document that
 *      read successfully cannot reach it and cannot be billed for it.
 *   2. AN IMAGE-ONLY PDF DOES — and only when a provider is configured.
 *      Unconfigured, it fails exactly as it did before this slice.
 *   3. THE DEGRADED SCAN FAILS HONESTLY, with advice a person holding the paper
 *      can act on.
 *   4. THE A6 TRUNCATION REFUSAL COVERS THE OCR PATH. A scanned bulk EOB that
 *      silently lost its tail claims is the same defect with a new cause.
 *   5. A SPENT OCR BUDGET IS A PAUSE that never reaches Azure.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractPdfText,
  MAX_DOCUMENT_CHARS,
  OCR_CONFIDENCE_FLOOR,
  OCR_CONFIDENCE_UNUSABLE,
  assertFloorsOrdered,
  meaningfulTextLength,
  MIN_DOCUMENT_CHARS,
} = require('./eobDocumentText');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'rcm', 'eob');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const TEXT_LAYER = fixture('Test_EOB_TextLayer.pdf');
const SCANNED = fixture('Test_EOB_Scanned.pdf');
const DEGRADED = fixture('Test_EOB_Scanned_Degraded.pdf');

/**
 * A stub Document Intelligence, counting its own calls.
 *
 * The default answer is the one the REAL staging resource returned for
 * `Test_EOB_Scanned.pdf` on 2026-08-19 — 1 page, 77 words, 0.991 mean
 * confidence. Using the measured numbers rather than round ones means the
 * thresholds are tested against what the service actually does.
 */
function fakeOcr(overrides = {}) {
  const calls = { analyze: 0 };
  return {
    calls,
    isConfigured: () => overrides.configured !== false,
    analyze: async () => {
      calls.analyze++;
      if (overrides.error) throw overrides.error;
      return {
        text:
          overrides.text ??
          'EXAMPLE DENTAL PLAN - EXPLANATION OF BENEFITS\nCHECK NUMBER: CHK-100200\n' +
            'D0120 PERIODIC ORAL EVALUATION 59.00 57.00 57.00\nCHECK TOTAL PAID: 163.00',
        pages: overrides.pages ?? 1,
        meanConfidence: 'meanConfidence' in overrides ? overrides.meanConfidence : 0.9909,
        words: overrides.words ?? 77,
        model: 'prebuilt-read',
        elapsedMs: 2333,
      };
    },
  };
}

/** A stub cost rail that records what it was asked and what it was charged. */
function fakeBudget(overrides = {}) {
  const seen = { asserted: [], charged: [] };
  return {
    seen,
    assertAllowed(pages) {
      seen.asserted.push(pages);
      if (overrides.tripped) {
        const err = new Error('Document reading (OCR) daily budget exceeded ($2.00/day)');
        err.code = 'RCM_OCR_BUDGET_EXCEEDED';
        err.capCents = 200;
        err.usedCents = 200;
        err.resetsAt = '2026-08-20T05:00:00.000Z';
        throw err;
      }
    },
    charge(pages) {
      seen.charged.push(pages);
      return { chargedCents: 1, usedCents: 1, capCents: 200, pages };
    },
  };
}

// ─── 1. The trigger ──────────────────────────────────────────────────────────

test('a text-layer PDF is read from its text layer and NEVER calls OCR', async () => {
  const ocr = fakeOcr();
  const budget = fakeBudget();

  const doc = await extractPdfText(TEXT_LAYER, { ocr, ocrBudget: budget });

  assert.equal(doc.source, 'text_layer');
  assert.match(doc.text, /EXPLANATION OF BENEFITS/);
  assert.match(doc.text, /CHECK TOTAL PAID: 163.00/);
  assert.equal(doc.pages, 1);

  assert.equal(ocr.calls.analyze, 0, 'a document with a text layer must never be sent to OCR');
  assert.deepEqual(budget.seen.asserted, [], 'and the OCR rail is not even consulted');
  assert.deepEqual(budget.seen.charged, []);

  // Nothing about the reading to report, so nothing is asserted about it.
  assert.equal(doc.ocrPages, null);
  assert.equal(doc.ocrMeanConfidence, null);
  assert.deepEqual(doc.reviewReasons, []);
});

test('an image-only PDF escalates to OCR, and is priced by its page count first', async () => {
  const ocr = fakeOcr();
  const budget = fakeBudget();

  const doc = await extractPdfText(SCANNED, { ocr, ocrBudget: budget });

  assert.equal(doc.source, 'ocr');
  assert.equal(ocr.calls.analyze, 1);
  assert.match(doc.text, /EXPLANATION OF BENEFITS/);

  // The gate ran BEFORE the analyze call, with the page count from the PDF —
  // that ordering is what lets a document we cannot afford be refused rather
  // than half-read.
  assert.deepEqual(budget.seen.asserted, [1]);
  // ...and the CHARGE is Azure's own count, not the estimate.
  assert.deepEqual(budget.seen.charged, [1]);

  assert.equal(doc.ocrPages, 1);
  assert.ok(Math.abs(doc.ocrMeanConfidence - 0.9909) < 1e-9);
  assert.deepEqual(doc.reviewReasons, [], '0.99 is well above the floor — nothing to flag');
});

/**
 * An image-only PDF of N pages, built rather than fixtured.
 *
 * The committed scans are the real thing and are what the rest of this file
 * drives; the property HERE is what `pdf-parse` puts in the text layer of a page
 * that has none, which a hand-built blank page reproduces exactly — the real
 * one-page fixture and a hand-built one both yield the identical
 * `"-- 1 of 1 --"`. Committing a rasterised twelve-page scan to assert a string
 * about page furniture would be several hundred kilobytes for no extra proof.
 */
function blankPagesPdf(pageCount) {
  const kids = Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(' ');
  const pages = Array.from(
    { length: pageCount },
    (_, i) => `${i + 3} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n`
  ).join('');
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>endobj\n` +
      pages +
      'trailer<</Root 1 0 R>>\n',
    'latin1'
  );
}

test('a MULTI-PAGE scan escalates too — page furniture is not a text layer', async () => {
  /*
   * THE REGRESSION THIS PINS.
   *
   * `pdf-parse` stamps `-- 3 of 12 --` into the text of every page, ~16
   * characters, whether or not the page has any text. Measured against the raw
   * string, an image-only scan therefore crosses the 40-character floor on page
   * count alone:
   *
   *     1 page → 12 chars ✔ escalates      3 pages → 44 chars ✘ did not
   *     2 pages → 28 chars ✔ escalates     4 pages → 60 chars ✘ did not
   *
   * A three-page faxed EOB was thus treated as a text PDF, never sent to OCR,
   * and had its page markers sent to the extraction model as the document — a
   * paid call returning nothing, on exactly the multi-page scan this slice
   * exists to read. Both committed scan fixtures are ONE page, so nothing
   * noticed until the cost arithmetic needed a seven-page document.
   *
   * Every page count from 1 to 12, because the defect was a function of the
   * count and a spot check at one value is what let it through.
   */
  for (const pageCount of [1, 2, 3, 4, 5, 7, 12]) {
    const ocr = fakeOcr();
    const doc = await extractPdfText(blankPagesPdf(pageCount), {
      ocr,
      ocrBudget: fakeBudget(),
    });
    assert.equal(
      ocr.calls.analyze,
      1,
      `a ${pageCount}-page image-only PDF must reach OCR, not the extraction prompt`
    );
    assert.equal(doc.source, 'ocr');
  }
});

test('the page-marker pattern still matches what pdf-parse emits', async () => {
  // The pattern is pdf-parse's RENDERING, not a PDF standard. Pinned against the
  // real committed fixture so an upgrade that changes the format fails here,
  // loudly, rather than silently reverting the floor to counting furniture.
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: SCANNED });
  const parsed = await parser.getText();
  await parser.destroy();

  const rawText = (parsed.text || '').trim();
  assert.ok(rawText.length > 0, 'pdf-parse still emits SOMETHING for an image-only page');
  assert.match(rawText, /--\s*\d+\s+of\s+\d+\s*--/, 'and it is still the page marker');
  assert.equal(
    meaningfulTextLength(rawText),
    0,
    `page furniture must measure as zero real text; saw ${JSON.stringify(rawText)}`
  );
  assert.ok(meaningfulTextLength(rawText) < MIN_DOCUMENT_CHARS);
});

test('meaningfulTextLength strips furniture without touching real content', () => {
  assert.equal(meaningfulTextLength('-- 1 of 1 --'), 0);
  assert.equal(meaningfulTextLength('-- 1 of 3 --\n\n-- 2 of 3 --\n\n-- 3 of 3 --'), 0);
  // A real page keeps its content, and the marker is not counted toward it.
  assert.equal(meaningfulTextLength('-- 1 of 2 --\nPAID 163.00'), 'PAID163.00'.length);
  // A line that merely looks a bit like a marker is NOT furniture.
  assert.ok(meaningfulTextLength('-- 1 of 3 claims paid --') > 0);
});

test('with no OCR provider configured, a scan fails exactly as it did before', async () => {
  const ocr = fakeOcr({ configured: false });
  const budget = fakeBudget();

  await assert.rejects(
    () => extractPdfText(SCANNED, { ocr, ocrBudget: budget }),
    (err) => {
      assert.equal(err.code, 'NO_EXTRACTABLE_TEXT');
      assert.match(err.message, /scanned image/i);
      assert.match(err.message, /manually|text PDF/i, 'and says what to do instead');
      return true;
    }
  );
  assert.equal(ocr.calls.analyze, 0);
  assert.deepEqual(budget.seen.asserted, [], 'an unarmed environment spends nothing');
});

// ─── 2. Confidence ───────────────────────────────────────────────────────────

test('confidence below the floor widens review — it never resolves anything', async () => {
  const ocr = fakeOcr({ meanConfidence: OCR_CONFIDENCE_FLOOR - 0.05 });

  const doc = await extractPdfText(SCANNED, { ocr, ocrBudget: fakeBudget() });

  assert.deepEqual(doc.reviewReasons, ['ocr_low_confidence']);
  // The TEXT is unchanged. The reason is a fact about the reading, not an edit
  // to it — nothing was dropped, softened or re-read.
  assert.match(doc.text, /CHECK TOTAL PAID: 163.00/);
  assert.equal(doc.source, 'ocr');
});

test('confidence at or above the floor flags nothing', async () => {
  const doc = await extractPdfText(SCANNED, {
    ocr: fakeOcr({ meanConfidence: OCR_CONFIDENCE_FLOOR }),
    ocrBudget: fakeBudget(),
  });
  assert.deepEqual(doc.reviewReasons, []);
});

test('an unreported confidence flags nothing and is stored as unknown', async () => {
  const doc = await extractPdfText(SCANNED, {
    ocr: fakeOcr({ meanConfidence: null }),
    ocrBudget: fakeBudget(),
  });
  // We cannot say the reader was unsure, so we do not. We also do not say it was
  // sure: `null` reaches the screen as "not reported".
  assert.deepEqual(doc.reviewReasons, []);
  assert.equal(doc.ocrMeanConfidence, null);
});

// ─── 3. The scan we cannot read ──────────────────────────────────────────────

test('the degraded fixture fails honestly, with the rescan advice', async () => {
  // What the REAL staging resource returned for this fixture on 2026-08-19:
  // one page, one "word", four characters, 0.157 mean confidence. The fixture
  // is genuinely unreadable, not asserted to be.
  const ocr = fakeOcr({ text: 'ΠΑΓΩ', pages: 1, words: 1, meanConfidence: 0.157 });
  const budget = fakeBudget();

  await assert.rejects(
    () => extractPdfText(DEGRADED, { ocr, ocrBudget: budget }),
    (err) => {
      assert.equal(err.code, 'OCR_UNREADABLE');
      assert.match(err.message, /300 dpi/, 'the advice is specific enough to act on');
      assert.match(err.message, /rescan/i);
      assert.match(err.message, /manually/i, 'and offers the way out that always works');
      // Not a generic failure, and not a lie about what was read.
      assert.ok(!/unexpected|try again/i.test(err.message));
      return true;
    }
  );

  // The pages were still BILLED. Azure did the work; a rail that only counted
  // usable reads would under-report exactly on the documents that get retried.
  assert.deepEqual(budget.seen.charged, [1]);
});

test('exactly AT the refusal floor is annotated, not refused', async () => {
  // The refusal is `confidence < unusable`, so the boundary value itself belongs
  // to the annotate band. Pinned because an off-by-one here silently converts a
  // whole class of reviewable documents into rejections, and the only symptom
  // would be documents quietly not arriving.
  const doc = await extractPdfText(SCANNED, {
    ocr: fakeOcr({ meanConfidence: OCR_CONFIDENCE_UNUSABLE }),
    ocrBudget: fakeBudget(),
  });
  assert.equal(doc.source, 'ocr');
  // Below the review floor, so it is flagged — but it was NOT thrown away.
  assert.deepEqual(doc.reviewReasons, ['ocr_low_confidence']);
});

test('the two confidence floors must be ordered, and a container says so at startup', () => {
  // Ordered: fine, in every arrangement including equal.
  assert.equal(assertFloorsOrdered(0.85, 0.55), true);
  assert.equal(assertFloorsOrdered(0.6, 0.6), true, 'equal floors collapse the band but do not invert it');
  assert.equal(assertFloorsOrdered(1, 0), true);

  // Inverted: the refusal branch would swallow the entire annotate band, so
  // every document between the two values is REFUSED where the operator who set
  // them expected it flagged. Nothing downstream would say so.
  assert.throws(
    () => assertFloorsOrdered(0.55, 0.85),
    (err) => {
      assert.match(err.message, /RCM_OCR_UNUSABLE_CONFIDENCE/);
      assert.match(err.message, /RCM_OCR_MIN_CONFIDENCE/);
      // The message says which way to fix it, because "these are wrong" without
      // a direction is the same puzzle one step further on.
      assert.match(err.message, /Lower the refusal floor, or raise the review floor/);
      return true;
    }
  );
});

test('a readable-length but hopeless-confidence scan is refused, not annotated', async () => {
  const ocr = fakeOcr({ meanConfidence: OCR_CONFIDENCE_UNUSABLE - 0.05 });

  await assert.rejects(
    () => extractPdfText(SCANNED, { ocr, ocrBudget: fakeBudget() }),
    (err) => {
      assert.equal(err.code, 'OCR_UNREADABLE');
      // There is no review a human can do here: the amounts she would check
      // against are the same guesses. Widening review would be theatre.
      assert.match(err.message, /average confidence/i);
      assert.match(err.message, /300 dpi/);
      return true;
    }
  );
});

// ─── 4. A6, on the OCR path ──────────────────────────────────────────────────

test('the truncation refusal covers OCR — no partial proposal from a long scan', async () => {
  const ocr = fakeOcr({ text: 'D0120 PAID 57.00 '.repeat(9000), pages: 60 });

  await assert.rejects(
    () => extractPdfText(SCANNED, { ocr, ocrBudget: fakeBudget() }),
    (err) => {
      assert.equal(err.code, 'DOCUMENT_TOO_LARGE');
      assert.match(err.message, /read by OCR/, 'and says which reading overran');
      assert.match(err.message, /Split it/);
      assert.match(err.message, new RegExp(MAX_DOCUMENT_CHARS.toLocaleString()));
      return true;
    }
  );
});

test('the text-layer truncation refusal is unchanged', async () => {
  // Built rather than fixtured: the point is the LENGTH, and a 120k-character
  // fixture in the repo would be 120k characters of nothing.
  const long = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
      '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n' +
      '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
      (() => {
        const line = 'D0120 PERIODIC ORAL EVALUATION BILLED 59.00 ALLOWED 57.00 PAID 57.00';
        let stream = '';
        for (let i = 0; i < 2200; i++) stream += `BT /F1 8 Tf 10 700 Td (${line}) Tj ET\n`;
        return `5 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`;
      })() +
      'trailer<</Root 1 0 R>>\n',
    'latin1'
  );
  const ocr = fakeOcr();

  await assert.rejects(
    () => extractPdfText(long, { ocr, ocrBudget: fakeBudget() }),
    (err) => {
      assert.equal(err.code, 'DOCUMENT_TOO_LARGE');
      assert.match(err.message, /of text across/, 'the text-layer wording, not the OCR one');
      return true;
    }
  );
  assert.equal(ocr.calls.analyze, 0, 'and a long text layer is still a text layer');
});

// ─── 5. The cost rail ────────────────────────────────────────────────────────

test('a document bigger than the whole cap is refused TERMINALLY, not paused', async () => {
  const ocr = fakeOcr();
  // The gate's other answer: not "come back after the reset" but "no reset will
  // ever admit this". The seam just propagates it; the worker is what turns the
  // two codes into a pause and a failure respectively.
  const budget = {
    seen: { asserted: [], charged: [] },
    assertAllowed(pages) {
      this.seen.asserted.push(pages);
      const err = new Error(
        'This document needs 30¢ of OCR, which is more than the entire daily cap of $0.10. ' +
          'Waiting will not help.'
      );
      err.code = 'RCM_OCR_DOCUMENT_EXCEEDS_CAP';
      err.estimatedCents = 30;
      err.capCents = 10;
      throw err;
    },
    charge(pages) {
      this.seen.charged.push(pages);
      return { chargedCents: 0, usedCents: 0, capCents: 10, pages };
    },
  };

  await assert.rejects(
    () => extractPdfText(SCANNED, { ocr, ocrBudget: budget }),
    (err) => {
      assert.equal(err.code, 'RCM_OCR_DOCUMENT_EXCEEDS_CAP');
      assert.equal(err.resetsAt, undefined, 'no reset is promised, because none would help');
      return true;
    }
  );
  assert.equal(ocr.calls.analyze, 0);
  assert.deepEqual(budget.seen.charged, []);
});

test('a spent OCR budget stops the document BEFORE Azure, and is not a failure', async () => {
  const ocr = fakeOcr();
  const budget = fakeBudget({ tripped: true });

  await assert.rejects(
    () => extractPdfText(SCANNED, { ocr, ocrBudget: budget }),
    (err) => {
      // A distinct code, so the worker can PARK the upload rather than fail it.
      assert.equal(err.code, 'RCM_OCR_BUDGET_EXCEEDED');
      assert.equal(err.resetsAt, '2026-08-20T05:00:00.000Z');
      return true;
    }
  );

  assert.equal(ocr.calls.analyze, 0, 'a spent budget costs zero round trips');
  assert.deepEqual(budget.seen.charged, [], 'and nothing is charged for work never done');
});

// ─── The container itself ────────────────────────────────────────────────────

test('an unopenable PDF is not escalated to OCR', async () => {
  const ocr = fakeOcr();
  const budget = fakeBudget();

  await assert.rejects(
    () => extractPdfText(Buffer.from('%PDF-1.4\nthis is not a pdf at all'), {
      ocr,
      ocrBudget: budget,
    }),
    (err) => {
      assert.equal(err.code, 'PDF_UNREADABLE');
      return true;
    }
  );
  // "pdf.js cannot open the container" is a different fact from "the pages are
  // pictures". There is nothing to rasterise, so spending on it would buy the
  // same answer more slowly.
  assert.equal(ocr.calls.analyze, 0);
  assert.deepEqual(budget.seen.asserted, []);
});
