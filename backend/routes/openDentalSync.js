/**
 * Open Dental Sync Routes
 * 
 * API endpoints for syncing calls to Open Dental CommLog
 * and managing patient-call linking.
 */

const express = require('express');
const router = express.Router();
const openDentalSync = require('../services/openDentalSync');
const openDentalService = require('../config/openDental');
const unifiedCallStore = require('../services/unifiedCallStore');

// ============================================================================
// SYNC STATUS AND OVERVIEW
// ============================================================================

/**
 * Get sync overview - how many calls synced, pending, etc.
 */
router.get('/status', async (req, res) => {
  try {
    const overview = openDentalSync.getSyncOverview();
    const stats = openDentalSync.getStats();
    const history = openDentalSync.getHistory(10);
    
    res.json({
      success: true,
      overview,
      stats,
      recentHistory: history,
      openDentalEnabled: openDentalService.isEnabled(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[OD Sync Route] Status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get calls that need manual patient linking
 */
router.get('/pending-links', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const calls = openDentalSync.getCallsNeedingManualLink();
    
    // Limit and add match suggestions
    const limited = calls.slice(0, parseInt(limit));
    
    // For each call, try to get patient suggestions
    const callsWithSuggestions = await Promise.all(
      limited.map(async (call) => {
        let suggestions = [];
        
        try {
          // Try to find matching patients
          if (call.caller_number) {
            const phoneMatches = await openDentalService.searchPatients(
              openDentalSync.cleanPhoneNumber(call.caller_number)
            );
            suggestions.push(...phoneMatches.map(p => ({ ...p, matchType: 'phone' })));
          }
          
          if (call.caller_name && suggestions.length < 5) {
            const nameMatches = await openDentalService.searchPatients(call.caller_name);
            const newMatches = nameMatches.filter(
              nm => !suggestions.find(s => s.id === nm.id)
            );
            suggestions.push(...newMatches.map(p => ({ ...p, matchType: 'name' })));
          }
        } catch (e) {
          // Ignore match errors
        }
        
        return {
          ...call,
          patientSuggestions: suggestions.slice(0, 5)
        };
      })
    );
    
    res.json({
      success: true,
      calls: callsWithSuggestions,
      total: calls.length,
      hasMore: calls.length > parseInt(limit)
    });
  } catch (error) {
    console.error('[OD Sync Route] Pending links error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// INDIVIDUAL CALL SYNC
// ============================================================================

/**
 * Sync a specific call to Open Dental CommLog
 */
router.post('/calls/:callId/sync', async (req, res) => {
  try {
    const { callId } = req.params;
    const { includeTranscript = true, force = false } = req.body;
    
    const result = await openDentalSync.syncCallToCommLog(callId, {
      includeTranscript,
      force
    });
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        commLogNum: result.commLogNum,
        patientId: result.patientId
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
        requiresManualLink: result.requiresManualLink,
        matchResult: result.matchResult
      });
    }
  } catch (error) {
    console.error('[OD Sync Route] Call sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get sync status for a specific call
 */
router.get('/calls/:callId/status', async (req, res) => {
  try {
    const { callId } = req.params;
    const call = unifiedCallStore.getCall(callId);
    
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }
    
    res.json({
      success: true,
      callId,
      syncStatus: call.od_sync_status || 'not_synced',
      patientId: call.od_patient_id,
      patientName: call.od_patient_name,
      commLogNum: call.od_commlog_num,
      syncedAt: call.od_synced_at,
      linkedManually: call.od_linked_manually,
      matchConfidence: call.od_match_confidence,
      lastError: call.od_sync_error
    });
  } catch (error) {
    console.error('[OD Sync Route] Call status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// PATIENT LINKING
// ============================================================================

/**
 * Link a call to a patient manually
 */
router.post('/calls/:callId/link', async (req, res) => {
  try {
    const { callId } = req.params;
    const { patientId, syncNow = true, userId } = req.body;
    
    if (!patientId) {
      return res.status(400).json({
        success: false,
        error: 'patientId is required'
      });
    }
    
    const result = await openDentalSync.linkCallToPatient(callId, patientId, {
      syncNow,
      userId
    });
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        patient: result.patient,
        syncResult: result.syncResult
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('[OD Sync Route] Link error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Unlink a call from a patient
 */
router.delete('/calls/:callId/link', async (req, res) => {
  try {
    const { callId } = req.params;
    
    const result = await openDentalSync.unlinkCallFromPatient(callId);
    
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[OD Sync Route] Unlink error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Search for patients to link
 */
router.get('/patients/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters'
      });
    }
    
    const patients = await openDentalService.searchPatients(q);
    
    res.json({
      success: true,
      patients,
      count: patients.length
    });
  } catch (error) {
    console.error('[OD Sync Route] Patient search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// PATIENT CALL HISTORY
// ============================================================================

/**
 * Get all calls for a specific patient
 */
router.get('/patients/:patientId/calls', async (req, res) => {
  try {
    const { patientId } = req.params;
    const { limit = 50 } = req.query;
    
    const result = await openDentalSync.getPatientCallHistory(patientId, {
      limit: parseInt(limit)
    });
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('[OD Sync Route] Patient calls error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Find calls that might belong to a patient (suggestions for linking)
 */
router.get('/patients/:patientId/potential-calls', async (req, res) => {
  try {
    const { patientId } = req.params;
    
    const calls = await openDentalSync.findPotentialCallsForPatient(patientId);
    
    res.json({
      success: true,
      calls,
      count: calls.length
    });
  } catch (error) {
    console.error('[OD Sync Route] Potential calls error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Sync all pending calls
 */
router.post('/sync-all', async (req, res) => {
  try {
    const { includeTranscript = true, limit = 50 } = req.body;
    
    const results = await openDentalSync.syncAllPendingCalls({
      includeTranscript,
      limit
    });
    
    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[OD Sync Route] Sync all error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Match all unmatched calls to patients
 */
router.post('/match-all', async (req, res) => {
  try {
    const { limit = 100 } = req.body;
    const allCalls = unifiedCallStore.getCalls({ limit: 1000 });
    
    const results = {
      total: 0,
      matched: 0,
      noMatch: 0,
      errors: []
    };
    
    for (const call of allCalls.calls) {
      if (call.od_patient_id) continue; // Already linked
      if (results.total >= limit) break;
      
      results.total++;
      
      try {
        const matchResult = await openDentalSync.matchCallToPatient(call);
        
        if (matchResult.patient && matchResult.confidence >= 0.7) {
          unifiedCallStore.updateCall(call.id, {
            od_patient_id: matchResult.patient.id,
            od_patient_name: matchResult.patient.fullName,
            od_match_confidence: matchResult.confidence,
            od_match_method: matchResult.method,
            od_sync_status: 'matched'
          });
          results.matched++;
        } else {
          results.noMatch++;
        }
      } catch (e) {
        results.errors.push({ callId: call.id, error: e.message });
      }
    }
    
    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('[OD Sync Route] Match all error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

