'use strict';

/**
 * PDF → text, for the extraction prompt.
 *
 * WHY TEXT AND NOT VISION — read this before "improving" it to send the PDF.
 *
 * The source (rcm-posting) sent PDFs to Azure OpenAI as a base64 data URL in an
 * `image_url` part, and used pdf-parse text only on the OpenAI-direct path.
 * That is not a documented Azure chat-completions capability, and the platform's
 * Azure OpenAI deployment (config/secrets.js + services/callAnalyzer.js) is
 * provisioned as a text/JSON deployment — it is not guaranteed to accept image
 * parts at all. Sending text works against ANY chat deployment the platform is
 * pointed at, which is what "model per platform default, configurable" requires.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO WAYS A DOCUMENT BECOMES TEXT, ONE PLACE IT HAPPENS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. THE TEXT LAYER (`pdf-parse`). A PDF exported from a payer portal carries
 *    its own text. Free, instant, exact.
 * 2. OCR (Azure Document Intelligence — `documentOcr.js`). A faxed or
 *    photographed EOB carries page IMAGES and no text at all.
 *
 * OCR IS A PRE-STEP, NOT A SECOND ENGINE. Both paths produce a string that goes
 * to the same prompt, against the same schema, producing the same proposal rows.
 * Nothing downstream of this function branches on scanned-vs-digital except the
 * PROVENANCE marker (`source`) and the confidence REVIEW REASON, both of which
 * are facts about the reading rather than changes to the reading.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT TRIGGERS OCR: THE FAILURE WE ALREADY DETECT
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a file sniff, not a content type, not a heuristic about scanners. A
 * document escalates to OCR when its TEXT LAYER YIELDS LESS THAN
 * `MIN_DOCUMENT_CHARS` — the exact condition that used to raise
 * `NO_EXTRACTABLE_TEXT`. A text-layer PDF therefore never pays for OCR, and it
 * cannot: the escalation lives on the far side of a read that already failed.
 *
 * When OCR is NOT configured, that condition raises `NO_EXTRACTABLE_TEXT`
 * exactly as it did before this slice. Unconfigured is a legal state, not a
 * degraded one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHI
 * ─────────────────────────────────────────────────────────────────────────────
 * The extracted text IS PHI, whichever path produced it. It is held in memory
 * for the duration of one extraction and never written to disk or logged. Only
 * the CHARACTER COUNT, the PAGE COUNT and the CONFIDENCE are ever logged.
 */

const { EOB_REVIEW_REASONS } = require('./rcmVocabulary');

/**
 * The most text we will put in one prompt. Sized so a long bulk remittance fits
 * while a pathological PDF cannot blow past the deployment's context window and
 * turn into a 400 (or, worse, a silent truncation the model then "reconciles"
 * against numbers it never saw). Truncation is REPORTED, never silent.
 *
 * IT APPLIES TO THE OCR PATH TOO, and matters MORE there: OCR output is longer
 * and noisier than a text layer for the same pages (page furniture, scanner
 * artefacts and repeated headers all become characters), so a document that
 * would have fitted as a digital PDF can overrun as a scan. A scanned bulk EOB
 * that silently lost its tail claims is the same defect as a digital one that
 * did — so it is the same refusal.
 */
const MAX_DOCUMENT_CHARS = 120_000;

/** Below this, there is no document — a text layer of a dozen characters is noise. */
const MIN_DOCUMENT_CHARS = 40;

/**
 * The documented confidence floor. Below it, every claim read from the document
 * carries `ocr_low_confidence`.
 *
 * 0.85 mean word confidence means roughly one word in seven was a guess. That is
 * a perfectly readable page for a human and a perfectly plausible one for the
 * extraction model — which is exactly the danger, because a plausible misreading
 * of a dollar column still looks like a number. So it WIDENS REVIEW and never
 * resolves anything: the reason is annotating (D-11), it lands on every claim
 * from the document, and it changes nothing about what was stored.
 */
const OCR_CONFIDENCE_FLOOR = 0.85;

/**
 * Below THIS, we refuse rather than annotate.
 *
 * 0.55 mean word confidence means nearly half the words are guesses. There is no
 * review a human can perform on a claim built out of that, because the amounts
 * she would check against are themselves the misread ones. The honest answer is
 * "this scan cannot be read — rescan it", and that is an answer she can act on.
 */
const OCR_CONFIDENCE_UNUSABLE = 0.55;

/** What a scan that could not be read tells the person who uploaded it. */
const RESCAN_ADVICE =
  'This scan is too faint or too low-resolution to read. Rescan it at 300 dpi in ' +
  'black and white, ask the payer for a text PDF, or enter this EOB manually.';

