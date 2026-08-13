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
const onDemandLedger = require('../services/onDemandTranscriptionLedger');
const mangoConfig = require('../config/mango');
const { getConnectedClientCount } = require('../socket/socketHandler');
const unifiedCallStore = require('../services/unifiedCallStore');
const retentionConfig = require('../config/retention');
const retentionScheduler = require('../services/retentionScheduler');
const odHealth = require('../services/odHealthCheck');
const legacyPurge = require('../services/legacyPurge');
const audit = require('../platform/audit');
const { requireSuperAdmin } = require('../config/permissions');

/**
 * Call-store retention (2026-08-13).
 *
 * These routes sit behind requireSuperAdmin() ON TOP OF the tenant 'admin.all'
 * gate the /api/admin mount already applies. Everything else under /api/admin
 * reconfigures or restarts something; two of these DESTROY RECORDS, which is a
 * platform-tier decision rather than an office-manager one. This is the first
 * place requireSuperAdmin() is actually mounted — it was built and tested in
 * Roles PR A ahead of a caller.
 */
const platformOnly = requireSuperAdmin();

/**
 * GET /api/admin/call-store/retention
 *
 * What the policy is and what it has done so far. Read-only, so it stays on the
 * ordinary admin gate — an office manager should be able to see why a call from
 * two months ago has no transcript without needing platform access.
 */
router.get('/call-store/retention', (req, res) => {
  const stats = unifiedCallStore.getStats();
  res.json({
    success: true,
    enabled: retentionConfig.isEnabled(),
    retentionDays: retentionConfig.retentionDays(),
    schedule: retentionConfig.schedule(),
    timezone: retentionConfig.timezone(),
    scheduler: retentionScheduler.getStatus(),
    store: {
      totalCalls: stats.totalCalls,
      liveCalls: stats.liveCalls,
      prunedCalls: stats.prunedCalls,
    },
  });
});

/**
 * POST /api/admin/call-store/prune
 *
 * Run the nightly prune now. Idempotent — triggering it after the scheduled run
 * simply finds nothing to do — but it is still the destructive job, so it is
 * platform-tier.
 */
