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
 * The cost of that choice, stated plainly rather than hidden: an image-only
 * scan (a photographed or faxed EOB with no text layer) yields nothing here and
 * the upload fails honestly with `no_extractable_text`. It does NOT silently
 * produce an empty extraction, and it does NOT get routed to a vision model
 * behind the user's back. Scanned-image EOBs are a known gap for this slice —
 * see docs/RCM_EOB_INGESTION.md.
 *
 * PHI: the extracted text IS PHI. It is held in memory for the duration of one
 * extraction and never written to disk or logged. Only the CHARACTER COUNT is
 * ever logged.
 */

/**
 * The most text we will put in one prompt. Sized so a long bulk remittance fits
 * while a pathological PDF cannot blow past the deployment's context window and
 * turn into a 400 (or, worse, a silent truncation the model then "reconciles"
 * against numbers it never saw). Truncation is REPORTED, never silent.
 */
const MAX_DOCUMENT_CHARS = 120_000;

/** Below this, there is no document — a text layer of a dozen characters is noise. */
const MIN_DOCUMENT_CHARS = 40;

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

/**
 * Extract the text layer from a PDF buffer.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ text: string, pages: number, truncated: boolean }>}
 * @throws {DocumentTextError} `PDF_UNREADABLE` | `NO_EXTRACTABLE_TEXT`
 */
async function extractPdfText(buffer) {
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
  if (raw.length < MIN_DOCUMENT_CHARS) {
    throw new DocumentTextError(
      'This PDF has no extractable text layer — it is most likely a scanned image. ' +
        'Upload a text PDF exported from the payer portal, or enter this EOB manually.',
      'NO_EXTRACTABLE_TEXT'
    );
  }

  const truncated = raw.length > MAX_DOCUMENT_CHARS;
  return {
    text: truncated ? raw.slice(0, MAX_DOCUMENT_CHARS) : raw,
    pages: Number(parsed.total) || 0,
    truncated,
  };
}

module.exports = {
  extractPdfText,
  looksLikePdf,
  DocumentTextError,
  MAX_DOCUMENT_CHARS,
  MIN_DOCUMENT_CHARS,
};
