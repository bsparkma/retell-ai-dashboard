/**
 * Open Dental Sync Service
 * 
 * Handles syncing call data (transcripts, summaries) to Open Dental patient records
 * via CommLog entries. Also provides enhanced patient matching capabilities.
 */

const unifiedCallStore = require('./unifiedCallStore');
const { sanitizeForOd } = require('../utils/sanitizeForOd');
const { normalizeTranscriptJson } = require('../utils/transcriptShape');
const { getOfficeForCall } = require('../config/officeAgents');
const odOffices = require('../config/odOffices');
const commlogTypes = require('./commlogTypes');

/**
 * Seconds → `m:ss`, for the per-line timestamp in a transcript chart note.
 * @param {number} seconds
 * @returns {string}
 */
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ── Office-keyed Open Dental access (per-location slice) ─────────────────────
// This service used to talk to ONE process-wide OD client (config/openDental).
// It now resolves the client BY OFFICE, and the office comes from the CALL by
// default. That is what makes a valley call structurally unable to DRIFT into
// Roland's database: nothing about a request — its route, its body, a stale
// screen — quietly changes which chart gets written.
//
// There is exactly ONE way to write to a different practice's chart than the one
// the call rang at, and it is not quiet: `options.targetOfficeKey`, set only when
// a human deliberately picked that office at the send step (the front desk at one
// practice taking a call for a patient of the other). The route validates the key
// against the office registry before it ever reaches here and refuses an unknown
// one — it never falls back to some other office.
//
// The distinction that matters: `targetOfficeKey` SELECTS (a human said so),
// `expectOfficeKey` only ASSERTS — it can cause a refusal and can never redirect
// a write. Both are checked; neither can be skipped by a future caller, because
// every OD-touching method takes an `od` handle from odOffices.getOdOffice() and
// runs it through odOffices.assertOfficeMatch() before use.
//
// When NO target is named, the office is defaultTargetOfficeFor(call) — the call's
// own, UNLESS the call already carries a patient link, in which case it is that
// link's office. That rule lives HERE, in the service, and not in the route that
// happens to have the nicest UI. It was a route convenience once, and being a route
// convenience is precisely what made it wrong: `syncCallToCommLog` is reachable from
// POST /api/opendental-sync/calls/:id/sync and from the batch syncPendingCalls loop,
// neither of which knew the rule, so a deliberately cross-office link resolved back
// to the call's own office and hit the stale-match branch below — which used to
// discard the human's link and re-match by phone in the wrong database.

/**
 * The office-bound OD connection for a stored call.
 * @param {{source?: string, called_number?: string, handler_id?: string}} call
 * @returns {import('../config/odOffices').OdOfficeHandle}
 * @throws {import('../config/odOffices').OdOfficeError} unknown / unconnected / unkeyed office
 */
function odForCall(call) {
  const officeKey = getOfficeForCall(call);
  return odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
}

/**
 * Where a chart action on this call goes when nobody named a target.
 *
 * The call's own office — unless the call is already LINKED to a patient, in which
 * case it is that patient's office. A stored PatNum is only meaningful in the
 * database it came from: 7115 is the valley test patient and a different real
 * person in Roland. So once a human has said "this caller is that Roland patient",
 * Roland is the only chart that PatNum can honestly be written to, and resolving
 * back to the call's own office would aim a Roland PatNum at Riley's database.
 *
 * THE single definition — the route's `target_office` validation and every
 * service-level caller both come through here, so there is one answer to "where
 * does this go by default" rather than one per entry point.
 *
 * A stored office we do not recognise is ignored rather than trusted: it falls
 * through to the call's office, where the guard in syncCallToCommLog then refuses
 * the mismatch rather than writing anywhere.
 *
 * @param {{source?: string, called_number?: string, handler_id?: string,
 *          od_patient_id?: any, od_patient_office?: string|null}} call
 * @returns {string} a frozen office key
 */
function defaultTargetOfficeFor(call) {
  const hasPatient =
    call && call.od_patient_id !== undefined && call.od_patient_id !== null && call.od_patient_id !== '';
  const linkedOffice = call && call.od_patient_office;
  if (hasPatient && odOffices.isChartTargetOffice(linkedOffice)) return linkedOffice;
  return getOfficeForCall(call);
}

/**
 * The office-bound OD connection this operation is FOR: the deliberately chosen
 * target office when there is one, otherwise defaultTargetOfficeFor(call).
 *
 * `targetOfficeKey` is a chosen office, so it is trusted to select — but only
 * after the caller validated it. Passing an unregistered/unconnected key still
 * refuses here (getOdOffice throws), so a bad value fails closed rather than
 * landing anywhere.
 *
 * @param {{source?: string, called_number?: string, handler_id?: string,
 *          od_patient_id?: any, od_patient_office?: string|null}} call
 * @param {string} [targetOfficeKey] the office a human chose to write to
 * @returns {import('../config/odOffices').OdOfficeHandle}
 * @throws {import('../config/odOffices').OdOfficeError} unknown / unconnected / unkeyed office
 */
function odForTarget(call, targetOfficeKey) {
  const officeKey =
    typeof targetOfficeKey === 'string' && targetOfficeKey
      ? targetOfficeKey
      : defaultTargetOfficeFor(call);
  return odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
}

// ── Shared match → status logic (source-agnostic) ────────────────────────────
// Extracted from the Retell webhook path so BOTH Retell (call_analyzed) and Mango
// (post-analysis) drive the SAME review-then-send status transitions:
//   confident + unambiguous  -> od_sync_status = 'matched'   (+ od_patient_*)
//   everything else          -> od_sync_status = 'needs_review' (+ candidates)
// No auto-write ever happens here — that stays in the Retell-legacy branch behind
// COMMLOG_AUTO_WRITE. See docs/SLICE_WEBHOOK_COMMLOG_HARDENING_PRD.md and the Mango PRD.

// Auto-/matched-write only on a confident, UNAMBIGUOUS match. Everything else -> needs_review.
// The FIRM rule is "no alternatives" (a number/name on >1 record is never confident). The
// threshold then excludes the weak fuzzy band: phone_exact single = 0.95, name+phone = 0.98/0.85,
// a single strong name match (matchByNameFuzzy caps at 0.80) all pass; phone-matched-but-name-
// disagreed (0.70) and weaker fuzzy names fall to needs_review. 0.80 keeps the established
// "Stedi Test" name-only confident-match protocol matching.
const CONFIDENT_WRITE_MIN = 0.80;

