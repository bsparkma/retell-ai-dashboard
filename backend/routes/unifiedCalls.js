/**
 * Unified Calls API Route
 * 
 * Provides endpoints to query calls from all sources (Retell AI + Mango Voice staff calls)
 * with unified filtering, sorting, and pagination.
 */

const express = require('express');
const router = express.Router();
const unifiedCallStore = require('../services/unifiedCallStore');
const retellService = require('../config/retell');
const audit = require('../platform/audit');
const { filterCallsForOffice, getOfficeConfig } = require('../config/officeAgents');

// --- Caller Name Extraction Utilities (copied from calls.js) ---

/**
 * Convert transcript_json (array of {role, content} objects) to plain text transcript
 */
const transcriptJsonToText = (transcriptJson) => {
  if (!transcriptJson || !Array.isArray(transcriptJson)) return '';
  return transcriptJson
    .map(entry => `${entry.role || 'unknown'}: ${entry.content || ''}`)
    .join(' ');
};

/**
 * Basic regex-based name extraction from transcript
 */
const extractCallerNameBasic = (transcript, callerNumber) => {
  if (!transcript) return callerNumber;

  const agentNames = ['karen', 'assistant', 'agent', 'bot', 'ai', 'system', 'operator'];

  const callerPatterns = [
    /(?:user|caller):\s*.*?(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*.*?(?:call me|it's|name's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*(?:hi|hello),?\s*(?:my name is|i'm|this is)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?<!agent:.*?)(?:my name is|i'm|this is|i am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i,
    /(?:user|caller):\s*(?:hi|hello),?\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+(?:here|speaking|calling)/i,
    /(?:user|caller):\s*(?:this is|it's)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i
  ];

  for (const pattern of callerPatterns) {
    const match = transcript.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().toLowerCase();
      const commonWords = ['okay', 'yes', 'no', 'sure', 'well', 'um', 'uh', 'the', 'that', 'this', 'here', 'calling'];
      if (name.length > 1 &&
          !commonWords.includes(name) &&
          !agentNames.includes(name)) {
        return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      }
    }
  }

  return callerNumber;
};

/**
 * Extract name from call summary
 */
const extractNameFromSummary = (summary) => {
  if (!summary) return null;

  const summaryPatterns = [
    /(?:patient|caller),\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})(?:,|\s+(?:called|requested|asked|provided|said)\b)/,
    /(?:patient|caller)\s+named\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\b/,
    /Mr\.?\s+([A-Z][a-zA-Z]+)/i,
    /Mrs\.?\s+([A-Z][a-zA-Z]+)/i,
    /Ms\.?\s+([A-Z][a-zA-Z]+)/i,
    /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\s+(?:called|requested|asked|provided)\b/,
    /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\s+is\s+(?:calling|requesting|asking)\b/
  ];

  for (const pattern of summaryPatterns) {
    const match = summary.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      const commonWords = ['Patient', 'Caller', 'Person', 'User', 'Someone', 'Individual', 'The Caller', 'The Patient'];
      if (!commonWords.includes(name) && !/\b(reached|provided|requested|called|assistant|office|appointment|number)\b/i.test(name)) {
        return name;
      }
    }
  }

  return null;
};

/**
 * Advanced name extraction using context analysis
 */
const extractNameAdvanced = (transcript, summary) => {
  if (!transcript && !summary) return null;

  const fullText = `${transcript || ''} ${summary || ''}`;

  const advancedPatterns = [
    /(?:agent|assistant):\s*.*?(?:thank you|hello|hi),?\s+([A-Z][a-zA-Z]+)/i,
    /(?:agent|assistant):\s*.*?I(?:'ll|'d)\s+(?:be happy to\s+)?help\s+you,?\s+([A-Z][a-zA-Z]+)/i,
    /(?:appointment|booking|schedule).*?for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:prescription|medication|refill).*for\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:patient|caller),\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*(?:,|\s+(?:needs|wants|requires|is)\b)/
  ];

  for (const pattern of advancedPatterns) {
    const match = fullText.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name.length > 1 && !/^\d/.test(name)) {
        return name;
      }
    }
  }

  return null;
};

/**
 * Apply caller name extraction to a single call object.
 * Mutates and returns the call.
 */
const enrichCallerName = (call) => {
  if (call.caller_name && call.caller_name !== 'Unknown' && call.caller_name !== call.caller_number) {
    return call;
  }

  // Build a text transcript from transcript_json if transcript is missing
  let transcript = call.transcript || '';
  if (!transcript && call.transcript_json) {
    transcript = transcriptJsonToText(call.transcript_json);
  }

  const summary = call.summary || call.call_summary || '';

  // Try summary first
  const fromSummary = extractNameFromSummary(summary);
  if (fromSummary) {
    call.caller_name = fromSummary;
    return call;
  }

  // Try basic transcript extraction
  const fromTranscript = extractCallerNameBasic(transcript, call.caller_number || 'Unknown');
  if (fromTranscript !== call.caller_number && fromTranscript !== 'Unknown') {
    call.caller_name = fromTranscript;
    return call;
  }

  // Try advanced extraction
  const fromAdvanced = extractNameAdvanced(transcript, summary);
  if (fromAdvanced) {
    call.caller_name = fromAdvanced;
    return call;
  }

  return call;
};

// --- End Caller Name Extraction Utilities ---

/**
 * GET /api/unified-calls
 * Get all calls with optional filters
 * 
 * Query params:
 * - source: 'retell' | 'mango' | 'all' (default: 'all')
 * - handler_type: 'ai' | 'staff' | 'all' (default: 'all')
 * - start_date: ISO date string
 * - end_date: ISO date string
 * - sentiment: 'positive' | 'neutral' | 'negative'
 * - limit: number (default: 50)
 * - offset: number (default: 0)
 * - sort_by: field name (default: 'call_date')
 * - sort_order: 'asc' | 'desc' (default: 'desc')
 * - office_id: string (for office-specific filtering)
 */
