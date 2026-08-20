'use strict';

/**
 * Azure AI Document Intelligence — the OCR pre-step for scanned EOBs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS AND IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * It turns page IMAGES into TEXT. That is all. The text it produces is fed to
 * the SAME extraction prompt, against the SAME schema, producing the SAME
 * proposal rows as a digital PDF — see `eobDocumentText.js`, which is the only
 * place a document becomes a string and therefore the only place this is
 * reached from. There is no second extraction engine, no vision model, and no
 * scanned-vs-digital branch anywhere downstream except the provenance marker
 * and the confidence review reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `prebuilt-read` AND NOT `prebuilt-layout`
 * ─────────────────────────────────────────────────────────────────────────────
 * Verified against the Azure retail price API on 2026-08-19 (S0, southcentralus,
 * 0–1M pages/month):
 *
 *     prebuilt-read     $1.50 per 1,000 pages   ($0.0015/page)
 *     prebuilt-layout  $10.00 per 1,000 pages   ($0.0100/page)   — 6.7× more
 *
 * Read returns exactly what this pre-step needs: `analyzeResult.content` (the
 * whole document as text, in reading order), `pages[]` so we can count them, and
 * per-word `confidence` so we can say how sure the reader was. Layout adds
 * tables, selection marks and paragraph roles — structure that the extraction
 * prompt does not consume, because it takes a plain string. Paying 6.7× for
 * structure nothing reads is not a trade, and adding a table-aware prompt would
 * be the forked engine this slice exists not to build.
 *
 * The model is env-overridable (`RCM_OCR_MODEL`) so a future slice can try
 * layout on a payer whose tables read badly — and if it does, the price rate on
 * the cost rail must move with it (`RCM_OCR_CENTS_PER_KPAGE`), or the breaker
 * silently under-counts by 6.7×.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO IMAGE LEAVES THE BAA BOUNDARY
 * ─────────────────────────────────────────────────────────────────────────────
 * Document Intelligence is covered by Microsoft's BAA in the Azure Product Terms
 * — the same instrument that covers Azure OpenAI (`rcmLlm.js`) and Azure Speech
 * (`transcriptionService.js`), and the reason all three are reached the same
 * way. There is no third-party OCR here and no fallback to one: unconfigured
 * means UNAVAILABLE, and an image-only PDF then fails exactly as it did before
 * this slice, with `NO_EXTRACTABLE_TEXT` and advice a human can act on.
 *
 * The bytes go up in a request body and are never written to disk. Nothing in
 * this module logs the document, the extracted text, or any fragment of either
 * — only page counts, confidences, and elapsed milliseconds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRANSPORT
 * ─────────────────────────────────────────────────────────────────────────────
 * Plain `fetch` against the REST API (v4.0, `2024-11-30`) rather than a new SDK
 * dependency. The analyze call is a long-running operation:
 *
 *   POST {endpoint}/documentintelligence/documentModels/{model}:analyze
 *        ?_overload=analyzeDocument&api-version=2024-11-30
 *   → 202 + `Operation-Location` header
 *   → GET that URL until `status` is `succeeded` / `failed`
 *
 * `_overload=analyzeDocument` is load-bearing: it is what selects the JSON body
 * (`base64Source`) overload rather than the raw-bytes one.
 *
 * Config (env):
 *   RCM_OCR_ENDPOINT            https://<name>.cognitiveservices.azure.com
 *                               Absent ⇒ OCR unavailable, which is a legal state.
 *   RCM_OCR_MODEL               default 'prebuilt-read'
 *   RCM_OCR_API_VERSION         default '2024-11-30'
 *   RCM_OCR_AUTH_MODE           'managed_identity' (default) | 'azure_cli' | 'api_key'
 *   RCM_OCR_API_KEY 🔒          only read when AUTH_MODE=api_key
 *   RCM_OCR_TIMEOUT_MS          default 120000 — the whole analyze+poll cycle
 *   RCM_OCR_POLL_INTERVAL_MS    default 2000
 */

/** The same token audience Azure OpenAI and Speech use. One BAA, one scope. */
const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