function isConfidentUnambiguousMatch(matchResult) {
  if (!matchResult || !matchResult.patient) return false;
  // A number on more than one record (matchByPhone returns `alternatives`) is ambiguous.
  if (Array.isArray(matchResult.alternatives) && matchResult.alternatives.length > 0) return false;
  return (matchResult.confidence || 0) >= CONFIDENT_WRITE_MIN;
}

function patientToCandidate(p) {
  if (!p || p.id == null) return null;
  const name = p.fullName
    || [p.firstName, p.lastName].filter(Boolean).join(' ').trim()
    || `Patient ${p.id}`;
  return { id: p.id, name };
}

// The top guess + alternatives, as {id, name}, de-duped by id — for the Slice-B review UI.
function buildMatchCandidates(matchResult) {
  if (!matchResult) return [];
  const seen = new Set();
  return [matchResult.patient, ...(matchResult.alternatives || [])]
    .map(patientToCandidate)
    .filter(Boolean)
    .filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

class OpenDentalSyncService {
  constructor() {
    this.syncQueue = [];
    this.isSyncing = false;
    this.syncHistory = [];
    this.maxHistorySize = 100;
    
    // Sync statistics
    this.stats = {
      totalSynced: 0,
      totalFailed: 0,
      lastSyncTime: null,
      lastError: null
    };

    // CommType for CareIN automated commlog entries is an OD definition.DefNum
    // (Category=27) and is PRACTICE-SPECIFIC. It is no longer a single value on this
    // service: it now lives PER OFFICE in config/odOffices.js and arrives on the
    // office handle, because writing one practice's DefNum into another practice's
    // database is a corrupt row. Verified live 2026-08-07:
    //   Roland "CareIN AI Call" = 486   Riley/valley "CareIN AI Call" = 451
    // See docs/OD_API_CONTRACT.md §10.
  }

  // ============================================================================
  // ENHANCED PATIENT MATCHING
  // ============================================================================

  /**
   * Match a call to a patient using multiple strategies, IN THAT CALL'S OFFICE.
   * Returns the best matching patient or null.
   *
   * @param {object} call the stored call — its office decides which OD database is searched
   * @param {import('../config/odOffices').OdOfficeHandle} [od] pre-resolved office
   *   connection; omitted, it is derived from the call. Callers that already hold a
   *   handle pass it so the office is resolved (and asserted) exactly once.
   */
  async matchCallToPatient(call, od = odForCall(call)) {
    if (!od.client.isEnabled()) {
      return { patient: null, confidence: 0, method: 'disabled' };
    }

    const strategies = [
      { name: 'phone_exact', fn: () => this.matchByPhoneExact(call.caller_number, od) },
      { name: 'name_phone', fn: () => this.matchByNameAndPhone(call.caller_name, call.caller_number, od) },
      { name: 'name_fuzzy', fn: () => this.matchByNameFuzzy(call.caller_name, od) }
    ];

    for (const strategy of strategies) {
      try {
        const result = await strategy.fn();
        if (result.patient && result.confidence >= 0.7) {
          return { ...result, method: strategy.name };
        }
      } catch (error) {
        console.error(`[OD Sync] Match strategy ${strategy.name} failed:`, error.message);
      }
    }

    return { patient: null, confidence: 0, method: 'no_match' };
  }

  /**
   * Match patient by exact phone number, in the given office's OD database.
   * @param {string} phoneNumber
   * @param {import('../config/odOffices').OdOfficeHandle} od
   */
  async matchByPhoneExact(phoneNumber, od) {
    if (!phoneNumber) return { patient: null, confidence: 0 };

    // Clean the phone number
    const cleanPhone = this.cleanPhoneNumber(phoneNumber);
    if (cleanPhone.length < 10) return { patient: null, confidence: 0 };

    try {
      const patients = await od.client.searchPatients(cleanPhone);

      if (patients.length === 1) {
        return { patient: patients[0], confidence: 0.95 };
      } else if (patients.length > 1) {
        // Multiple matches - return first but with lower confidence
        return { patient: patients[0], confidence: 0.75, alternatives: patients.slice(1) };
      }
    } catch (error) {
      console.error('[OD Sync] Phone match error:', error.message);
    }

    return { patient: null, confidence: 0 };
  }

  /**
   * Match patient by name AND phone (higher confidence), in the given office's OD.
   * @param {string} callerName
   * @param {string} phoneNumber
   * @param {import('../config/odOffices').OdOfficeHandle} od
   */
  async matchByNameAndPhone(callerName, phoneNumber, od) {
    if (!callerName || !phoneNumber) return { patient: null, confidence: 0 };

    const cleanPhone = this.cleanPhoneNumber(phoneNumber);
    const normalizedName = this.normalizeName(callerName);

    try {
      // Search by phone first
      const phoneMatches = await od.client.searchPatients(cleanPhone);

      if (phoneMatches.length > 0) {
        // Check if any of the phone matches also match the name
        for (const patient of phoneMatches) {
          const patientName = this.normalizeName(patient.fullName || `${patient.firstName} ${patient.lastName}`);
          const similarity = this.calculateNameSimilarity(normalizedName, patientName);
          
          if (similarity >= 0.8) {
            return { patient, confidence: 0.98 };
          } else if (similarity >= 0.6) {
            return { patient, confidence: 0.85 };
          }
        }
        
        // Phone matched but name didn't - still return with lower confidence
        return { patient: phoneMatches[0], confidence: 0.7, nameMatch: false };
      }
    } catch (error) {
      console.error('[OD Sync] Name+phone match error:', error.message);
    }

    return { patient: null, confidence: 0 };
  }

  /**
   * Match patient by name only (fuzzy matching), in the given office's OD.
   * @param {string} callerName
   * @param {import('../config/odOffices').OdOfficeHandle} od
   */
  async matchByNameFuzzy(callerName, od) {
    if (!callerName || callerName.length < 3) return { patient: null, confidence: 0 };

    const normalizedName = this.normalizeName(callerName);
    
    // Skip common non-name values
    const skipValues = ['unknown', 'caller', 'patient', 'customer', 'user', 'guest'];
    if (skipValues.some(skip => normalizedName.toLowerCase().includes(skip))) {
      return { patient: null, confidence: 0 };
    }

    try {
      const patients = await od.client.searchPatients(callerName);

      if (patients.length === 1) {
        const patientName = this.normalizeName(patients[0].fullName || `${patients[0].firstName} ${patients[0].lastName}`);
        const similarity = this.calculateNameSimilarity(normalizedName, patientName);
        return { patient: patients[0], confidence: Math.min(similarity, 0.8) };
      } else if (patients.length > 1) {
        // Find best match
        let bestMatch = null;
        let bestScore = 0;
        
        for (const patient of patients) {
          const patientName = this.normalizeName(patient.fullName || `${patient.firstName} ${patient.lastName}`);
          const similarity = this.calculateNameSimilarity(normalizedName, patientName);
          
          if (similarity > bestScore) {
            bestScore = similarity;
            bestMatch = patient;
          }
        }
        
        if (bestMatch && bestScore >= 0.7) {
          return { patient: bestMatch, confidence: bestScore * 0.9, alternatives: patients.filter(p => p.id !== bestMatch.id) };
        }
      }
    } catch (error) {
      console.error('[OD Sync] Fuzzy name match error:', error.message);
    }

    return { patient: null, confidence: 0 };
  }

  // ============================================================================
  // COMMLOG SYNC
  // ============================================================================

  /**
   * Sync a call's transcript and summary to Open Dental CommLog.
   *
   * The target office is the CALL's office unless `options.targetOfficeKey` names
   * another one — the cross-office chart target, chosen by a human at the send step
   * and validated by the route against the office registry before it gets here.
   * Absent, this is byte-for-byte the pre-override behaviour.
   *
   * `options.expectOfficeKey` is a separate thing and stays a pure assertion from
   * the caller ("I believe I am writing to valley") — it can only ever cause a
   * refusal, never redirect the write, so a request that names the wrong office is
   * rejected rather than obeyed. It is asserted against the RESOLVED target, which
   * is what keeps a stale screen from sending a note to a practice nobody chose.
   *
   * `options.commTypeDefNum` is the chart-note TYPE the user picked at the send
   * step. Omitted, the office's configured default is written — byte-for-byte
   * today's behaviour. Supplied, it is checked against THIS office's own commlog
   * types before anything is written; see commlogTypes.assertAllowed.
   *
   * @param {string} callId
   * @param {{ force?: boolean, allowUnmatched?: boolean, noteOverride?: string,
   *           contentType?: string, includeTranscript?: boolean,
   *           targetOfficeKey?: string, expectOfficeKey?: string,
   *           commTypeDefNum?: number }} [options]
   */
  async syncCallToCommLog(callId, options = {}) {
    const call = unifiedCallStore.getCall(callId);

    if (!call) {
      return { success: false, error: 'Call not found' };
    }

    // Check if already synced
    if (call.od_sync_status === 'synced' && !options.force) {
      return { success: true, message: 'Already synced', skipped: true };
    }

    // Resolve the office connection this write is FOR — the chosen target office,
    // or this call's own. An unknown / not-yet-connected / unkeyed office refuses
    // here, before anything touches a chart.
    let od;
    try {
      od = odForTarget(call, options.targetOfficeKey);
      if (options.expectOfficeKey) {
        odOffices.assertOfficeMatch(options.expectOfficeKey, od);
      }
    } catch (err) {
      return {
        success: false,
        error: err.publicMessage || err.message,
        code: err.code,
        officeBlocked: true,
      };
    }

    // Resolve the chart-note TYPE before touching a chart. The check lives here
    // rather than only in the route for the same reason expectOfficeKey does: a
    // new caller of the send path cannot forget it. Omitted → null → the office's
    // configured default, exactly as before this option existed.
    let commTypeDefNum = null;
    if (options.commTypeDefNum !== undefined && options.commTypeDefNum !== null) {
      try {
        commTypeDefNum = await commlogTypes.assertAllowed(od, options.commTypeDefNum);
      } catch (err) {
        return {
          success: false,
          error: err.publicMessage || err.message,
          code: err.code,
          commlogTypeBlocked: true,
        };
      }
    }

    // Match to patient if not already matched
    let patientId = call.od_patient_id;
    let matchResult = null;

    // A stored PatNum is only meaningful together with the office it came from —
    // PatNum 7115 is "Stedi TestValley" in Riley and a different real patient in
    // Roland. A link that disagrees with the office this write resolved to is
    // therefore a contradiction, and the only honest response is to REFUSE it.
    //
    // This branch used to discard the link and re-match by phone in the resolved
    // office. That was right while a cross-office link could only be corruption —
    // the leftover of an auto-match made against Roland's database back when valley
    // had no OD connection of its own. It is not right now that a human can
    // deliberately link a call to the other practice's patient: re-matching would
    // throw away what they said and, if some patient in the resolved office happens
    // to share the caller's phone number, file the note on that stranger's chart.
    //
    // Nothing is written and nothing is re-matched. Which of the two facts is wrong
    // — the link or the office this resolved to — is a question only a person can
    // answer, and the note is not urgent enough to guess.
    if (patientId && !this.patientOfficeMatches(call, od.officeKey)) {
      console.warn(
        `[OD Sync] ${callId}: REFUSING to write — stored patient link belongs to office ` +
        `'${this.patientOfficeOf(call)}' but this write resolved to '${od.officeKey}'. ` +
        `No note written, no re-match attempted.`
      );
      return {
        success: false,
        code: 'PATIENT_OFFICE_MISMATCH',
        error:
          'This call is linked to a patient at a different practice than the chart this note is headed for — ' +
          'refusing to write it to either one until someone confirms which is right',
        officeBlocked: true,
      };
    }

    if (!patientId) {
      matchResult = await this.matchCallToPatient(call, od);
      if (matchResult.patient) {
        patientId = matchResult.patient.id;
      }
    }

    if (!patientId && !options.allowUnmatched) {
      // Update call with match attempt info
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'pending_match',
        od_match_result: matchResult,
        od_sync_attempted_at: new Date().toISOString()
      });
      
      return { 
        success: false, 
        error: 'No patient match found', 
        matchResult,
        requiresManualLink: true 
      };
    }

    // Create CommLog entry — createCommLog branches DB vs API and builds the correct
    // payload for each (the API path needs string enums + a formatted date, not the
    // DB-shaped integers). See createCommLog / OD_API_CONTRACT.md §10.
    try {
      const commLogEntry = this.formatCommLogEntry(call, options);
      // Review-then-send: a human-edited note wins over the generated one.
      if (typeof options.noteOverride === 'string' && options.noteOverride.trim()) {
        commLogEntry.Note = options.noteOverride;
      }
      const result = await this.createCommLog(patientId, commLogEntry, od, { commTypeDefNum });

      if (!result.success) {
        throw new Error(result.error || 'CommLog create failed');
      }

      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'synced',
        od_patient_id: patientId,
        // Which practice's database that PatNum lives in. Written alongside every
        // PatNum so a later read can tell a Riley 7115 from a Roland 7115.
        od_patient_office: od.officeKey,
        od_commlog_num: result.commLogNum,
        od_synced_at: new Date().toISOString(),
        od_match_confidence: matchResult?.confidence
      });

      this.stats.totalSynced++;
      this.stats.lastSyncTime = new Date().toISOString();

      this.addToHistory({
        type: 'sync_success',
        callId,
        patientId,
        commLogNum: result.commLogNum,
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        message: 'Synced to CommLog',
        commLogNum: result.commLogNum,
        patientId
      };
    } catch (error) {
      console.error('[OD Sync] CommLog sync failed:', error.message);
      
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'error',
        od_sync_error: error.message,
        od_sync_attempted_at: new Date().toISOString()
      });

      this.stats.totalFailed++;
      this.stats.lastError = error.message;

      this.addToHistory({
        type: 'sync_error',
        callId,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      return { success: false, error: error.message };
    }
  }

  /**
   * Format a CommLog entry for Open Dental
   */
  formatCommLogEntry(call, options = {}) {
    const source = call.source === 'retell' ? 'CareIN AI' : 'Staff (Mango)';

    // COMPACT chart note (item 2). Front-desk staff paste these into OD; the old verbose
    // block was too long for OD notes. Four terse fields + a one-line header. The LLM is
    // instructed (buildHumanCallPrompt) to keep each field to one line.
    const localWhen = this.formatOfficeDateTime(call.call_date);

    // No-content calls (item 5): short/missed/voicemail with no recording → no transcript
    // AND no analyzed summary. Writing the compact block would be all "Unknown/None"; a
    // minimal stub is clearer and keeps the call fully triageable/closable. Office-TZ ts.
    const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
    const hasContent = nonEmpty(call.transcript) || nonEmpty(call.summary) || nonEmpty(call.call_reason);

    let note;
    if (!hasContent) {
      note = `Call received ${localWhen}, no recording available.`;
    } else {
      const reason = call.call_reason || call.summary || 'Call';
      const reasonLine = call.is_emergency ? `${reason} [EMERGENCY]` : reason;
      // Prefer a callback number the caller explicitly gave; else the caller's own number
      // when a callback is needed; else nothing. ('-' not em-dash: OD-safe ASCII.)
      const callbackNum = call.callback_number
        || (call.callback_required ? call.caller_number : null)
        || '-';

      // ASCII-only so sanitizeForOd is a no-op and the chart note is clean.
      note = [
        `CareIN call - ${localWhen} - ${source}`,
        `Caller: ${call.caller_name || 'Unknown'}`,
        `Reason: ${reasonLine}`,
        `Action: ${call.action_needed || 'None'}`,
        `Callback #: ${callbackNum}`,
      ].join('\n');

      // The call page shows call.summary; the chart note showed only the compact block,
      // so the note and the app disagreed about the same call. Append the full summary
      // verbatim in BOTH content types.
      //
      // Skipped when Reason already IS the summary: with no call_reason, `reason` falls
      // back to call.summary above, and printing the same paragraph twice reads like a
      // formatting bug in the chart.
      const summaryText = nonEmpty(call.summary) ? call.summary.trim() : '';
      if (summaryText && summaryText !== String(reason).trim()) {
        note += `\n\nSummary:\n${summaryText}`;
      }

      // Transcript sends (item 4, contentType 'transcript') append the full transcript —
      // deliberately a large note. Legacy includeTranscript flag honored for compatibility.
      if ((options.contentType === 'transcript' || options.includeTranscript) && nonEmpty(call.transcript)) {
        // Only write the section if it has content. A header with nothing under it
        // reads like the note was truncated, which is worse than omitting it.
        const body = this.formatTranscriptForCommLog(call.transcript, call.transcript_json);
        if (nonEmpty(body)) {
          note += `\n\n--- Full transcript ---\n${body}`;
        }
      }
    }

    return {
      CommDateTime: call.call_date,
      Mode_: 0, // 0 = None, 1 = Email, 2 = Text, 3 = Phone
      SentOrReceived: 1, // 1 = Received
      // Sanitize so the preview (this note) === what OD stores, mojibake-free.
      Note: sanitizeForOd(note.trim()),
      CommType: this.getCommType(call),
      UserNum: 0, // System user
      DateTimeEnd: call.call_date,
      // Custom fields if supported
      IsNewPatient: call.is_new_patient ? 1 : 0
    };
  }

  /**
   * Format a timestamp in the OFFICE timezone for the chart note. Both offices
   * (Roland OK, Valley/Riley Fort Smith AR) are US Central; OFFICE_TIMEZONE env
   * overrides if that ever changes. Falls back to ISO on a bad date.
   * @param {string|Date} when
   * @returns {string}
   */
  formatOfficeDateTime(when) {
    const tz = process.env.OFFICE_TIMEZONE || 'America/Chicago';
    try {
      return new Date(when).toLocaleString('en-US', {
        timeZone: tz,
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch {
      try { return new Date(when).toISOString(); } catch { return String(when); }
    }
  }

  /**
   * Format transcript for CommLog (plain text).
   *
   * Reads the canonical transcript_json shape (utils/transcriptShape.js), but
   * normalizes defensively rather than assuming: rows transcribed before that
   * normalization shipped are still in the store in a producer-specific shape,
   * and a call outside the hourly re-ingest window never gets healed. This is a
   * chart write — it has to be right for data that already exists, not only for
   * data written from now on.
   *
   * Renders nothing at all for an empty transcript. It used to render a line per
   * entry unconditionally, which is how an unrecognized shape became a wall of
   * `[] 👤 Caller: undefined` in a patient's chart.
   *
   * @param {unknown} transcript plain-text transcript (the fallback)
   * @param {unknown} transcriptJson structured transcript, any historical shape
   * @returns {string}
   */
  formatTranscriptForCommLog(transcript, transcriptJson) {
    const entries = normalizeTranscriptJson(transcriptJson);

    if (entries) {
      const lines = entries.map((e) => {
        // Who spoke. A role is a claim ("this is the agent"); a diarization index
        // is only "this is a different voice". Say whichever we actually know,
        // and never upgrade an index into a role.
        const who = e.role === 'agent'
          ? '🤖 Agent'
          : e.role === 'user'
          ? '👤 Caller'
          : e.speaker !== null
          ? `Speaker ${e.speaker + 1}`
          : 'Speaker';
        // Timing only when the shape carried it — the legacy path never did, and
        // printing an empty "[] " on every line was noise in the chart note.
        const stamp = e.start !== null ? `[${formatClock(e.start)}] ` : '';
        return `${stamp}${who}: ${e.content}`;
      });
      // An empty structured transcript is NOT an error — it means nothing was
      // recognized. Fall through to the plain text if there is any.
      if (lines.length > 0) return lines.join('\n');
    }

    if (typeof transcript === 'string') {
      return transcript;
    }

    return 'Transcript not available';
  }

  /**
   * Get CommType based on call characteristics
   */
  getCommType(call) {
    // Open Dental CommTypes (varies by installation, these are common defaults)
    // 0 = None, 1 = Misc, 2 = Appt Related, etc.
    
    const reason = (call.call_reason || call.summary || '').toLowerCase();
    
    if (reason.includes('appointment') || reason.includes('schedule') || reason.includes('book')) {
      return 2; // Appt Related
    }
    if (reason.includes('insurance') || reason.includes('billing') || reason.includes('payment')) {
      return 3; // Financial/Insurance
    }
    if (reason.includes('emergency') || reason.includes('pain') || reason.includes('urgent')) {
      return 4; // Emergency
    }
    
    return 1; // Misc
  }

  /**
   * Create a CommLog in Open Dental, choosing the right transport for the active mode:
   *   - direct-DB mode  -> insertCommLogToDatabase (unchanged integer-column INSERT)
   *   - api mode        -> POST /commlogs with the real API payload (string enums)
   *
   * This is the single entry point for writing a commlog. The previous webhook path
   * called insertCommLogToDatabase directly, which silently failed in api mode
   * ("Database pool not available") so call summaries never reached OD on api-mode
   * tenants. See docs/OD_API_CONTRACT.md §10.
   *
   * `options.commTypeDefNum` is an ALREADY-VALIDATED chart-note type (see
   * commlogTypes.assertAllowed). This method does not validate — it is the
   * transport, and a caller that reaches it with an unchecked DefNum would be a
   * bug in the caller, not something to paper over here. Omitted, the office's
   * configured default is written.
   *
   * @param {string|number} patientId
   * @param {Record<string, unknown>} commLogEntry
   * @param {import('../config/odOffices').OdOfficeHandle} od
   * @param {{ commTypeDefNum?: number|null }} [options]
   */
  async createCommLog(patientId, commLogEntry, od, options = {}) {
    // An office-bound connection is REQUIRED. There is no "default office" for a
    // chart write — a caller that cannot say which practice this note belongs in
    // must not be allowed to guess.
    if (!od || !od.officeKey || !od.client) {
      return { success: false, error: 'No Open Dental office connection supplied for this write' };
    }

    // Final OD-safety net: sanitize the note at the single write boundary, so every
    // path (generated, user-edited, legacy auto-write) lands mojibake-free. Idempotent.
    if (commLogEntry && typeof commLogEntry.Note === 'string') {
      commLogEntry = { ...commLogEntry, Note: sanitizeForOd(commLogEntry.Note) };
    }

    const chosenDefNum = Number.isInteger(options.commTypeDefNum) ? options.commTypeDefNum : null;

    if (od.client.useDatabase && od.client.pool) {
      // Direct-DB mode's CommType has always come off the entry (the legacy
      // getCommType heuristic). A user's explicit pick overrides it; with no
      // pick, that path is left exactly as it was.
      return this.insertCommLogToDatabase(
        patientId,
        chosenDefNum === null ? commLogEntry : { ...commLogEntry, CommType: chosenDefNum },
        od
      );
    }

    if (od.client.client) {
      try {
        const payload = this.buildCommLogApiPayload(patientId, commLogEntry, od, chosenDefNum);
        const response = await od.client.client.post('/commlogs', payload);
        return {
          success: true,
          commLogNum: response.data?.CommlogNum,
          message: 'CommLog entry created via API'
        };
      } catch (error) {
        console.error('[OD Sync] CommLog API create error:', error.response?.data || error.message);
        return { success: false, error: error.response?.data?.message || error.message };
      }
    }

    return { success: false, error: 'No Open Dental connection available' };
  }

  /**
   * Translate a DB-shaped commlog entry into the real OD POST /commlogs payload.
   * OD requires PatNum + Note; Mode_ and SentOrReceived are STRING enums (not the DB
   * integers); CommDateTime is "yyyy-MM-dd HH:mm:ss"; CommType is a definition.DefNum
   * (Category=27). These are CareIN inbound call summaries, so Mode_="Phone" and
   * SentOrReceived="Received" by intent. See docs/OD_API_CONTRACT.md §10.
   *
   * @param {string|number} patientId
   * @param {Record<string, unknown>} commLogEntry
   * @param {import('../config/odOffices').OdOfficeHandle} od
   * @param {number|null} [chosenDefNum] a validated user-picked commlog type;
   *   null/omitted writes this office's configured default.
   */
  buildCommLogApiPayload(patientId, commLogEntry, od, chosenDefNum = null) {
    const modeEnum = { 0: 'None', 1: 'Email', 2: 'Text', 3: 'Phone', 4: 'In Person', 5: 'Mail' };
    const Mode_ = typeof commLogEntry.Mode_ === 'string'
      ? commLogEntry.Mode_
      : (modeEnum[commLogEntry.Mode_] || 'Phone');

    return {
      PatNum: patientId,
      Note: commLogEntry.Note,
      CommDateTime: od.client.formatODDateTime(commLogEntry.CommDateTime),
      Mode_,
      SentOrReceived: 'Received', // inbound call summaries are always received
      // The type the user picked at the send step, else THIS OFFICE's "CareIN AI
      // Call" DefNum. Either way it is a DefNum from this practice's own database:
      // Roland's 486 is not a CommLogType in Riley's at all (Riley's is 451), and a
      // picked value only reaches here after commlogTypes.assertAllowed confirmed
      // it is in THIS office's list.
      CommType: Number.isInteger(chosenDefNum) ? chosenDefNum : od.commTypeDefNum
    };
  }

  /**
   * Insert CommLog directly into Open Dental database
   */
  async insertCommLogToDatabase(patientId, commLogEntry, od) {
    if (!od || !od.client || !od.client.pool) {
      return { success: false, error: 'Database pool not available' };
    }

    try {
      // Check if commlog table exists and get its structure
      const [columns] = await od.client.pool.execute("SHOW COLUMNS FROM commlog");
      const columnNames = columns.map(col => col.Field);

      // Build INSERT query based on available columns
      const insertFields = ['PatNum', 'CommDateTime', 'Note'];
      const insertValues = [patientId, commLogEntry.CommDateTime, commLogEntry.Note];
      const placeholders = ['?', '?', '?'];

      if (columnNames.includes('Mode_')) {
        insertFields.push('Mode_');
        insertValues.push(commLogEntry.Mode_ || 0);
        placeholders.push('?');
      }

      if (columnNames.includes('SentOrReceived')) {
        insertFields.push('SentOrReceived');
        insertValues.push(commLogEntry.SentOrReceived || 1);
        placeholders.push('?');
      }

      if (columnNames.includes('CommType')) {
        insertFields.push('CommType');
        insertValues.push(commLogEntry.CommType || 0);
        placeholders.push('?');
      }

      if (columnNames.includes('UserNum')) {
        insertFields.push('UserNum');
        insertValues.push(commLogEntry.UserNum || 0);
        placeholders.push('?');
      }

      if (columnNames.includes('DateTimeEnd')) {
        insertFields.push('DateTimeEnd');
        insertValues.push(commLogEntry.DateTimeEnd || commLogEntry.CommDateTime);
        placeholders.push('?');
      }

      const query = `INSERT INTO commlog (${insertFields.join(', ')}) VALUES (${placeholders.join(', ')})`;
      
      const [result] = await od.client.pool.execute(query, insertValues);

      return { 
        success: true, 
        commLogNum: result.insertId,
        message: 'CommLog entry created'
      };

    } catch (error) {
      console.error('[OD Sync] Database insert error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================================================
  // MANUAL PATIENT LINKING
  // ============================================================================

  /**
   * Manually link a call to a patient — in ONE named office, and nowhere else.
   *
   * That office is the call's own unless `options.targetOfficeKey` names another
   * (the cross-office chart target a human picked at the search step). Either way
   * the PatNum is verified to exist in THAT office's database before it is stored,
   * so a Roland PatNum pasted against Riley's database fails here rather than
   * silently linking to whichever Riley patient happens to hold the same number.
   *
   * `od_patient_office` is stamped from the office actually used, so the stored
   * PatNum never travels without the database it came from — which is the whole
   * reason a cross-office link is safe to persist at all.
   *
   * @param {string} callId
   * @param {string|number} patientId
   * @param {{ syncNow?: boolean, userId?: string, targetOfficeKey?: string,
   *           expectOfficeKey?: string }} [options]
   */
  async linkCallToPatient(callId, patientId, options = {}) {
    const call = unifiedCallStore.getCall(callId);

    if (!call) {
      return { success: false, error: 'Call not found' };
    }

    let od;
    try {
      od = odForTarget(call, options.targetOfficeKey);
      if (options.expectOfficeKey) {
        odOffices.assertOfficeMatch(options.expectOfficeKey, od);
      }
    } catch (err) {
      return {
        success: false,
        error: err.publicMessage || err.message,
        code: err.code,
        officeBlocked: true,
      };
    }

    // Verify the patient exists IN THIS OFFICE's database.
    const patient = await od.client.getPatientDetails(patientId);
    if (!patient) {
      return { success: false, error: 'Patient not found in Open Dental' };
    }

    // Update call with patient link. od_patient_office records WHICH database this
    // PatNum came from — without it a stored PatNum is ambiguous across practices.
    unifiedCallStore.updateCall(callId, {
      od_patient_id: patientId,
      od_patient_name: patient.fullName,
      od_patient_office: od.officeKey,
      od_linked_manually: true,
      od_linked_at: new Date().toISOString(),
      od_linked_by: options.userId || 'system'
    });

    // Optionally sync to CommLog immediately
    if (options.syncNow) {
      const syncResult = await this.syncCallToCommLog(callId, { force: true, ...options });
      return { 
        success: true, 
        message: 'Patient linked and synced',
        patient,
        syncResult
      };
    }

    return { 
      success: true, 
      message: 'Patient linked successfully',
      patient
    };
  }

  /**
   * Unlink a call from a patient
   */
  async unlinkCallFromPatient(callId) {
    const call = unifiedCallStore.getCall(callId);
    
    if (!call) {
      return { success: false, error: 'Call not found' };
    }

    unifiedCallStore.updateCall(callId, {
      od_patient_id: null,
      od_patient_name: null,
      od_patient_office: null,
      od_linked_manually: false,
      od_linked_at: null,
      od_sync_status: 'unlinked'
    });

    return { success: true, message: 'Patient unlinked' };
  }

  // ============================================================================
  // PATIENT CALL HISTORY
  // ============================================================================

  /**
   * Get all calls for a specific patient IN ONE OFFICE.
   *
   * A bare PatNum does not identify a person across practices, so this read is
   * office-scoped on both halves: calls are matched on (PatNum, office) and the
   * patient record is fetched from that office's database.
   *
   * @param {string|number} patientId
   * @param {{ limit?: number, officeKey?: string }} [options] officeKey is REQUIRED
   *   to reach Open Dental; without it the call list is still returned but the
   *   patient record is not fetched (nothing to fetch it from).
   */
  async getPatientCallHistory(patientId, options = {}) {
    const allCalls = unifiedCallStore.getAllCalls();
    const officeKey = options.officeKey || null;

    // Filter calls linked to this patient — same PatNum AND same office.
    const patientCalls = allCalls.filter(call =>
      (call.od_patient_id === patientId || call.od_patient_id === String(patientId)) &&
      (!officeKey || this.patientOfficeMatches(call, officeKey))
    );

    // Sort by date descending
    patientCalls.sort((a, b) => new Date(b.call_date) - new Date(a.call_date));

    // Apply limit if specified
    const limit = options.limit || 50;
    const limited = patientCalls.slice(0, limit);

    // Get patient details from THIS office's database.
    let patient = null;
    if (officeKey) {
      try {
        const od = odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
        patient = await od.client.getPatientDetails(patientId);
      } catch (e) {
        console.error('[OD Sync] Failed to get patient details:', e.message);
      }
    }

    return {
      patient,
      calls: limited,
      totalCalls: patientCalls.length,
      stats: {
        totalCalls: patientCalls.length,
        aiCalls: patientCalls.filter(c => c.handler_type === 'ai').length,
        staffCalls: patientCalls.filter(c => c.handler_type === 'staff').length,
        emergencyCalls: patientCalls.filter(c => c.is_emergency).length,
        lastCallDate: patientCalls[0]?.call_date
      }
    };
  }

  /**
   * Search for calls that might belong to a patient (for linking suggestions).
   *
   * Office-scoped on both ends: the patient is read from `officeKey`'s database,
   * and only calls belonging to that same office can be suggested — suggesting a
   * Roland call for a Riley patient would invite exactly the wrong link.
   *
   * @param {string|number} patientId
   * @param {string} officeKey
   */
  async findPotentialCallsForPatient(patientId, officeKey) {
    const od = odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
    const patient = await od.client.getPatientDetails(patientId);
    if (!patient) return [];

    const allCalls = unifiedCallStore.getAllCalls();

    // Find unlinked calls that might match this patient
    const potentialMatches = allCalls.filter(call => {
      // Skip already linked calls
      if (call.od_patient_id) return false;

      // Only ever suggest calls from the SAME office as the patient.
      if (getOfficeForCall(call) !== officeKey) return false;

      // Check phone match
      if (patient.phone && call.caller_number) {
        const patientPhone = this.cleanPhoneNumber(patient.phone);
        const callPhone = this.cleanPhoneNumber(call.caller_number);
        if (patientPhone === callPhone) return true;
      }

      // Check name match
      if (call.caller_name && patient.fullName) {
        const similarity = this.calculateNameSimilarity(
          this.normalizeName(call.caller_name),
          this.normalizeName(patient.fullName)
        );
        if (similarity >= 0.7) return true;
      }

      return false;
    });

    return potentialMatches.slice(0, 20); // Limit to 20 suggestions
  }

  // ============================================================================
  // BATCH SYNC
  // ============================================================================

  /**
   * Sync all unsynced calls that have patient matches
   */
  async syncAllPendingCalls(options = {}) {
    const allCalls = unifiedCallStore.getAllCalls();
    
    // Find calls that need syncing
    const pendingCalls = allCalls.filter(call => 
      !call.od_sync_status || 
      call.od_sync_status === 'pending' ||
      call.od_sync_status === 'pending_match'
    );

    console.log(`[OD Sync] Found ${pendingCalls.length} calls pending sync`);

    const results = {
      total: pendingCalls.length,
      synced: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    for (const call of pendingCalls) {
      if (options.limit && results.synced >= options.limit) break;

      try {
        const result = await this.syncCallToCommLog(call.id, options);
        
        if (result.success) {
          results.synced++;
        } else if (result.requiresManualLink) {
          results.skipped++;
        } else {
          results.failed++;
          results.errors.push({ callId: call.id, error: result.error });
        }

        // Small delay to avoid overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        results.failed++;
        results.errors.push({ callId: call.id, error: error.message });
      }
    }

    console.log(`[OD Sync] Batch sync complete: ${results.synced} synced, ${results.failed} failed, ${results.skipped} skipped`);
    
    return results;
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  cleanPhoneNumber(phone) {
    if (!phone) return '';
    return phone.replace(/\D/g, '').slice(-10); // Last 10 digits
  }

  normalizeName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  calculateNameSimilarity(name1, name2) {
    if (!name1 || !name2) return 0;
    
    // Simple Jaccard similarity on words
    const words1 = new Set(name1.split(' ').filter(w => w.length > 1));
    const words2 = new Set(name2.split(' ').filter(w => w.length > 1));
    
    if (words1.size === 0 || words2.size === 0) return 0;
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  addToHistory(entry) {
    this.syncHistory.unshift(entry);
    if (this.syncHistory.length > this.maxHistorySize) {
      this.syncHistory.pop();
    }
  }

  getStats() {
    return {
      ...this.stats,
      queueLength: this.syncQueue.length,
      historyCount: this.syncHistory.length
    };
  }

  getHistory(limit = 20) {
    return this.syncHistory.slice(0, limit);
  }

  // ============================================================================
  // SYNC STATUS QUERIES
  // ============================================================================

  /**
   * Get sync status for all calls
   */
  getSyncOverview() {
    const allCalls = unifiedCallStore.getAllCalls();
    
    const overview = {
      total: allCalls.length,
      synced: 0,
      pending: 0,
      pendingMatch: 0,
      error: 0,
      unlinked: 0
    };

    for (const call of allCalls) {
      switch (call.od_sync_status) {
        case 'synced':
          overview.synced++;
          break;
        case 'pending':
          overview.pending++;
          break;
        case 'pending_match':
          overview.pendingMatch++;
          break;
        case 'error':
          overview.error++;
          break;
        default:
          overview.unlinked++;
      }
    }

    return overview;
  }

  /**
   * Get calls that need manual patient linking
   */
  getCallsNeedingManualLink() {
    const allCalls = unifiedCallStore.getAllCalls();
    return allCalls.filter(call =>
      call.od_sync_status === 'pending_match' ||
      (!call.od_patient_id && !call.od_sync_status)
    );
  }

  // ==========================================================================
  // PATIENT ↔ OFFICE PAIRING
  //
  // od_patient_id is meaningless on its own: PatNum numbering restarts in every
  // Open Dental database. Verified live 2026-08-07 — PatNum 7115 is "Stedi
  // TestValley" in Riley and a DIFFERENT real patient in Roland. So every stored
  // PatNum is written together with od_patient_office, and every read of one
  // checks that pairing before it is allowed to reach a chart.
  // ==========================================================================

  /**
   * The office a call's stored PatNum belongs to.
   *
   * LEGACY ROWS: calls matched before this slice carry no od_patient_office. Every
   * such match was produced by the single process-wide OD client, which was bound
   * to ROLAND — so an absent value is read as 'roland'. That assumption is what
   * makes the guard below fire (rather than silently pass) on the genuinely
   * dangerous rows: valley-attributed calls that were auto-matched against
   * Roland's database while valley had no OD connection of its own.
   *
   * @param {{od_patient_office?: string|null}} call
   * @returns {string}
   */
  patientOfficeOf(call) {
    const stored = call && call.od_patient_office;
    return typeof stored === 'string' && stored ? stored : 'roland';
  }

  /**
   * Whether a call's stored PatNum came from the office we are about to use.
   * A call with no stored PatNum has nothing to disagree about → true.
   * @param {{od_patient_id?: any, od_patient_office?: string|null}} call
   * @param {string} officeKey
   * @returns {boolean}
   */
  patientOfficeMatches(call, officeKey) {
    if (!call || call.od_patient_id == null || call.od_patient_id === '') return true;
    return this.patientOfficeOf(call) === officeKey;
  }

  // ==========================================================================
  // SOURCE-AGNOSTIC MATCH → STATUS (review-then-send)
  // ==========================================================================

  /**
   * Match a call to a patient and persist the resulting review-then-send status onto
   * the unified call — WITHOUT writing to Open Dental. Used by BOTH the Retell
   * (call_analyzed) and Mango (post-analysis) paths so a Mango call lands in the Slice B
   * worklist with exactly the same shape Retell produces.
   *
   *   confident + unambiguous  -> od_sync_status = 'matched'   + od_patient_id/name/confidence
   *   ambiguous / weak / none  -> od_sync_status = 'needs_review' + od_match_candidates
   *
   * Idempotent-safe callers should skip already-'synced' calls before invoking (a human
   * Send-to-chart is terminal). Never throws for a missing patient; surfaces OD errors.
   *
   * OFFICE: the call is matched against ITS OWN office's Open Dental database. A call
   * whose office has no OD connection (unknown line, office not switched on, key not
   * shipped) is NOT matched at all — it is parked in 'office_not_connected' with an
   * honest reason instead of being quietly matched against some other practice's
   * patients, which is what happened before this slice.
   *
   * ALREADY LINKED: a call that already carries an od_patient_id is left alone and
   * returns 'already_linked'. This is a MATCHER — it answers "who is this?" for a
   * call nobody has answered it for. Once there IS an answer, re-running it can only
   * overwrite one, and it re-matches in the CALL's office, so a caller deliberately
   * linked to the other practice's patient would be silently re-pointed at whoever
   * holds the caller's phone number over here — within the hour, by the Mango sync,
   * with nothing on screen to show it happened. The check lives here rather than in
   * the four call sites because three of them only skipped 'synced', and the failure
   * mode of forgetting it is invisible.
   *
   * @param {string} callId  unified-store id
   * @param {{caller_number?: string, caller_name?: string}} matchInput
   * @returns {Promise<{status:'matched'|'needs_review'|'office_not_connected'|'already_linked', patient?:object, matchResult?:object, candidates?:Array}>}
   */
  async matchAndSetStatus(callId, matchInput = {}) {
    const call = unifiedCallStore.getCall(callId);
    if (!call) {
      return { status: 'needs_review', needsReview: true, candidates: [], matchResult: null };
    }

    if (call.od_patient_id !== undefined && call.od_patient_id !== null && call.od_patient_id !== '') {
      return {
        status: 'already_linked',
        skipped: true,
        patientId: call.od_patient_id,
        officeKey: this.patientOfficeOf(call),
      };
    }

    let od;
    try {
      od = odForCall(call);
    } catch (err) {
      // No OD for this call's office. Record why, match nothing, write nothing.
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'office_not_connected',
        od_office_blocked_reason: err.publicMessage || err.message,
        od_sync_attempted_at: new Date().toISOString(),
      });
      return {
        status: 'office_not_connected',
        officeBlocked: true,
        code: err.code,
        reason: err.publicMessage || err.message,
      };
    }

    const matchResult = await this.matchCallToPatient(
      {
        caller_number: matchInput.caller_number,
        caller_name: matchInput.caller_name || 'Unknown',
      },
      od
    );

    if (!isConfidentUnambiguousMatch(matchResult)) {
      const candidates = buildMatchCandidates(matchResult);
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'needs_review',
        od_match_candidates: candidates,
        od_match_confidence: matchResult ? (matchResult.confidence || 0) : 0,
        od_office_blocked_reason: null,
        od_sync_attempted_at: new Date().toISOString(),
      });
      return { status: 'needs_review', needsReview: true, candidates, matchResult };
    }

    const patient = matchResult.patient;
    const matchedName =
      patient.fullName || [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim() || null;
    unifiedCallStore.updateCall(callId, {
      od_sync_status: 'matched',
      od_patient_id: patient.id,
      od_patient_name: matchedName,
      // The PatNum above only means something paired with this office.
      od_patient_office: od.officeKey,
      od_match_confidence: matchResult.confidence,
      od_office_blocked_reason: null,
      od_sync_attempted_at: new Date().toISOString(),
    });
    return { status: 'matched', matched: true, patient, matchResult };
  }
}

const openDentalSyncService = new OpenDentalSyncService();

// Expose the shared match helpers (used by the Retell webhook path + unit tests).
openDentalSyncService.isConfidentUnambiguousMatch = isConfidentUnambiguousMatch;
openDentalSyncService.buildMatchCandidates = buildMatchCandidates;
openDentalSyncService.CONFIDENT_WRITE_MIN = CONFIDENT_WRITE_MIN;
// Office resolution for a stored call — the ONE way the voice path gets an OD
// client. Exposed so route handlers (which need the office before they touch the
// service) resolve it exactly the same way this service does, instead of
// re-deriving it and risking a second, divergent answer.
openDentalSyncService.odForCall = odForCall;
// Where a chart action goes when nobody named a target. Exposed for the same reason
// odForCall is: the route needs the answer BEFORE it calls the service (to name the
// office in the response and on the audit row), and a route that computed its own
// would be a second definition of the default — which is exactly the bug this
// function was extracted to close.
openDentalSyncService.defaultTargetOfficeFor = defaultTargetOfficeFor;

module.exports = openDentalSyncService;

