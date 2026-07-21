/**
 * Mango utility routes
 *
 * Provides on-demand recording + transcription fetch for a Mango call ID.
 * This is useful because not every call has a recording, and the UI exposes
 * a stable per-call URL: https://app.mangovoice.com/calls/<id>
 */

const express = require('express');
const path = require('path');
const router = express.Router();

const mangoScraper = require('../services/mangoScraper');
const transcriptionService = require('../services/transcriptionService');
const unifiedCallStore = require('../services/unifiedCallStore');
const openDentalSyncService = require('../services/openDentalSync');

router.post('/fetch/:mangoCallId', async (req, res) => {
  try {
    const { mangoCallId } = req.params;
    if (!mangoCallId || !/^\d+$/.test(String(mangoCallId))) {
      return res.status(400).json({ success: false, error: 'Invalid mangoCallId' });
    }

    const externalId = `mango_call_${mangoCallId}`;
    const detailUrl = `https://app.mangovoice.com/calls/${encodeURIComponent(mangoCallId)}`;

    // Download MP3 (returns absolute path or null)
    // Note: detailUrl is a /calls/<id> page, so mangoScraper.downloadRecording delegates to
    // the network-capture flow for best reliability.
    const recordingPath = await mangoScraper.downloadRecording(detailUrl, externalId);
    if (!recordingPath) {
      return res.json({
        success: false,
        message: 'No recording downloaded (call may show "No Recording Available" or download not accessible).',
        mango_call_id: mangoCallId,
      });
    }

    const filename = path.basename(recordingPath);
    const recordingUrl = `/api/mango/recordings/${encodeURIComponent(filename)}`;

    // Transcribe
    let transcriptText = null;
    let transcriptJson = null;
    try {
      const t = await transcriptionService.transcribeFile(recordingPath);
      if (t) {
        transcriptText = t.text || null;
        transcriptJson = t.words || null;
      }
    } catch (e) {
      // keep going; we still return recording
    }

    // Upsert onto the unified call (match by mango_call_id/external_id)
    const existing = unifiedCallStore.getCalls({ source: 'mango', limit: 5000, offset: 0 }).calls
      .find(c => c.mango_call_id === String(mangoCallId) || c.external_id === externalId);

    if (existing?.id) {
      unifiedCallStore.updateCall(existing.id, {
        recording_path: recordingPath,
        recording_url: recordingUrl,
        transcript: transcriptText,
        transcript_json: transcriptJson,
      });
      // Enter the source-agnostic path so it appears in the Slice B worklist. Skips synced.
      await matchIfNeeded(existing.id);
      await unifiedCallStore.persist();
      return res.json({ success: true, call: unifiedCallStore.getCall(existing.id) });
    }

    // If we don't have a call yet, create a minimal Mango call entry
    unifiedCallStore.addMangoCalls([{
      id: externalId,
      external_id: externalId,
      mango_call_id: String(mangoCallId),
      mango_detail_url: detailUrl,
      call_date: new Date().toISOString(),
      duration_seconds: 0,
      caller_number: null,
      outcome: 'unknown',
      recording_path: recordingPath,
      recording_url: recordingUrl,
      transcript: transcriptText,
      transcript_json: transcriptJson,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);
    await matchIfNeeded(externalId);
    await unifiedCallStore.persist();

    return res.json({ success: true, call: unifiedCallStore.getCall(externalId) });
  } catch (error) {
    console.error('Mango fetch failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/mango/dev/seed  — synthetic Mango-call seeder for STAGING.
 *
 * Gated by an EXPLICIT opt-in flag (ALLOW_MANGO_DEV_SEED=true), NOT by NODE_ENV: staging
 * runs NODE_ENV=production so it loads Key Vault, so a NODE_ENV guard would wrongly block
 * staging. Prod never sets the flag → always 403. Injects synthetic Mango calls through
 * the REAL path (addMangoCalls upsert → matchAndSetStatus) so staging's ephemeral store
 * can be re-seeded after a cold start. No OD write happens (review-then-send status only).
 * Body: { calls: [ <raw mango call>, ... ] }.
 */
router.post('/dev/seed', async (req, res) => {
  if (process.env.ALLOW_MANGO_DEV_SEED !== 'true') {
    return res.status(403).json({
      success: false,
      error: 'Seed endpoint disabled (set ALLOW_MANGO_DEV_SEED=true on staging; never on prod)',
    });
  }
  const calls = Array.isArray(req.body && req.body.calls) ? req.body.calls : [];
  if (calls.length === 0) {
    return res.status(400).json({ success: false, error: 'Provide a non-empty { calls: [...] } array' });
  }

  try {
    // Upsert (dedup by external_id), then run each through the source-agnostic matcher.
    unifiedCallStore.addMangoCalls(calls);

    const out = [];
    const stored = unifiedCallStore.getCalls({ source: 'mango', limit: 5000, offset: 0 }).calls;
    for (const c of calls) {
      const rec = stored.find((x) => x.external_id === c.external_id);
      if (!rec) continue;
      await matchIfNeeded(rec.id);
      const after = unifiedCallStore.getCall(rec.id);
      out.push({
        id: after.id,
        external_id: after.external_id,
        od_sync_status: after.od_sync_status,
        candidates: (after.od_match_candidates || []).length,
        has_transcript: Boolean(after.transcript),
      });
    }
    await unifiedCallStore.persist();
    return res.json({ success: true, seeded: out.length, calls: out });
  } catch (error) {
    console.error('Mango dev seed failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Run the source-agnostic match → status transition for a Mango call so it enters the
 * Slice B worklist (openDentalSync.matchAndSetStatus). Skips 'synced' calls (a human
 * Send-to-chart is terminal). Best-effort — never throws out of the request handler.
 */
async function matchIfNeeded(callId) {
  try {
    const call = unifiedCallStore.getCall(callId);
    if (!call || call.od_sync_status === 'synced') return;
    await openDentalSyncService.matchAndSetStatus(callId, {
      caller_number: call.caller_number,
      caller_name: call.caller_name,
    });
  } catch (e) {
    console.error(`[Mango fetch] matchAndSetStatus failed for ${callId}: ${e.message}`);
  }
}

module.exports = router;



