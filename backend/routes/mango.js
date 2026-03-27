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
    await unifiedCallStore.persist();

    return res.json({ success: true, call: unifiedCallStore.getCall(externalId) });
  } catch (error) {
    console.error('Mango fetch failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;