class DocumentTextError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'DocumentTextError';
    this.code = code;
  }
}

/** `%PDF-` magic bytes. We do not trust the client's declared content type. */
function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** Read a bounded fraction from env, falling back rather than storing NaN. */
function envFraction(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * The A6 refusal, worded for whichever path produced the text.
 *
 * One function, so the two paths cannot drift into saying different things about
 * the same limit — and so `failure_code` stays `document_too_large` for both,
 * which is what the panel switches on.
 */
function tooLargeError(chars, pages, source) {
  const how =
    source === 'ocr' ? `of text read by OCR from ${pages} page(s)` : `of text across ${pages} pages`;
  return new DocumentTextError(
    `This document is too long to extract in one pass (${chars.toLocaleString()} characters ` +
      `${how}; the limit is ${MAX_DOCUMENT_CHARS.toLocaleString()}). Split it and upload the ` +
      'parts separately — extracting only part of it would hide the claims that did not fit.',
    'DOCUMENT_TOO_LARGE'
  );
}

/**
 * Extract the text of a document: its text layer, or — when there isn't one —
 * Azure Document Intelligence.
 *
 * @param {Buffer} buffer
 * @param {{ ocr?: object, ocrBudget?: object }} [deps] injectable seams; the
 *        defaults are the real modules, required LAZILY so a text-layer-only
 *        test never loads the Azure credential stack.
 * @returns {Promise<{ text: string, pages: number, truncated: boolean,
 *                     source: 'text_layer'|'ocr', ocrPages: number|null,
 *                     ocrMeanConfidence: number|null, reviewReasons: string[] }>}
 * @throws {DocumentTextError} `PDF_UNREADABLE` | `NO_EXTRACTABLE_TEXT` |
 *         `DOCUMENT_TOO_LARGE` | `OCR_UNREADABLE`
 * @throws an error carrying `code === 'RCM_OCR_BUDGET_EXCEEDED'` when the OCR
 *         cost rail is spent — a PAUSE, not a failure, and the worker treats it
 *         as one. Also propagates `documentOcr`'s own transport codes.
 */
async function extractPdfText(buffer, deps = {}) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });

  /** @type {{ text?: string, total?: number }} */
  let parsed;
  try {
    parsed = await parser.getText();
  } catch (err) {
    // An encrypted, corrupt, or password-protected PDF lands here. The message
    // is from pdf-parse and describes the FILE, not its contents — safe to
    // surface, and the only thing that makes this state actionable.
    //
    // DELIBERATELY NOT ESCALATED TO OCR. pdf.js failing to open the container is
    // a different fact from "the pages are pictures": there are no pages to
    // rasterise, and sending an unopenable file to Azure spends money to be told
    // the same thing in a slower way.
    throw new DocumentTextError(
      `PDF could not be read: ${err && err.message ? err.message : String(err)}`,
      'PDF_UNREADABLE'
    );
  } finally {
    // pdf.js holds worker state; release it rather than leaning on GC.
    try {
      if (typeof parser.destroy === 'function') await parser.destroy();
    } catch {
      /* releasing is best-effort */
    }
  }

  const raw = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  const pageCount = Number(parsed.total) || 0;

  // ── The escalation, triggered by the honest failure we already detect ──────
  if (raw.length < MIN_DOCUMENT_CHARS) {
    return readByOcr(buffer, pageCount, deps);
  }

  // SLICE 5.5 DEFECT A6. This used to `raw.slice(0, MAX_DOCUMENT_CHARS)` and
  // return `truncated: true`, whose ONLY consumer was a `console.warn`. A long
  // bulk EOB therefore lost its tail claims, the model reconciled the totals it
  // could see, and the user was shown "Proposal ready." — a knowingly partial
  // extraction presented as a complete one.
  //
  // We REFUSE instead. The alternative — store the partial and flag it — was
  // considered and rejected: a proposal that is missing claims nobody can
  // enumerate is not reviewable, and Slice 6c would post the ones that survived
  // while the rest silently never existed. Splitting the document is something
  // the user can actually do.
  if (raw.length > MAX_DOCUMENT_CHARS) throw tooLargeError(raw.length, pageCount, 'text_layer');

  return {
    text: raw,
    pages: pageCount,
    // Retained as an always-false field so a caller reading it does not silently
    // change meaning; over-length is now a refusal, never a returned state.
    truncated: false,
    source: 'text_layer',
    ocrPages: null,
    ocrMeanConfidence: null,
    reviewReasons: [],
  };
}

