/**
 * Admin Routes
 * 
 * Provides endpoints for system administration, sync control,
 * and monitoring the health of all services.
 */

const express = require('express');
const router = express.Router();
const syncScheduler = require('../services/syncScheduler');
const mangoScraper = require('../services/mangoScraper');
const transcriptionService = require('../services/transcriptionService');
const callAnalyzer = require('../services/callAnalyzer');
const liveCallManager = require('../services/liveCallManager');
const openDentalService = require('../config/openDental');
const { getConnectedClientCount } = require('../socket/socketHandler');

/**
 * GET /api/admin/health
 * 
 * Get overall system health status
 */
router.get('/health', async (req, res) => {
  try {
    let connectedClients = 0;
    try {
      connectedClients = await getConnectedClientCount();
    } catch (e) {}

    // Get Open Dental status
    const odEnabled = openDentalService.isEnabled();
    let odStatus = 'not_configured';
    if (odEnabled) {
      odStatus = openDentalService.useDatabase ? 'database' : 'api';
    }

    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      mangoSync: syncScheduler.getSyncState ? syncScheduler.getSyncState() : null,
      services: {
        socketIO: {
          status: 'active',
          connected_clients: connectedClients,
          active_calls: liveCallManager.getActiveCount(),
        },
        retell: {
          status: 'connected',
          webhook_configured: true, // Assume true if we've received events
        },
        mango: {
          status: mangoScraper.isLoggedIn ? 'connected' : 'disconnected',
          last_sync: syncScheduler.lastSync?.toISOString() || null,
          next_sync: syncScheduler.nextSync,
          scheduler_running: !!syncScheduler.cronJob,
        },
        openDental: {
          status: odEnabled ? 'configured' : 'not_configured',
          connection_type: odStatus,
          last_sync: openDentalService.lastSyncTime || null,
        },
        transcription: {
          status: transcriptionService.isAvailable() ? 'available' : 'unavailable',
          provider: 'deepgram',
          stats: transcriptionService.getStats(),
        },
        callAnalyzer: {
          status: callAnalyzer.isAvailable() ? 'available' : 'unavailable',
          provider: 'openai',
          stats: callAnalyzer.getStats(),
        },
      },
    };

    // Check for any issues
    if (!transcriptionService.isAvailable()) {
      health.status = 'degraded';
    }
    if (!callAnalyzer.isAvailable()) {
      health.status = 'degraded';
    }

    res.json(health);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/sync-status
 * 
 * Get Mango sync status and history
 */
router.get('/sync-status', (req, res) => {
  try {
    const status = syncScheduler.getStatus();
    const scraperStatus = mangoScraper.getStatus();
    
    res.json({
      success: true,
      sync: status,
      scraper: scraperStatus,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/admin/sync/start
 * 
 * Start the sync scheduler
 */
router.post('/sync/start', (req, res) => {
  try {
    syncScheduler.start();
    res.json({
      success: true,
      message: 'Sync scheduler started',
      status: syncScheduler.getStatus(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/admin/sync/stop
 * 
 * Stop the sync scheduler
 */
router.post('/sync/stop', (req, res) => {
  try {
    syncScheduler.stop();
    res.json({
      success: true,
      message: 'Sync scheduler stopped',
      status: syncScheduler.getStatus(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/admin/sync/run
 * 
 * Trigger a manual sync
 */
router.post('/sync/run', async (req, res) => {
  try {
    const { maxCalls } = req.body;
    
    // Start sync in background
    res.json({
      success: true,
      message: 'Sync started',
      sync_id: `sync_${Date.now()}`,
    });

    // Run sync (don't await to return immediately)
    syncScheduler.runSync({ maxCalls }).catch(err => {
      console.error('Manual sync failed:', err);
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/sync/history
 * 
 * Get sync history
 */
router.get('/sync/history', (req, res) => {
  try {
    const history = syncScheduler.getHistory();
    res.json({
      success: true,
      history,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/costs
 * 
 * Get cost tracking data
 */
router.get('/costs', (req, res) => {
  try {
    const transcriptionStats = transcriptionService.getStats();
    const analyzerStats = callAnalyzer.getStats();
    
    res.json({
      success: true,
      costs: {
        transcription: {
          provider: 'deepgram',
          total_minutes: transcriptionStats.totalMinutes,
          total_transcriptions: transcriptionStats.totalTranscriptions,
          estimated_cost: transcriptionStats.totalCost,
          rate: '$0.0043/min',
        },
        analysis: {
          provider: 'openai',
          total_analyses: analyzerStats.totalAnalyses,
          total_tokens: analyzerStats.totalTokens,
          estimated_cost: analyzerStats.estimatedCost,
          rate: '$0.002/1K tokens',
        },
        total_estimated: transcriptionStats.totalCost + analyzerStats.estimatedCost,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/queues
 * 
 * Get processing queue status
 */
router.get('/queues', (req, res) => {
  try {
    // For now, we don't have persistent queues, but this is the structure
    res.json({
      success: true,
      queues: {
        transcription: {
          pending: 0,
          processing: 0,
          completed_today: transcriptionService.getStats().totalTranscriptions,
        },
        analysis: {
          pending: 0,
          processing: 0,
          completed_today: callAnalyzer.getStats().totalAnalyses,
        },
        open_dental_sync: {
          pending: 0,
          processing: 0,
          completed_today: 0,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/admin/test-connection
 * 
 * Test connection to a specific service
 */
router.post('/test-connection', async (req, res) => {
  const { service } = req.body;
  
  try {
    let result = { success: false, message: 'Unknown service' };

    switch (service) {
      case 'mango':
        await mangoScraper.initialize();
        await mangoScraper.login();
        result = {
          success: true,
          message: 'Successfully connected to Mango portal',
        };
        break;

      case 'opendental':
        const odResult = await openDentalService.testConnection();
        result = {
          success: odResult.success,
          message: odResult.message,
          connectionType: odResult.connectionType,
          patientCount: odResult.patientCount,
        };
        break;

      case 'deepgram':
        const transcriptionAvailable = transcriptionService.isAvailable();
        result = {
          success: transcriptionAvailable,
          message: transcriptionAvailable 
            ? 'Deepgram API key is configured' 
            : 'Deepgram API key not set',
        };
        break;

      case 'openai':
        const analyzerAvailable = callAnalyzer.isAvailable();
        result = {
          success: analyzerAvailable,
          message: analyzerAvailable 
            ? 'OpenAI API key is configured' 
            : 'OpenAI API key not set',
        };
        break;

      case 'retell':
        const retellKey = process.env.RETELL_API_KEY;
        result = {
          success: !!retellKey,
          message: retellKey
            ? 'Retell API key is configured'
            : 'RETELL_API_KEY is not set in environment',
        };
        break;

      default:
        result = { success: false, message: `Unknown service: ${service}` };
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * POST /api/admin/mango/download
 *
 * Debug helper: attempt to download a Mango MP3 for a specific call ID (app.mangovoice.com/calls/<id>).
 * Body: { callId: "4637427643" } OR { callUrl: "https://app.mangovoice.com/calls/4637427643" }
 */
router.post('/mango/download', async (req, res) => {
  try {
    const { callId, callUrl } = req.body || {};
    const url = callUrl || (callId ? `https://app.mangovoice.com/calls/${encodeURIComponent(String(callId))}` : null);
    if (!url) {
      return res.status(400).json({ success: false, message: 'Provide callId or callUrl' });
    }

    const result = await mangoScraper.downloadRecordingFromCallDetail(url, `manual_${callId || 'call'}`);
    if (!result) {
      return res.json({ success: false, message: 'Failed to download MP3 (see data/mango_debug artifacts)', url });
    }

    return res.json({ success: true, url, ...result });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/admin/config
 * 
 * Get current configuration (sanitized, no secrets)
 */
router.get('/config', (req, res) => {
  const mangoConfig = require('../config/mango');
  
  res.json({
    success: true,
    config: {
      mango: {
        portal_url: mangoConfig.portal.baseUrl,
        sync_schedule: mangoConfig.sync.schedule,
        max_calls_per_sync: mangoConfig.sync.maxCallsPerSync,
        download_recordings: mangoConfig.sync.downloadRecordings,
        credentials_configured: !!(mangoConfig.auth.username && mangoConfig.auth.password),
      },
      openDental: {
        enabled: openDentalService.isEnabled(),
        connection_type: openDentalService.useDatabase ? 'database' : 
                         openDentalService.apiUrl ? 'api' : 'none',
        api_url_configured: !!(process.env.OD_API_URL || process.env.OPENDENTAL_API_BASE_URL),
        api_key_configured: !!process.env.OD_API_KEY,
        developer_key_configured: !!process.env.OPENDENTAL_DEVELOPER_KEY,
        customer_key_configured: !!process.env.OPENDENTAL_CUSTOMER_KEY,
        db_url_configured: !!process.env.OPENDENTAL_DB_URL,
        api_url: process.env.OD_API_URL || process.env.OPENDENTAL_API_BASE_URL || 'not set',
      },
      transcription: {
        provider: 'deepgram',
        configured: transcriptionService.isAvailable(),
      },
      analysis: {
        provider: 'openai',
        model: 'gpt-3.5-turbo',
        configured: callAnalyzer.isAvailable(),
      },
    },
  });
});

/**
 * GET /api/admin/errors
 * 
 * Get recent errors
 */
router.get('/errors', (req, res) => {
  try {
    // Get errors from recent sync history
    const history = syncScheduler.getHistory();
    const errors = [];
    
    history.forEach(sync => {
      if (sync.errors && sync.errors.length > 0) {
        sync.errors.forEach(error => {
          errors.push({
            sync_id: sync.id,
            timestamp: sync.started_at,
            error,
          });
        });
      }
    });

    res.json({
      success: true,
      errors: errors.slice(0, 50), // Last 50 errors
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;

