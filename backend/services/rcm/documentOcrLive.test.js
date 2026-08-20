'use strict';

/**
 * THE ONE TEST THAT TALKS TO AZURE. Opt-in, and skipped by default.
 *
 *   # from backend/, against the staging resource
 *   RCM_OCR_LIVE=1 \
 *   RCM_OCR_ENDPOINT=https://docint-carein-staging.cognitiveservices.azure.com \
 *   RCM_OCR_AUTH_MODE=azure_cli \
 *   node --test --test-concurrency=1 services/rcm/documentOcrLive.test.js
 *
 * `azure_cli` uses your own `az login`; in a container it is `managed_identity`
 * and no credential env at all. `api_key` with `RCM_OCR_API_KEY` also works and
 * is the fallback when your directory cannot be granted the data-plane role.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS OPT-IN, AND WHY IT EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * OPT-IN because CI has no Azure credential, this costs real pages, and a suite
 * that silently needs a cloud resource is a suite that goes red for reasons
 * nobody can act on.
 *
 * IT EXISTS because everything else in this slice mocks the reader, and a mock
 * cannot tell you whether the thresholds are set anywhere near reality. The
 * numbers asserted below are the ones the staging resource actually returned on
 * 2026-08-19 — 0.991 for the clean scan, 0.157 for the degraded one — and they
 * are what the 0.85 review floor and the 0.55 refusal floor were chosen from.
 * If a service update moves them, this is the test that says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT USES THE SYNTHETIC FIXTURES. NEVER A REAL SCAN.
 * ─────────────────────────────────────────────────────────────────────────────
 * A real scanned EOB is a picture of a real patient's name and date of birth,
 * and no redaction survives OCR — the whole point is that a machine reads the
 * pixels. There is no version of this test that may point at a real document.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ocr = require('./documentOcr');
const { OCR_CONFIDENCE_FLOOR, OCR_CONFIDENCE_UNUSABLE } = require('./eobDocumentText');

const LIVE = process.env.RCM_OCR_LIVE === '1';
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'rcm', 'eob');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const options = {
  skip: LIVE ? false : 'set RCM_OCR_LIVE=1 (and RCM_OCR_ENDPOINT) to run against Azure',
};

test('the synthetic scanned EOB reads cleanly, well above the review floor', options, async () => {
  assert.ok(ocr.isConfigured(), 'RCM_OCR_ENDPOINT must be set for the live probe');

  const result = await ocr.analyze(fixture('Test_EOB_Scanned.pdf'));

  assert.equal(result.pages, 1);
  assert.ok(result.text.length > 300, `expected a full page of text; got ${result.text.length}`);
  // The content, not just the length: a reader that returned a page of nothing
  // in particular would pass a length check.
  assert.match(result.text, /EXPLANATION OF BENEFITS/);
  assert.match(result.text, /CHK-100200/);
  assert.match(result.text, /163\.00/);

  assert.ok(result.meanConfidence != null, 'prebuilt-read reports word confidences');
  assert.ok(
    result.meanConfidence > OCR_CONFIDENCE_FLOOR,
    `a clean synthetic scan must clear the review floor; got ${result.meanConfidence}`
  );
  // Measured 0.9909 on 2026-08-19. A large drop is worth investigating rather
  // than accommodating.
  assert.ok(result.meanConfidence > 0.95, `expected ~0.99, got ${result.meanConfidence}`);

  console.log(
    `[live] clean scan: ${result.pages}p, ${result.words} words, ` +
      `${result.text.length} chars, confidence ${result.meanConfidence.toFixed(4)}, ` +
      `${result.elapsedMs}ms`
  );
});

test('the degraded fixture is genuinely unreadable, not merely asserted to be', options, async () => {
  const result = await ocr.analyze(fixture('Test_EOB_Scanned_Degraded.pdf'));

  // Measured on 2026-08-19: 1 page, 1 "word", 4 characters, confidence 0.157.
  // Both of the refusal conditions in `eobDocumentText.readByOcr` fire on it,
  // which is what makes it a fair input for the can't-read path.
  assert.ok(
    result.text.length < 40 || (result.meanConfidence != null && result.meanConfidence < OCR_CONFIDENCE_UNUSABLE),
    `the degraded fixture must trip a refusal; got ${result.text.length} chars at ` +
      `confidence ${result.meanConfidence}`
  );

  console.log(
    `[live] degraded scan: ${result.pages}p, ${result.words} words, ` +
      `${result.text.length} chars, confidence ` +
      `${result.meanConfidence == null ? 'not reported' : result.meanConfidence.toFixed(4)}`
  );
});

test('a text-layer PDF would read fine too — which is why we never send one', options, async () => {
  // Not a behaviour the product relies on; the escalation means this file never
  // reaches Azure. It is here to make the COST argument concrete: OCR would
  // work on every upload, and running it on every upload would be paying $1.50
  // per thousand pages for text we already have for nothing.
  const result = await ocr.analyze(fixture('Test_EOB_TextLayer.pdf'));
  assert.match(result.text, /EXPLANATION OF BENEFITS/);
  console.log(
    `[live] text-layer PDF (never sent in production): ${result.pages}p, ` +
      `confidence ${result.meanConfidence == null ? 'n/a' : result.meanConfidence.toFixed(4)}`
  );
});
