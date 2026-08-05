/**
 * Mango utility routes
 *
 * Audio playback proxy for a stored Mango call (recordings are never persisted, so the
 * signed recording_url is re-fetched on demand), plus the staging-only dev seeder.
 * The UI exposes a stable per-call URL: https://app.mangovoice.com/calls/<id>
 */

const express = require('express');
const router = express.Router();

const { Readable } = require('stream');
// NB: mangoScraper (Puppeteer) is deliberately NOT required here — the only route that
// used it was the deleted POST /fetch/:mangoCallId, and Chromium is not in the lean
// API container. Keep this file browser-free.
const mangoApiClient = require('../services/mangoApiClient');
const unifiedCallStore = require('../services/unifiedCallStore');
const openDentalSyncService = require('../services/openDentalSync');
const audit = require('../platform/audit');

/**
 * GET /api/mango/calls/:callId/recording  (SSO-gated via the /api auth gate)
 *
 * Audio playback (day-1 item 6). We do NOT store recordings (D3 transcribe-and-discard),
 * so on demand we re-fetch the call's CURRENT signed recording_url from the Mango API
 * (the one captured at ingest has expired) and PROXY the stream to the browser — the mp3
 * is never written to disk here and the signed URL never reaches the client. Range
 * headers are forwarded so the player can seek. Missing recording → graceful 404.
 */
router.get('/calls/:callId/recording', async (req, res) => {
  try {
    const { callId } = req.params;
    const call = unifiedCallStore.getCall(callId);
    if (!call || call.source !== 'mango') {
      return res.status(404).json({ error: 'Recording unavailable' });
    }
    const mangoId = call.mango_call_id
      || (typeof call.external_id === 'string' ? call.external_id.replace(/^mango_call_/, '') : null);
    if (!mangoId) return res.status(404).json({ error: 'Recording unavailable' });

    // Re-fetch the fresh signed URL from Mango (stored one expires quickly).
    let detail;
    try {
      detail = await mangoApiClient.getCall(mangoId);
    } catch (e) {
      console.error(`[Mango] recording re-fetch failed for ${callId}: ${e.message}`);
      return res.status(502).json({ error: 'Recording unavailable' });
    }
    const url = detail && detail.recording_url;
    if (!url || typeof url !== 'string') {
      return res.status(404).json({ error: 'Recording unavailable' });
    }

    // Proxy the stream, forwarding Range for seek support.
    const range = req.headers.range;
    const upstream = await fetch(url, { headers: range ? { Range: range } : {} });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(404).json({ error: 'Recording unavailable' });
    }

    // PHI audio → an authenticated READ.
    await audit.audit(req, { action: 'READ', resourceType: 'recording', resourceId: callId, result: 'SUCCESS' });

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.headers.get('content-type')) res.setHeader('content-type', 'audio/mpeg');
    // Never let PHI audio be cached by intermediaries/browser disk.
    res.setHeader('Cache-Control', 'private, no-store');

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (error) {
    console.error('[Mango] recording stream failed:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Recording unavailable' });
  }
});

// (M3) `POST /fetch/:mangoCallId` was DELETED, not repaired. It swallowed transcription
// failures in an empty catch and returned `success: true, transcript: null` — a live
// violation of the platform rule "never claim success before the result is persisted"
// (diagnosis §4). It was also already non-functional in prod: it routed through
// mangoScraper.downloadRecording, i.e. Puppeteer/Chromium, which was dropped from the lean
// API container in a1f1fc4. M4 builds the correct on-demand transcribe endpoint from
// scratch on transcribeUrl/getCall, surfacing TRANSCRIPTION_BUDGET_EXCEEDED to the user
// instead of hiding it. Removing this now keeps M4 from inheriting it.

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
        od_patient_id: after.od_patient_id ?? null,
        od_patient_name: after.od_patient_name ?? null,
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