router.get('/', async (req, res) => {
  try {
    const {
      source,
      handler_type,
      start_date,
      end_date,
      sentiment,
      outcome,
      is_emergency,
      callback_required,
      limit = 50,
      offset = 0,
      sort_by = 'call_date',
      sort_order = 'desc',
      office_id,
      search,
    } = req.query;

    // Build filter options
    const options = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      sortBy: sort_by,
      sortOrder: sort_order,
    };

    // Add source filter
    if (source && source !== 'all') {
      options.source = source;
    }

    // Add handler type filter
    if (handler_type && handler_type !== 'all') {
      options.handlerType = handler_type;
    }

    // Add date filters
    if (start_date) {
      options.startDate = start_date;
    }
    if (end_date) {
      options.endDate = end_date;
    }

    // Add other filters
    if (sentiment) {
      options.sentiment = sentiment;
    }
    if (outcome) {
      options.outcome = outcome;
    }
    if (is_emergency !== undefined) {
      options.isEmergency = is_emergency === 'true';
    }
    if (callback_required !== undefined) {
      options.callbackRequired = callback_required === 'true';
    }

    // Get calls from unified store
    let result = unifiedCallStore.getCalls(options);

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      result.calls = result.calls.filter(call =>
        call.caller_name?.toLowerCase().includes(searchLower) ||
        call.caller_number?.includes(search) ||
        call.summary?.toLowerCase().includes(searchLower) ||
        call.transcript?.toLowerCase().includes(searchLower)
      );
      result.total = result.calls.length;
    }

    // Apply caller name extraction to calls missing names
    result.calls = result.calls.map(enrichCallerName);

    // Apply office filtering if provided
    if (office_id) {
      result.calls = filterCallsForOffice(result.calls, office_id);
      result.total = result.calls.length;
    }

    // Add store stats
    const stats = unifiedCallStore.getStats();

    // HIPAA audit: the list returns call records (caller names/transcripts = PHI).
    await audit.audit(req, { action: 'READ', resourceType: 'call', resourceId: null, result: 'SUCCESS' });

    res.json({
      calls: result.calls,
      total: result.total,
      pagination: result.pagination,
      stats: {
        bySource: stats.bySource,
        byHandler: stats.byHandler,
        lastSync: stats.lastSync,
      },
      office_config: office_id ? getOfficeConfig(office_id) : null,
    });
  } catch (error) {
    console.error('Error fetching unified calls:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

/**
 * GET /api/unified-calls/stats
 * Get unified call statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = unifiedCallStore.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching call stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/unified-calls/:id
 * Get a specific call by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const call = unifiedCallStore.getCall(id);

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Apply caller name extraction if name is missing
    enrichCallerName(call);

    // HIPAA audit: this returns a full call record (transcript = PHI). Audited
    // before responding; a failed audit write fails closed (no PHI returned).
    await audit.audit(req, { action: 'READ', resourceType: 'call', resourceId: id, result: 'SUCCESS' });

    res.json(call);
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({ error: 'Failed to fetch call' });
  }
});

/**
 * GET /api/unified-calls/phone/:phoneNumber
 * Get all calls for a specific phone number
 */
router.get('/phone/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const calls = unifiedCallStore.getCallsByPhone(phoneNumber);

    // HIPAA audit: phone lookup returns patient call data. resource_id is null —
    // the phone number itself is PHI and must not be stored in the audit log.
    await audit.audit(req, { action: 'READ', resourceType: 'call', resourceId: null, result: 'SUCCESS' });

    res.json({
      phone: phoneNumber,
      calls: calls,
      total: calls.length,
    });
  } catch (error) {
    console.error('Error fetching calls by phone:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

/**
 * POST /api/unified-calls/sync-retell
 * Manually trigger a sync from Retell API
 */
router.post('/sync-retell', async (req, res) => {
  try {
    const { limit = 1000, start_time, end_time } = req.body;

    console.log('🔄 Starting manual Retell sync...');

    const params = { limit };
    if (start_time) params.start_time = start_time;
    if (end_time) params.end_time = end_time;

    const apiResponse = await retellService.getCalls(params);
    
    let addedCount = 0;
    for (const call of apiResponse) {
      const stored = unifiedCallStore.addRetellCall(call);
      if (stored) addedCount++;
    }

    await unifiedCallStore.persist();

    const stats = unifiedCallStore.getStats();

    res.json({
      success: true,
      message: `Synced ${addedCount} calls from Retell`,
      stats: stats,
    });
  } catch (error) {
    console.error('Error syncing from Retell:', error);
    res.status(500).json({ error: 'Failed to sync from Retell' });
  }
});

/**
 * PATCH /api/unified-calls/:id
 * Update a call (for manual corrections, patient matching, etc.)
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Only allow certain fields to be updated
    const allowedUpdates = [
      'caller_name',
      'patient_id',
      'patient_matched_by',
      'is_new_patient',
      'call_reason',
      'summary',
      'callback_required',
      'callback_reason',
      'qa_score',
    ];

    const filteredUpdates = {};
    for (const key of allowedUpdates) {
      if (updates[key] !== undefined) {
        filteredUpdates[key] = updates[key];
      }
    }

    const updatedCall = unifiedCallStore.updateCall(id, filteredUpdates);

    if (!updatedCall) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json(updatedCall);
  } catch (error) {
    console.error('Error updating call:', error);
    res.status(500).json({ error: 'Failed to update call' });
  }
});

module.exports = router;

