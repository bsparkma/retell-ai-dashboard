/**
 * Open Dental Sync Service
 * 
 * Handles syncing call data (transcripts, summaries) to Open Dental patient records
 * via CommLog entries. Also provides enhanced patient matching capabilities.
 */

const openDentalService = require('../config/openDental');
const unifiedCallStore = require('./unifiedCallStore');
const { sanitizeForOd } = require('../utils/sanitizeForOd');

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
    // (Category=27) and is PRACTICE-SPECIFIC — it differs per OD database (Roland vs
    // Valley), so it must be resolved per-connected-database and never hardcoded blindly.
    // Defaults to the CareIN convention DefNum 486; override per tenant via env.
    // See docs/OD_API_CONTRACT.md §10.
    this.careinCommType = parseInt(process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM || '486', 10);
  }

  // ============================================================================
  // ENHANCED PATIENT MATCHING
  // ============================================================================

  /**
   * Match a call to a patient using multiple strategies
   * Returns the best matching patient or null
   */
  async matchCallToPatient(call) {
    if (!openDentalService.isEnabled()) {
      return { patient: null, confidence: 0, method: 'disabled' };
    }

    const strategies = [
      { name: 'phone_exact', fn: () => this.matchByPhoneExact(call.caller_number) },
      { name: 'name_phone', fn: () => this.matchByNameAndPhone(call.caller_name, call.caller_number) },
      { name: 'name_fuzzy', fn: () => this.matchByNameFuzzy(call.caller_name) }
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
   * Match patient by exact phone number
   */
  async matchByPhoneExact(phoneNumber) {
    if (!phoneNumber) return { patient: null, confidence: 0 };

    // Clean the phone number
    const cleanPhone = this.cleanPhoneNumber(phoneNumber);
    if (cleanPhone.length < 10) return { patient: null, confidence: 0 };

    try {
      const patients = await openDentalService.searchPatients(cleanPhone);
      
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
   * Match patient by name AND phone (higher confidence)
   */
  async matchByNameAndPhone(callerName, phoneNumber) {
    if (!callerName || !phoneNumber) return { patient: null, confidence: 0 };

    const cleanPhone = this.cleanPhoneNumber(phoneNumber);
    const normalizedName = this.normalizeName(callerName);

    try {
      // Search by phone first
      const phoneMatches = await openDentalService.searchPatients(cleanPhone);
      
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
   * Match patient by name only (fuzzy matching)
   */
  async matchByNameFuzzy(callerName) {
    if (!callerName || callerName.length < 3) return { patient: null, confidence: 0 };

    const normalizedName = this.normalizeName(callerName);
    
    // Skip common non-name values
    const skipValues = ['unknown', 'caller', 'patient', 'customer', 'user', 'guest'];
    if (skipValues.some(skip => normalizedName.toLowerCase().includes(skip))) {
      return { patient: null, confidence: 0 };
    }

    try {
      const patients = await openDentalService.searchPatients(callerName);
      
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
   * Sync a call's transcript and summary to Open Dental CommLog
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

    // Match to patient if not already matched
    let patientId = call.od_patient_id;
    let matchResult = null;

    if (!patientId) {
      matchResult = await this.matchCallToPatient(call);
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
      const result = await this.createCommLog(patientId, commLogEntry);

      if (!result.success) {
        throw new Error(result.error || 'CommLog create failed');
      }

      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'synced',
        od_patient_id: patientId,
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

      // Transcript sends (item 4, contentType 'transcript') append the full transcript —
      // deliberately a large note. Legacy includeTranscript flag honored for compatibility.
      if ((options.contentType === 'transcript' || options.includeTranscript) && nonEmpty(call.transcript)) {
        note += `\n\n--- Full transcript ---\n${this.formatTranscriptForCommLog(call.transcript, call.transcript_json)}`;
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
   * Format transcript for CommLog (plain text)
   */
  formatTranscriptForCommLog(transcript, transcriptJson) {
    if (transcriptJson && Array.isArray(transcriptJson)) {
      return transcriptJson.map(msg => {
        const role = msg.role === 'agent' ? '🤖 Agent' : '👤 Caller';
        const timestamp = msg.timestamp || '';
        return `[${timestamp}] ${role}: ${msg.content}`;
      }).join('\n');
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
   */
  async createCommLog(patientId, commLogEntry) {
    // Final OD-safety net: sanitize the note at the single write boundary, so every
    // path (generated, user-edited, legacy auto-write) lands mojibake-free. Idempotent.
    if (commLogEntry && typeof commLogEntry.Note === 'string') {
      commLogEntry = { ...commLogEntry, Note: sanitizeForOd(commLogEntry.Note) };
    }
    if (openDentalService.useDatabase && openDentalService.pool) {
      return this.insertCommLogToDatabase(patientId, commLogEntry);
    }

    if (openDentalService.client) {
      try {
        const payload = this.buildCommLogApiPayload(patientId, commLogEntry);
        const response = await openDentalService.client.post('/commlogs', payload);
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
   */
  buildCommLogApiPayload(patientId, commLogEntry) {
    const modeEnum = { 0: 'None', 1: 'Email', 2: 'Text', 3: 'Phone', 4: 'In Person', 5: 'Mail' };
    const Mode_ = typeof commLogEntry.Mode_ === 'string'
      ? commLogEntry.Mode_
      : (modeEnum[commLogEntry.Mode_] || 'Phone');

    return {
      PatNum: patientId,
      Note: commLogEntry.Note,
      CommDateTime: openDentalService.formatODDateTime(commLogEntry.CommDateTime),
      Mode_,
      SentOrReceived: 'Received', // inbound call summaries are always received
      CommType: this.careinCommType
    };
  }

  /**
   * Insert CommLog directly into Open Dental database
   */
  async insertCommLogToDatabase(patientId, commLogEntry) {
    if (!openDentalService.pool) {
      return { success: false, error: 'Database pool not available' };
    }

    try {
      // Check if commlog table exists and get its structure
      const [columns] = await openDentalService.pool.execute("SHOW COLUMNS FROM commlog");
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
      
      const [result] = await openDentalService.pool.execute(query, insertValues);

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
   * Manually link a call to a patient
   */
  async linkCallToPatient(callId, patientId, options = {}) {
    const call = unifiedCallStore.getCall(callId);
    
    if (!call) {
      return { success: false, error: 'Call not found' };
    }

    // Verify patient exists
    const patient = await openDentalService.getPatientDetails(patientId);
    if (!patient) {
      return { success: false, error: 'Patient not found in Open Dental' };
    }

    // Update call with patient link
    unifiedCallStore.updateCall(callId, {
      od_patient_id: patientId,
      od_patient_name: patient.fullName,
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
   * Get all calls for a specific patient
   */
  async getPatientCallHistory(patientId, options = {}) {
    const allCalls = unifiedCallStore.getAllCalls();
    
    // Filter calls linked to this patient
    const patientCalls = allCalls.filter(call => 
      call.od_patient_id === patientId || 
      call.od_patient_id === String(patientId)
    );

    // Sort by date descending
    patientCalls.sort((a, b) => new Date(b.call_date) - new Date(a.call_date));

    // Apply limit if specified
    const limit = options.limit || 50;
    const limited = patientCalls.slice(0, limit);

    // Get patient details
    let patient = null;
    try {
      patient = await openDentalService.getPatientDetails(patientId);
    } catch (e) {
      console.error('[OD Sync] Failed to get patient details:', e.message);
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
   * Search for calls that might belong to a patient (for linking suggestions)
   */
  async findPotentialCallsForPatient(patientId) {
    const patient = await openDentalService.getPatientDetails(patientId);
    if (!patient) return [];

    const allCalls = unifiedCallStore.getAllCalls();
    
    // Find unlinked calls that might match this patient
    const potentialMatches = allCalls.filter(call => {
      // Skip already linked calls
      if (call.od_patient_id) return false;

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
   * @param {string} callId  unified-store id
   * @param {{caller_number?: string, caller_name?: string}} matchInput
   * @returns {Promise<{status:'matched'|'needs_review', patient?:object, matchResult:object, candidates?:Array}>}
   */
  async matchAndSetStatus(callId, matchInput = {}) {
    const matchResult = await this.matchCallToPatient({
      caller_number: matchInput.caller_number,
      caller_name: matchInput.caller_name || 'Unknown',
    });

    if (!isConfidentUnambiguousMatch(matchResult)) {
      const candidates = buildMatchCandidates(matchResult);
      unifiedCallStore.updateCall(callId, {
        od_sync_status: 'needs_review',
        od_match_candidates: candidates,
        od_match_confidence: matchResult ? (matchResult.confidence || 0) : 0,
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
      od_match_confidence: matchResult.confidence,
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

module.exports = openDentalSyncService;