router.post('/call-store/prune', platformOnly, async (req, res) => {
  try {
    const result = await retentionScheduler.runNow();
    await audit.audit(req, {
      action: 'DELETE',
      resourceType: 'call_store',
      resourceId: null,
      result: 'SUCCESS',
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[retention] manual prune failed:', error.message);
    res.status(500).json({ success: false, error: error.message, code: 'PRUNE_FAILED' });
  }
});

/**
 * POST /api/admin/call-store/purge-legacy
 *
 * The one-shot legacy purge. DRY RUN BY DEFAULT: an empty body reports the count
 * and deletes nothing. A live run needs BOTH `dryRun: false` and
 * `confirm: 'DELETE'`, and the service refuses to start without a backup on disk.
 *
 * The response carries counts, ids, and dates — never a caller name or number —
 * because the whole point of the dry run is that its output gets pasted into a
 * PR and read by someone before the live run happens.
 */
router.post('/call-store/purge-legacy', platformOnly, async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  try {
    const result = await legacyPurge.runLegacyPurge(unifiedCallStore, {
      dryRun,
      confirm: req.body?.confirm ?? null,
    });

    // A dry run READS the store; only the live run destroys. Recording them
    // under the same verb would make the audit trail unable to answer "when was
    // it actually run?" — which is the one question it exists for here.
    await audit.audit(req, {
      action: dryRun ? 'READ' : 'DELETE',
      resourceType: 'call_store',
      resourceId: null,
      result: 'SUCCESS',
    });

    res.json({ success: true, ...result });
  } catch (error) {
    if (error.code === 'PURGE_NOT_CONFIRMED') {
      return res.status(400).json({ success: false, error: error.message, code: error.code });
    }
    if (error.code === 'BACKUP_FAILED') {
      return res.status(500).json({ success: false, error: error.message, code: error.code });
    }
    console.error('[retention] legacy purge failed:', error.message);
    res.status(500).json({ success: false, error: error.message, code: 'PURGE_FAILED' });
  }
});

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

    // Read the health snapshot ONCE. Reading it per-field would be three
    // independent reads of a state another task is allowed to replace between
    // them, and a payload that said "running: true" next to a stale office row
    // would be exactly the torn read the checker is built to prevent.
    const odHealthStatus = odHealth.getStatus();

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
          // `last_sync` is gone with the 3-minute background loop that was the
          // only thing that ever set it. What replaces it is better than a
          // timestamp: whether each office can actually be REACHED, observed
          // continuously. `checker` covers the case the office rows cannot —
          // a checker that never started would otherwise leave every office
          // sitting at 'unknown' with nothing to explain why.
          checker: {
            running: odHealthStatus.running,
            enabled: odHealthStatus.enabled,
            interval_minutes: odHealthStatus.intervalMinutes,
          },
          offices: odHealthStatus.offices,
        },
        transcription: {
          status: transcriptionService.isAvailable() ? 'available' : 'unavailable',
          provider: transcriptionService.getStats().provider || 'azure-speech',
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
    // An office whose Open Dental cannot be reached is a degraded system, and
    // saying so here is the point of the whole slice: the previous way to learn
    // this was to notice error spam in the container log. 'unknown' is NOT
    // degraded — not having asked yet is not the same as having asked and failed.
    if (odHealthStatus.offices.some((o) => o.status === 'down')) {
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
          provider: transcriptionStats.provider || 'azure-speech',
          total_minutes: transcriptionStats.totalMinutes,
          total_transcriptions: transcriptionStats.totalTranscriptions,
          estimated_cost: transcriptionStats.totalCost,
          rate: '$1/audio hour (Azure AI Speech S0)',
        },
        analysis: {
          provider: 'openai',
          total_analyses: analyzerStats.totalAnalyses,
          total_tokens: analyzerStats.totalTokens,
          estimated_cost: analyzerStats.estimatedCost,
          rate: '$0.002/1K tokens',
        },
        total_estimated: transcriptionStats.totalCost + analyzerStats.estimatedCost,

        // (M4) Mango transcription, the way the office actually spends it: today's audio
        // minutes against the daily breaker, how many on-demand transcriptions each office
        // ran today, and the month's estimated Speech + summary spend at list rates.
        //
        // The `transcription` block above is PROCESS-LIFETIME and resets on every container
        // restart, so it cannot answer "what has this month cost" — the ledger can, because
        // it is durable and rolls on the offices' local day (same boundary as the breaker).
        mango_transcription: {
          auto_transcribe: mangoConfig.autoTranscribe,
          daily_budget: {
            day_key: transcriptionStats.dailyKey,
            timezone: transcriptionStats.budgetTimezone,
            used_minutes: transcriptionStats.dailyMinutes,
            budget_minutes: transcriptionStats.dailyBudgetMinutes,
            remaining_minutes: transcriptionStats.dailyBudgetMinutes > 0
              ? Number(Math.max(0, transcriptionStats.dailyBudgetMinutes - transcriptionStats.dailyMinutes).toFixed(2))
              : null,
            persisted: transcriptionStats.budgetPersisted,
            resets_at: transcriptionService.nextBudgetResetIso(),
          },
          on_demand_today: onDemandLedger.today(),
          on_demand_month: onDemandLedger.month(),
          rates: {
            speech: '$1/audio hour (Azure AI Speech S0)',
            summary: `$0.0006/1K tokens (${analyzerStats.isInitialized ? 'Azure OpenAI' : 'unconfigured'})`,
          },
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

      case 'deepgram': // legacy alias — kept so existing UI buttons don't break
      case 'azure-speech':
        const transcriptionAvailable = transcriptionService.isAvailable();
        result = {
          success: transcriptionAvailable,
          message: transcriptionAvailable
            ? 'Azure AI Speech is configured'
            : 'Azure AI Speech not configured (AZURE_SPEECH_ENDPOINT + MI or key)',
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
        provider: transcriptionService.getStats().provider || 'azure-speech',
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

