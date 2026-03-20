/**
 * Webhooks Router
 * 
 * Handles incoming webhook events from Retell AI.
 * Processes call events and updates live call state.
 */

const express = require('express');
const router = express.Router();
const liveCallManager = require('../services/liveCallManager');
const unifiedCallStore = require('../services/unifiedCallStore');

/**
 * POST /api/webhooks/retell
 * 
 * Main webhook endpoint for Retell AI events.
 * 
 * Retell sends these event types:
 * - call_started: When a call begins
 * - call_ended: When a call terminates
 * - call_analyzed: When post-call analysis is complete
 * 
 * For real-time transcription (if enabled):
 * - transcript: Real-time transcript updates
 */
router.post('/retell', async (req, res) => {
  try {
    const event = req.body;
    
    // Log the incoming event (useful for debugging)
    console.log('📨 Retell webhook received:', {
      event: event.event,
      call_id: event.call?.call_id || event.data?.call_id,
      timestamp: new Date().toISOString()
    });

    // Handle different event types
    switch (event.event) {
      case 'call_started':
        await handleCallStarted(event);
        break;

      case 'call_ended':
        await handleCallEnded(event);
        break;

      case 'call_analyzed':
        await handleCallAnalyzed(event);
        break;

      case 'transcript':
      case 'transcript_update':
        await handleTranscriptUpdate(event);
        break;

      default:
        console.log(`⚠️ Unknown webhook event type: ${event.event}`);
    }

    // Always respond with 200 to acknowledge receipt
    res.status(200).json({ 
      received: true, 
      event: event.event,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error processing Retell webhook:', error);
    
    // Still return 200 to prevent Retell from retrying
    // Log the error for investigation
    res.status(200).json({ 
      received: true, 
      error: 'Processing error logged',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Handle call_started event
 */
async function handleCallStarted(event) {
  const callData = event.call || event.data || event;
  
  const call = liveCallManager.addCall({
    call_id: callData.call_id,
    agent_id: callData.agent_id,
    agent_name: callData.agent_name,
    from_number: callData.from_number,
    to_number: callData.to_number,
    start_timestamp: callData.start_timestamp || new Date().toISOString(),
    metadata: callData.metadata || {}
  });

  console.log(`📞 [Webhook] Call started: ${call.call_id}`);

  // Store partial call immediately so it shows up in the unified dashboard
  try {
    unifiedCallStore.addRetellCall(call);
    await unifiedCallStore.persist();
  } catch (e) {
    console.warn('⚠️ Failed to persist call_started to unified store:', e.message);
  }
}

/**
 * Handle call_ended event
 */
async function handleCallEnded(event) {
  const callData = event.call || event.data || event;
  
  const finalCall = liveCallManager.endCall(callData.call_id, {
    end_timestamp: callData.end_timestamp || new Date().toISOString(),
    call_status: callData.call_status,
    disconnection_reason: callData.disconnection_reason,
    recording_url: callData.recording_url,
    call_analysis: callData.call_analysis
  });

  if (finalCall) {
    console.log(`📞 [Webhook] Call ended: ${finalCall.call_id} (${finalCall.duration}s)`);
    
    // Here you could trigger:
    // - Storing to database
    // - Syncing to Open Dental
    // - Triggering QA evaluation
    // - Creating callbacks if needed

    // Persist finalized call into unified store so it appears on dashboard
    try {
      unifiedCallStore.addRetellCall(finalCall);
      await unifiedCallStore.persist();
    } catch (e) {
      console.warn('⚠️ Failed to persist call_ended to unified store:', e.message);
    }
  }
}

/**
 * Handle call_analyzed event
 * This comes after call ends with full analysis
 */
async function handleCallAnalyzed(event) {
  const callData = event.call || event.data || event;
  
  console.log(`📊 [Webhook] Call analyzed: ${callData.call_id}`);
  
  // The call has already ended, so this is for updating stored data
  // For now, we'll just log it. In a full implementation:
  // - Update database with analysis
  // - Trigger QA evaluation
  // - Update Open Dental if needed
  
  // Emit the analysis to any listening clients
  if (liveCallManager.io) {
    liveCallManager.io.emit('call:analyzed', {
      call_id: callData.call_id,
      analysis: callData.call_analysis,
      transcript: callData.transcript,
      transcript_object: callData.transcript_object,
      recording_url: callData.recording_url
    });
  }

  // Persist analysis updates into unified store
  try {
    unifiedCallStore.addRetellCall({
      ...callData,
      call_id: callData.call_id,
      transcript: callData.transcript,
      transcript_object: callData.transcript_object,
      recording_url: callData.recording_url,
      call_analysis: callData.call_analysis,
      call_summary: callData.call_analysis?.call_summary || callData.call_summary,
    });
    await unifiedCallStore.persist();
  } catch (e) {
    console.warn('⚠️ Failed to persist call_analyzed to unified store:', e.message);
  }
}

/**
 * Handle real-time transcript updates
 */
async function handleTranscriptUpdate(event) {
  const callId = event.call_id || event.data?.call_id;
  const transcript = event.transcript || event.data?.transcript;
  
  if (!callId || !transcript) {
    console.warn('⚠️ Transcript update missing call_id or transcript');
    return;
  }

  // If transcript is an array of utterances
  if (Array.isArray(transcript)) {
    transcript.forEach(utterance => {
      liveCallManager.addTranscriptUtterance(callId, utterance);
    });
  } 
  // If transcript is a single utterance
  else if (typeof transcript === 'object') {
    liveCallManager.addTranscriptUtterance(callId, transcript);
  }
  // If transcript is just text
  else if (typeof transcript === 'string') {
    liveCallManager.addTranscriptUtterance(callId, {
      role: event.role || 'unknown',
      content: transcript,
      timestamp: event.timestamp || new Date().toISOString()
    });
  }

  // Persist incremental transcript changes into unified store (best-effort)
  try {
    const current = liveCallManager.getCall(callId);
    if (current) {
      unifiedCallStore.addRetellCall(current);
      await unifiedCallStore.persist();
    }
  } catch (e) {
    // Don't spam logs for high-frequency transcript events
  }
}

/**
 * GET /api/webhooks/retell
 * 
 * Health check endpoint for webhook.
 * Retell may ping this to verify the endpoint is active.
 */
router.get('/retell', (req, res) => {
  res.status(200).json({
    status: 'active',
    service: 'CareIn Dashboard Webhook',
    timestamp: new Date().toISOString(),
    active_calls: liveCallManager.getActiveCount()
  });
});

/**
 * POST /api/webhooks/test
 * 
 * Test endpoint for simulating webhook events.
 * Only for development/testing purposes.
 */
router.post('/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Test endpoint disabled in production' });
  }

  const { event_type, call_data } = req.body;

  console.log('🧪 Test webhook received:', event_type);

  switch (event_type) {
    case 'call_started':
      liveCallManager.addCall({
        call_id: call_data?.call_id || `test-${Date.now()}`,
        agent_id: call_data?.agent_id || 'test-agent',
        agent_name: call_data?.agent_name || 'Test Agent',
        from_number: call_data?.from_number || '+1-555-TEST',
        ...call_data
      });
      break;

    case 'transcript':
      liveCallManager.addTranscriptUtterance(
        call_data?.call_id || 'test-call',
        {
          role: call_data?.role || 'user',
          content: call_data?.content || 'Test transcript message',
          timestamp: new Date().toISOString()
        }
      );
      break;

    case 'call_ended':
      liveCallManager.endCall(call_data?.call_id || 'test-call', {
        end_timestamp: new Date().toISOString(),
        ...call_data
      });
      break;

    default:
      return res.status(400).json({ error: 'Unknown event_type' });
  }

  res.status(200).json({ 
    success: true, 
    event: event_type,
    active_calls: liveCallManager.getActiveCount()
  });
});

module.exports = router;

