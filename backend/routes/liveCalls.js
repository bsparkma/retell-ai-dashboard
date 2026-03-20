/**
 * Live Calls Router
 * 
 * Provides REST endpoints for accessing live call data.
 * Primary real-time updates come via Socket.IO.
 */

const express = require('express');
const router = express.Router();
const liveCallManager = require('../services/liveCallManager');

/**
 * GET /api/live-calls
 * 
 * Get all currently active calls.
 */
router.get('/', (req, res) => {
  try {
    const calls = liveCallManager.getAllCalls();
    
    res.json({
      success: true,
      count: calls.length,
      calls: calls,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching live calls:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live calls'
    });
  }
});

/**
 * GET /api/live-calls/count
 * 
 * Get count of active calls (lightweight endpoint).
 */
router.get('/count', (req, res) => {
  try {
    const count = liveCallManager.getActiveCount();
    const emergencyCount = liveCallManager.getEmergencyCalls().length;
    
    res.json({
      success: true,
      count: count,
      emergency_count: emergencyCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching call count:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch call count'
    });
  }
});

/**
 * GET /api/live-calls/emergency
 * 
 * Get only emergency calls.
 */
router.get('/emergency', (req, res) => {
  try {
    const emergencyCalls = liveCallManager.getEmergencyCalls();
    
    res.json({
      success: true,
      count: emergencyCalls.length,
      calls: emergencyCalls,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching emergency calls:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch emergency calls'
    });
  }
});

/**
 * GET /api/live-calls/:id
 * 
 * Get a specific active call by ID.
 */
router.get('/:id', (req, res) => {
  try {
    const call = liveCallManager.getCall(req.params.id);
    
    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found or no longer active'
      });
    }
    
    res.json({
      success: true,
      call: call,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch call'
    });
  }
});

/**
 * GET /api/live-calls/:id/transcript
 * 
 * Get just the transcript for a specific call.
 */
router.get('/:id/transcript', (req, res) => {
  try {
    const call = liveCallManager.getCall(req.params.id);
    
    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found or no longer active'
      });
    }
    
    res.json({
      success: true,
      call_id: call.call_id,
      transcript: call.transcript,
      transcript_text: call.transcript_text,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching transcript:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transcript'
    });
  }
});

module.exports = router;

