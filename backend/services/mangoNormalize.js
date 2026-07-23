/**
 * Mango API → unified call normalization (pure functions, unit-tested).
 *
 * Maps a raw call object from api.mangovoice.com (`/calls/`) onto the source-agnostic
 * shape the worklist pipeline consumes (same fields the retired scraper produced), so a
 * Mango call flows through match → status exactly like a Retell call.
 *
 * from/to are objects: { caller_id, formatted, phone_number, extension, location, user, ... }.
 * caller_id/formatted are strings; phone_number is a nested object. We prefer the string
 * fields (office-attribution normalizes to E.164 downstream).
 */

const APP_BASE = 'https://app.mangovoice.com';

/** True if a value contains at least 7 digits (i.e. looks like a dialable number). */
function looksLikePhone(s) {
  return String(s == null ? '' : s).replace(/\D/g, '').length >= 7;
}

/**
 * Extract the best phone string from a Mango from/to party object.
 * @param {*} party
 * @returns {string}
 */
function extractPhone(party) {
  if (!party) return '';
  if (typeof party === 'string') return party;

  // Prefer the plain string fields when they carry digits.
  if (looksLikePhone(party.caller_id)) return String(party.caller_id);
  if (looksLikePhone(party.formatted)) return String(party.formatted);

  // phone_number may be a nested object or a string.
  const pn = party.phone_number;
  if (pn && typeof pn === 'object') {
    for (const k of ['e164', 'number', 'national', 'raw', 'digits', 'value']) {
      if (looksLikePhone(pn[k])) return String(pn[k]);
    }
  } else if (looksLikePhone(pn)) {
    return String(pn);
  }

  // Last resort: return whatever string identifier exists (may be a CNAM name).
  return String(party.caller_id || party.formatted || '');
}

/**
 * Only ingest real staff↔patient calls. Skip internal calls, faxes, and voicemail-checks.
 * @param {object} c raw Mango call
 * @returns {boolean}
 */
function isIngestibleCall(c) {
  if (!c || !c.id) return false;
  const type = String(c.type || '').toLowerCase();
  const direction = String(c.direction || '').toLowerCase();
  if (type && type !== 'standard') return false;               // drop fax / check voicemail
  return direction === 'inbound' || direction === 'outbound';  // drop internal
}

/**
 * Normalize a raw Mango API call into the unified worklist shape.
 * Direction-aware: `called_number` is always the OFFICE line (the DID), so
 * MANGO_LINE_OFFICE attribution works for both inbound and outbound calls.
 * @param {object} c raw Mango call (list or detail item)
 * @returns {object}
 */
function normalizeMangoCall(c) {
  const id = c.id;
  const direction = String(c.direction || 'inbound').toLowerCase();
  const outbound = direction === 'outbound';

  const fromNum = extractPhone(c.from);
  const toNum = extractPhone(c.to);

  // External party vs office line, by direction.
  const caller_number = outbound ? toNum : fromNum;
  const called_number = outbound ? fromNum : toNum; // office DID → attribution key

  return {
    source: 'mango',
    external_id: `mango_call_${id}`,
    mango_call_id: String(id),
    mango_detail_url: `${APP_BASE}/calls/${id}`, // playback link (D3: no local audio kept)
    call_date: c.started_at || c.created_at || null,
    caller_number,
    called_number,
    direction,
    duration_seconds: c.duration_in_seconds || 0,
    outcome: c.is_missed ? 'missed' : 'answered',
    handler_type: 'staff',
    handler_name: null,
    // No local recording is persisted (transcribe-and-discard). The signed S3 recording_url
    // is fetched transiently at transcription time and never stored.
    recording_url: null,
    raw_data: { id: c.id, direction, type: c.type, status: c.status, is_missed: c.is_missed },
    created_at: new Date().toISOString(),
  };
}

module.exports = { normalizeMangoCall, extractPhone, isIngestibleCall, looksLikePhone };
