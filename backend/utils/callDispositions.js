'use strict';

/**
 * Call dispositions + internal call notes — ONE definition of both shapes.
 *
 * Why this file exists at all: two places need to agree about these fields, and
 * they are on opposite sides of the store boundary.
 *
 *   - routes/unifiedCalls.js validates what a human sent (enum, length, trim);
 *   - services/unifiedCallStore.js re-normalizes the stored record on EVERY
 *     re-ingest and must not quietly reshape or drop what is already there.
 *
 * If those two disagreed, a value the route accepts could be dropped by the
 * store an hour later — the exact bug class the preservation whitelist exists to
 * prevent. Same role transcriptShape.js plays for transcripts.
 *
 * NOTHING here touches Open Dental or the TC module. A disposition is the
 * answer to "what kind of call was this, and is it finished?" for the calls
 * whose answer is neither a chart note nor a TC case — a lab confirming a case,
 * a supply vendor, a pharmacy. Those calls used to sit in the worklist forever
 * because the only two ways to finish a call were an OD write or a TC handoff.
 */

const crypto = require('node:crypto');

/**
 * The closed set of dispositions, in the order the UI offers them.
 *
 * Deliberately overlaps `not_a_patient_reason` (spam / vendor / lab / other)
 * without reusing it: that field answers "is the caller a patient?" and gates
 * the review queue, this one answers "what was this call, and is it done?".
 * Collapsing them would mean a pharmacy call could only be closed by asserting
 * something about patient identity.
 *
 * @type {ReadonlyArray<string>}
 */
const DISPOSITIONS = Object.freeze([
  'lab',
  'vendor',
  'pharmacy',
  'insurance',
  'personal',
  'spam',
  'other',
]);

/** @type {ReadonlySet<string>} */
const DISPOSITION_SET = new Set(DISPOSITIONS);

/** Max length of one note's text. Long enough for a real note, short of an essay. */
const NOTE_MAX_LENGTH = 2000;

/**
 * Is `value` one of the seven dispositions?
 *
 * Fails closed on every degenerate input (null, non-string, unknown value), so
 * an unknown disposition is a 400 rather than an unrecognized value written into
 * the store.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isDisposition(value) {
  return typeof value === 'string' && DISPOSITION_SET.has(value);
}

/**
 * An actor as the store records one: `{ name, email }`, or null when there is no
 * session user (dev only). Mirrors triage_by / sent_by / tc_sent_by.
 *
 * @param {unknown} actor
 * @returns {{ name: string|null, email: string|null }|null}
 */
function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return null;
  const { name, email } = /** @type {{ name?: unknown, email?: unknown }} */ (actor);
  return {
    name: typeof name === 'string' ? name : null,
    email: typeof email === 'string' ? email : null,
  };
}

/**
 * One note, as stored.
 *
 * @typedef {object} CallNote
 * @property {string} id           opaque, server-generated
 * @property {string} text         trimmed, <= NOTE_MAX_LENGTH
 * @property {{ name: string|null, email: string|null }|null} author from the session
 * @property {string} created_at   ISO 8601
 */

/**
 * Build a note from text + the acting user. The id and timestamp are the
 * SERVER's — a client-supplied id would let two notes collide, and a
 * client-supplied timestamp would let the log lie about when something happened.
 *
 * @param {string} text already-validated note body
 * @param {{ name: string|null, email: string|null }|null} author
 * @returns {CallNote}
 */
function makeNote(text, author) {
  return {
    id: crypto.randomUUID(),
    text,
    author: normalizeActor(author),
    created_at: new Date().toISOString(),
  };
}

/**
 * Coerce a stored `notes` value to the canonical array.
 *
 * IDEMPOTENT BY CONTRACT — normalizeCall re-runs this on every watermark-overlap
 * re-ingest, so normalizing an already-canonical array must be a no-op. Anything
 * that is not an array becomes `[]`, and an entry without an id or text is
 * dropped rather than stored half-formed.
 *
 * @param {unknown} input
 * @returns {CallNote[]}
 */
function normalizeNotes(input) {
  if (!Array.isArray(input)) return [];
  const notes = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, text, author, created_at: createdAt } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof id !== 'string' || !id) continue;
    if (typeof text !== 'string' || !text.trim()) continue;
    notes.push({
      id,
      text: text.slice(0, NOTE_MAX_LENGTH),
      author: normalizeActor(author),
      created_at: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
    });
  }
  return notes;
}

/**
 * May `actor` delete `note`?
 *
 * Author-or-admin. "Author" is matched on EMAIL, case-insensitively, because
 * that is the identity SSO guarantees is stable — display names are not unique
 * and can change. A note whose author has no email (only possible on a dev box
 * with no session) has no author to match, so only the admin branch can remove
 * it; that is the fail-closed direction.
 *
 * The admin half is passed in rather than decided here: no role literal belongs
 * outside backend/config/permissions.js.
 *
 * @param {CallNote} note
 * @param {{ name: string|null, email: string|null }|null} actor
 * @param {boolean} actorIsAdmin caller holds the delete-any permission
 * @returns {boolean}
 */
function canDeleteNote(note, actor, actorIsAdmin) {
  if (actorIsAdmin) return true;
  const authorEmail = note?.author?.email;
  const actorEmail = actor?.email;
  if (typeof authorEmail !== 'string' || typeof actorEmail !== 'string') return false;
  return authorEmail.trim().toLowerCase() === actorEmail.trim().toLowerCase();
}

module.exports = {
  DISPOSITIONS,
  NOTE_MAX_LENGTH,
  isDisposition,
  makeNote,
  normalizeNotes,
  canDeleteNote,
  normalizeActor,
};