const DEFAULT_MODEL = 'prebuilt-read';
const DEFAULT_API_VERSION = '2024-11-30';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** @type {(() => Promise<string>) | null} cached bearer provider */
let tokenProvider = null;
/** The endpoint the cached provider was built for, so an env change re-builds. */
let tokenProviderFor = null;

class DocumentOcrError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'DocumentOcrError';
    this.code = code;
  }
}

/** Trailing slashes make `${endpoint}/documentintelligence/...` a 404. */
function endpointUrl() {
  const raw = process.env.RCM_OCR_ENDPOINT;
  return raw ? String(raw).replace(/\/+$/, '') : null;
}

function modelId() {
  return process.env.RCM_OCR_MODEL || DEFAULT_MODEL;
}

function envNumber(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Is a BAA-covered OCR provider configured?
 *
 * Unconfigured is a legal, documented state — not a degraded one. Prod ships
 * with this false until the resource is armed, and every scan then fails the way
 * it failed before this slice existed.
 */
function isConfigured() {
  return Boolean(endpointUrl());
}

/**
 * The `Authorization` (or `Ocp-Apim-Subscription-Key`) header for one request.
 *
 * AUTH_MODE picks EXACTLY ONE credential — never both, and never a silent
 * fallback from one to the other. That rule is copied from `rcmLlm.getClient()`
 * and is the reason a missing managed identity surfaces as an auth error naming
 * the mode, rather than as a mysterious 401 after something else was tried.
 *
 *   managed_identity  the container apps' user-assigned MI (production default)
 *   azure_cli         a developer's `az login` session (local dev)
 *   api_key           an explicit key from Key Vault / env (last resort)
 */
async function authHeader() {
  const mode = process.env.RCM_OCR_AUTH_MODE || 'managed_identity';

  if (mode === 'api_key') {
    const key = process.env.RCM_OCR_API_KEY;
    if (!key) {
      throw new DocumentOcrError(
        'RCM_OCR_AUTH_MODE=api_key but RCM_OCR_API_KEY is not set.',
        'OCR_UNAVAILABLE'
      );
    }
    return { 'Ocp-Apim-Subscription-Key': key };
  }

  const endpoint = endpointUrl();
  if (!tokenProvider || tokenProviderFor !== `${mode}|${endpoint}`) {
    const identity = require('@azure/identity');
    let credential;
    if (mode === 'azure_cli') {
      credential = new identity.AzureCliCredential();
    } else {
      const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
      credential = new identity.ManagedIdentityCredential(clientId ? { clientId } : {});
    }
    tokenProvider = identity.getBearerTokenProvider(credential, COGNITIVE_SERVICES_SCOPE);
    tokenProviderFor = `${mode}|${endpoint}`;
  }

  let token;
  try {
    token = await tokenProvider();
  } catch (err) {
    throw new DocumentOcrError(
      `Could not acquire a Document Intelligence token (${mode}): ` +
        `${err && err.message ? err.message : String(err)}`,
      'OCR_CALL_FAILED'
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** Sleep, with the deadline already checked by the caller. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Everything Document Intelligence read from one document.
 *
 * @typedef {object} OcrResult
 * @property {string} text          the whole document, in reading order
 * @property {number} pages         pages Azure actually processed — THE BILLED UNIT
 * @property {number|null} meanConfidence  0–1, word-count weighted; null = not reported
 * @property {number} words         words read, for the weighting to be checkable
 * @property {string} model         the model id that produced this
 * @property {number} elapsedMs
 */

/**
 * OCR one document.
 *
 * NOT gated on the cost rail here — the caller checks `ocrBudget` (so a spent
 * budget costs zero round trips) and charges it from `result.pages` afterwards.
 * Keeping the meter out of the transport is what lets this function be tested
 * without a budget and the budget be tested without a network.
 *
 * @param {Buffer} buffer the document bytes (PDF or image)
 * @returns {Promise<OcrResult>}
 * INVARIANT: a successful return always has `pages >= 1`. A zero-page answer is
 * refused here rather than handed on — see the guard at the end.
 *
 * @throws {DocumentOcrError} `OCR_UNAVAILABLE` | `OCR_CALL_FAILED` |
 *         `OCR_ANALYZE_FAILED` | `OCR_TIMED_OUT` | `OCR_NO_PAGES`
 */
async function analyze(buffer) {
  const endpoint = endpointUrl();
  if (!endpoint) {
    throw new DocumentOcrError(
      'Azure Document Intelligence is not configured (RCM_OCR_ENDPOINT). Scanned ' +
        'documents cannot be read in this environment.',
      'OCR_UNAVAILABLE'
    );
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new DocumentOcrError('No document bytes to read.', 'OCR_CALL_FAILED');
  }

  const model = modelId();
  const apiVersion = process.env.RCM_OCR_API_VERSION || DEFAULT_API_VERSION;
  const timeoutMs = envNumber('RCM_OCR_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const pollMs = envNumber('RCM_OCR_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const headers = await authHeader();
  const url =
    `${endpoint}/documentintelligence/documentModels/${encodeURIComponent(model)}:analyze` +
    `?_overload=analyzeDocument&api-version=${encodeURIComponent(apiVersion)}`;

  let submitted;
  try {
    submitted = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      // base64Source, not the raw-bytes overload: one code path, and the body is
      // JSON so an error response is JSON too rather than an opaque blob.
      body: JSON.stringify({ base64Source: buffer.toString('base64') }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DocumentOcrError(
      `Document Intelligence could not be reached: ${err && err.message ? err.message : String(err)}`,
      'OCR_CALL_FAILED'
    );
  }

  if (submitted.status !== 202) {
    // The body describes the REQUEST (unsupported media type, bad model, quota),
    // never the document's contents — safe to surface, and the only thing that
    // makes a misconfiguration diagnosable.
    const detail = await safeErrorText(submitted);
    throw new DocumentOcrError(
      `Document Intelligence refused the document (HTTP ${submitted.status}${detail ? `: ${detail}` : ''}).`,
      // A 4xx that is not auth is about THIS document — most often an
      // unsupported or corrupt file — and is a per-document failure, not an
      // outage. Anything else is transport.
      submitted.status >= 400 && submitted.status < 500 && submitted.status !== 401 && submitted.status !== 403
        ? 'OCR_ANALYZE_FAILED'
        : 'OCR_CALL_FAILED'
    );
  }

  const operationUrl = submitted.headers.get('operation-location');
  if (!operationUrl) {
    throw new DocumentOcrError(
      'Document Intelligence accepted the document but returned no Operation-Location to poll.',
      'OCR_CALL_FAILED'
    );
  }

  // ── Poll ───────────────────────────────────────────────────────────────────
  // A fresh auth header per poll: the analysis of a long scan can outlive a
  // token, and a 401 halfway through a poll loop is the kind of failure that
  // reads as "the document is bad" when it is nothing of the sort.
  for (;;) {
    if (Date.now() >= deadline) {
      throw new DocumentOcrError(
        `Reading this document took longer than ${Math.round(timeoutMs / 1000)}s and was ` +
          'stopped. It may simply be very long — split it and upload the parts separately.',
        'OCR_TIMED_OUT'
      );
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));

    let polled;
    try {
      polled = await fetch(operationUrl, {
        headers: await authHeader(),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (err) {
      throw new DocumentOcrError(
        `Document Intelligence stopped responding while reading: ` +
          `${err && err.message ? err.message : String(err)}`,
        'OCR_CALL_FAILED'
      );
    }

    if (!polled.ok) {
      const detail = await safeErrorText(polled);
      throw new DocumentOcrError(
        `Document Intelligence returned HTTP ${polled.status} while reading${detail ? `: ${detail}` : ''}.`,
        'OCR_CALL_FAILED'
      );
    }

    /** @type {any} */
    let body;
    try {
      body = await polled.json();
    } catch {
      throw new DocumentOcrError(
        'Document Intelligence returned a response that is not JSON.',
        'OCR_CALL_FAILED'
      );
    }

    const status = String(body && body.status ? body.status : '').toLowerCase();
    if (status === 'running' || status === 'notstarted') continue;

    if (status === 'failed') {
      // `error.message` here is Azure's description of why the FILE could not be
      // analysed (InvalidContent, UnsupportedMediaType, …). It describes the
      // file, not its contents.
      const message = (body && body.error && body.error.message) || 'no reason given';
      throw new DocumentOcrError(
        `Document Intelligence could not read this document: ${message}`,
        'OCR_ANALYZE_FAILED'
      );
    }

    if (status !== 'succeeded') {
      throw new DocumentOcrError(
        `Document Intelligence returned an unexpected status '${body && body.status}'.`,
        'OCR_CALL_FAILED'
      );
    }

    const result = summarize(body.analyzeResult, model, Date.now() - startedAt);

    /*
     * ZERO PAGES IS A REFUSAL, EVEN WITH CONTENT.
     *
     * Azure can return `content` alongside an empty `pages[]`. Letting that
     * through was a three-way lie waiting to happen: the cost rail charges 0¢
     * for work that really ran (a free read), the provenance CHECK
     * `rcm_eob_uploads_ocr_provenance_check` requires `ocr_page_count > 0` so
     * the transaction rolls back at the very end, and the poster is shown a
     * generic `extraction_failed` for a document that was actually read.
     *
     * Stamping a fabricated `1` was the alternative and is worse: it would
     * invent the number the screen prints as fact and the rail bills against.
     *
     * So the boundary refuses it. Long content with no pages is a response we
     * cannot bill honestly, cannot describe honestly, and therefore will not
     * present as a success. It is rare enough to be a real fault and is
     * reported as one, with the page count in the message.
     */
    if (result.pages < 1) {
      throw new DocumentOcrError(
        `Document Intelligence reported no pages for this document ` +
          `(${result.text.length} characters of text). It cannot be billed or ` +
          'attributed, so it is not treated as a successful read.',
        'OCR_NO_PAGES'
      );
    }

    return result;
  }
}

/**
 * `analyzeResult` → the shape the pre-step needs.
 *
 * `content` is preferred over re-joining `pages[].lines[]` because it is the
 * model's own reading order across the whole document, including anything the
 * page-level line arrays do not carry. The per-page lines are the fallback for
 * a response shape that omits it.
 *
 * MEAN CONFIDENCE IS WORD-COUNT WEIGHTED, not a mean of per-page means: a
 * two-word header page would otherwise count as much as a dense claims table,
 * and the number a biller reads on the screen has to be about the document she
 * is looking at.
 *
 * @param {any} analyzeResult
 * @param {string} model
 * @param {number} elapsedMs
 * @returns {OcrResult}
 */
function summarize(analyzeResult, model, elapsedMs) {
  const result = analyzeResult || {};
  const pages = Array.isArray(result.pages) ? result.pages : [];

  let text = typeof result.content === 'string' ? result.content : '';
  if (!text) {
    text = pages
      .map((p) => (Array.isArray(p.lines) ? p.lines.map((l) => l.content || '').join('\n') : ''))
      .join('\n\n');
  }

  let confidenceSum = 0;
  let words = 0;
  for (const page of pages) {
    for (const word of Array.isArray(page.words) ? page.words : []) {
      const c = Number(word && word.confidence);
      if (!Number.isFinite(c)) continue;
      confidenceSum += c;
      words += 1;
    }
  }

  return {
    text: typeof text === 'string' ? text.trim() : '',
    // `pages.length` is what Azure processed and therefore what it bills.
    // `summarize` stays a pure mapping and may return 0 here; `analyze` is what
    // refuses that, so the invariant is enforced in exactly one place.
    pages: pages.length,
    // null, never 1.0, when nothing reported a confidence. "We do not know how
    // sure the reader was" and "the reader was certain" are different facts and
    // the screen says so.
    meanConfidence: words > 0 ? confidenceSum / words : null,
    words,
    model,
    elapsedMs,
  };
}

/** An error body, bounded and never thrown from. */
async function safeErrorText(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const json = JSON.parse(text);
      const message = json && json.error && (json.error.message || json.error.code);
      if (message) return String(message).slice(0, 300);
    } catch {
      /* not JSON; fall through to the raw text */
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

/** Test seam — drop the cached credential so a suite can re-point the env. */
function _resetForTests() {
  tokenProvider = null;
  tokenProviderFor = null;
}

module.exports = {
  analyze,
  isConfigured,
  modelId,
  DocumentOcrError,
  DEFAULT_MODEL,
  DEFAULT_API_VERSION,
  _resetForTests,
};
