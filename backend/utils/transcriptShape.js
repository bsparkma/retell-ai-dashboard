'use strict';

/**
 * ONE canonical shape for `transcript_json` in the call store.
 *
 * Two transcription paths write this field, and until 2026-08-08 they wrote two
 * different shapes into it:
 *
 *   Retell (webhook / poller)   { role: 'agent'|'user', content: '...' }
 *   M4 on-demand (Azure Speech) { speaker: 0, text: '...', start, end, confidence }
 *                               ...or the word-level fallback
 *                               { word: '...', start, end, speaker }
 *                               (see services/transcriptionService.js)
 *
 * Every consumer therefore had to know both, and the commlog formatter only knew
 * the first — so "Send transcript to chart" wrote `[] 👤 Caller: undefined` for
 * every line of an on-demand transcript. The fix is to stop asking consumers to
 * guess: normalize at the boundary, store ONE shape.
 *
 * The canonical element:
 *
 *   {
 *     role:    'agent' | 'user' | null,   // null when nobody established it
 *     speaker: number | null,             // diarization index, when known
 *     content: string,                    // the words — always a string
 *     start:   number | null,             // seconds from call start
 *     end:     number | null,
 *   }
 *
 * `role` and `speaker` are deliberately separate. Azure diarization gives an
 * INDEX, not a role: speaker 0 is whoever talked first, which is not the same
 * claim as "this is the agent". Collapsing the index into a role would print a
 * guess into a patient's chart as though it were known, so an index stays an
 * index and the formatter renders it as "Speaker N".
 *
 * This function is IDEMPOTENT — normalizing already-canonical data returns it
 * unchanged. That matters because normalizeCall runs it on every re-ingest
 * inside the hourly watermark overlap.
 */

/** Retell spells the agent two ways; the caller several. Anything else is unknown. */
const AGENT_ROLES = new Set(['agent', 'assistant', 'bot', 'ai']);
const CALLER_ROLES = new Set(['user', 'human', 'caller', 'patient', 'customer']);

/** @param {unknown} v @returns {number|null} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {unknown} raw
 * @returns {'agent'|'user'|null}
 */
function roleOf(raw) {
  if (typeof raw !== 'string') return null;
  const r = raw.trim().toLowerCase();
  if (AGENT_ROLES.has(r)) return 'agent';
  if (CALLER_ROLES.has(r)) return 'user';
  return null;
}

/**
 * The words on one entry, whichever key its producer used.
 * `content` = Retell + canonical, `text` = Azure utterance, `word` = Azure word.
 * @param {Record<string, unknown>} e
 * @returns {string}
 */
function contentOf(e) {
  for (const key of ['content', 'text', 'word']) {
    const v = e[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Normalize one entry, or null if it carries no usable words.
 * @param {unknown} entry
 * @returns {{role: 'agent'|'user'|null, speaker: number|null, content: string, start: number|null, end: number|null}|null}
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = /** @type {Record<string, unknown>} */ (entry);
  const content = contentOf(e);
  // An entry with no words is noise — it would render as a blank line at best
  // and as "undefined" at worst. Drop it here so no consumer has to.
  if (!content) return null;
  return {
    role: roleOf(e.role),
    speaker: num(e.speaker),
    content,
    start: num(e.start),
    end: num(e.end),
  };
}

/**
 * Normalize a whole transcript_json value.
 *
 * @param {unknown} raw whatever a producer (or an older store row) held
 * @returns {Array<{role: 'agent'|'user'|null, speaker: number|null, content: string, start: number|null, end: number|null}>|null}
 *   null when there is no structured transcript at all (so callers can fall back
 *   to the plain-text transcript); an array otherwise, possibly empty.
 */
function normalizeTranscriptJson(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    const normalized = normalizeEntry(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

module.exports = { normalizeTranscriptJson };