/**
 * The OCR path. Reached ONLY from the `raw.length < MIN_DOCUMENT_CHARS` branch
 * above — there is no other caller and no other trigger.
 *
 * @param {Buffer} buffer
 * @param {number} pageCount pages the PDF itself declares, used to price the job
 *        BEFORE anything is spent. Document Intelligence's own count is what is
 *        actually charged.
 * @param {{ ocr?: object, ocrBudget?: object }} deps
 */
async function readByOcr(buffer, pageCount, deps) {
  const ocr = deps.ocr || require('./documentOcr');

  // Unconfigured ⇒ the pre-slice behaviour, unchanged and unapologetic.
  if (!ocr.isConfigured()) {
    throw new DocumentTextError(
      'This PDF has no extractable text layer — it is most likely a scanned image. ' +
        'Upload a text PDF exported from the payer portal, or enter this EOB manually.',
      'NO_EXTRACTABLE_TEXT'
    );
  }

  const budget = deps.ocrBudget || require('./ocrBudget');

  // THE HARD BACKSTOP, with the page count, so a document we cannot afford IN
  // FULL is refused before a byte is sent rather than half-read. The thrown
  // error carries `RCM_OCR_BUDGET_EXCEEDED`, which the worker turns into a
  // PAUSE — the upload stays, waits for the reset, and is never dropped.
  budget.assertAllowed(pageCount || null);

  const result = await ocr.analyze(buffer);

  // Charged the moment the work is done, BEFORE the answer is judged. Pages are
  // billed whether or not we can use what came back, and a breaker that only
  // counted usable reads would under-report exactly on the documents that burn
  // the most retries. Same rule, same reason, as the extraction rail.
  const charged = budget.charge(result.pages);
  console.log(
    `[rcm/ocr] read ${result.pages} page(s) in ${result.elapsedMs}ms with ${result.model} ` +
      `(~${charged.chargedCents}¢; $${(charged.usedCents / 100).toFixed(2)} of ` +
      `$${(charged.capCents / 100).toFixed(2)} today) · ${result.text.length} chars · ` +
      `confidence ${result.meanConfidence == null ? 'not reported' : result.meanConfidence.toFixed(3)}`
  );

  const text = result.text;
  const confidence = result.meanConfidence;

  // ── "We could not read this" — an answer a human can act on ────────────────
  if (text.length < MIN_DOCUMENT_CHARS) {
    throw new DocumentTextError(
      `Almost nothing could be read from this document (${result.pages} page(s), ` +
        `${text.length} characters). ${RESCAN_ADVICE}`,
      'OCR_UNREADABLE'
    );
  }

  const unusableFloor = envFraction('RCM_OCR_UNUSABLE_CONFIDENCE', OCR_CONFIDENCE_UNUSABLE);
  if (confidence != null && confidence < unusableFloor) {
    throw new DocumentTextError(
      `This document was read with ${(confidence * 100).toFixed(0)}% average confidence — too ` +
        'low to review, because the amounts a person would check are themselves guesses. ' +
        RESCAN_ADVICE,
      'OCR_UNREADABLE'
    );
  }

  // A6 on the OCR path. Checked AFTER the read, because until Azure answers
  // there is no character count to check — the page-count gate above is a cost
  // rail, not a length one.
  if (text.length > MAX_DOCUMENT_CHARS) throw tooLargeError(text.length, result.pages, 'ocr');

  const floor = envFraction('RCM_OCR_MIN_CONFIDENCE', OCR_CONFIDENCE_FLOOR);
  /** @type {string[]} */
  const reviewReasons = [];
  if (confidence != null && confidence < floor) {
    reviewReasons.push(EOB_REVIEW_REASONS.OCR_LOW_CONFIDENCE);
  }

  return {
    text,
    // The PDF's own page count and Azure's can disagree (an embedded multi-page
    // TIFF, a page tree that lies). `pages` keeps meaning "pages of document";
    // `ocrPages` is what was read and billed. Both are stored.
    pages: pageCount || result.pages,
    truncated: false,
    source: 'ocr',
    ocrPages: result.pages,
    ocrMeanConfidence: confidence,
    reviewReasons,
  };
}

module.exports = {
  extractPdfText,
  looksLikePdf,
  DocumentTextError,
  MAX_DOCUMENT_CHARS,
  MIN_DOCUMENT_CHARS,
  OCR_CONFIDENCE_FLOOR,
  OCR_CONFIDENCE_UNUSABLE,
  RESCAN_ADVICE,
};
