'use strict';

/**
 * /api/voicelab — the voice lab's ONLY backend surface: one token route.
 *
 *   POST /api/voicelab/token → { success: true, token, region }
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROUTE IS NOT ALLOWED TO BECOME
 * ═════════════════════════════════════════════════════════════════════════════
 * Audio goes browser → Azure directly. Recognised text stays in the browser's
 * memory. Nothing about WHAT was said ever reaches CareIN, so there is no
 * results route, no upload route, no "save this run" route. A request that
 * carries a body is refused outright (400) so the token route cannot quietly
 * grow into one. `voiceLab.test.js` pins the route table to exactly this one
 * entry.
 *
 * No Open Dental, no patient, no tenant data, no model call. The Speech key is
 * read from process.env (populated from Key Vault secret `azure-speech-key` by
 * config/secrets.js) and handed only to the token service; the browser gets
 * the 10-minute token and the region.
 *
 * Logs carry counts and milliseconds only.
 *
 * MOUNTED ONLY when config/voiceLab.js says so (flag on AND not production).
 * When it is not mounted, /api/voicelab/* falls through to the app's 404.
 */

const express = require('express');
const { resolveVoiceLab } = require('../config/voiceLab');
const { VoiceLabBudget } = require('../services/voiceLab/labBudget');
const { mintSpeechToken, SpeechTokenError } = require('../services/voiceLab/speechToken');

const MOUNT_PATH = '/api/voicelab';

/**
 * @param {unknown} body
 * @returns {boolean}
 */
function hasPayload(body) {
  if (body === undefined || body === null) return false;
  if (typeof body === 'string') return body.length > 0;
  if (Buffer.isBuffer(body)) return body.length > 0;
  if (typeof body === 'object') return Object.keys(body).length > 0;
  return true;
}

/**
 * @param {{ budget?: VoiceLabBudget, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [deps]
 */
function createVoiceLabRouter({ budget = new VoiceLabBudget(), fetchImpl, env = process.env } = {}) {
  const router = express.Router();

  router.post('/token', async (req, res) => {
    if (hasPayload(req.body)) {
      return res.status(400).json({
        success: false,
        code: 'VOICE_LAB_NO_PAYLOAD',
        error: 'The voice lab token route takes no request body. Nothing about what was said is sent to CareIN.',
      });
    }

    const key = env.AZURE_SPEECH_API_KEY;
    const region = env.AZURE_SPEECH_REGION;
    if (!key || !region) {
      console.warn('[voicelab] token refused: speech key or region not configured');
      return res.status(503).json({
        success: false,
        code: 'VOICE_LAB_SPEECH_UNCONFIGURED',
        error: 'Azure Speech is not configured on this server (key or region missing). No token was issued.',
      });
    }

    const reservation = budget.reserve();
    if (!reservation.ok) {
      console.warn(
        `[voicelab] token refused: lab budget spent (${reservation.usedMinutes}/${reservation.capMinutes} min)`
      );
      return res.status(429).json({
        success: false,
        code: 'VOICE_LAB_BUDGET_EXHAUSTED',
        error:
          `Today's voice lab budget is used up (${reservation.usedMinutes} of ${reservation.capMinutes} minutes ` +
          'reserved). It resets at midnight Central. Call transcription has its own budget and is not affected.',
        usedMinutes: reservation.usedMinutes,
        capMinutes: reservation.capMinutes,
        resetsAt: reservation.resetsAt,
      });
    }

    const started = Date.now();
    try {
      const token = await mintSpeechToken({ key, region, ...(fetchImpl ? { fetchImpl } : {}) });
      console.log(
        `[voicelab] token minted in ${Date.now() - started}ms ` +
          `(${reservation.usedMinutes}/${reservation.capMinutes} min reserved today)`
      );
      return res.json({ success: true, token, region });
    } catch (err) {
      budget.release();
      const code = err instanceof SpeechTokenError ? err.code : 'STS_ERROR';
      const status = err instanceof SpeechTokenError && err.status ? ` HTTP ${err.status}` : '';
      console.warn(`[voicelab] token mint failed after ${Date.now() - started}ms: ${code}${status}`);
      return res.status(502).json({
        success: false,
        code: 'VOICE_LAB_TOKEN_FAILED',
        error: 'Azure Speech did not issue a token. Nothing was reserved against today\'s lab budget.',
      });
    }
  });

  return router;
}

/**
 * Mount the lab on `app` IF the switch allows it. Returns what was decided so
 * the boot log (and the tests) can say why.
 *
 * Must be called AFTER the /api auth gate and tenant context are registered, so
 * the token route is never reachable unauthenticated.
 *
 * @param {import('express').Express} app
 * @param {{ env?: NodeJS.ProcessEnv, budget?: VoiceLabBudget, fetchImpl?: typeof fetch }} [opts]
 * @returns {{ enabled: boolean, reason: string }}
 */
function mountVoiceLab(app, { env = process.env, budget, fetchImpl } = {}) {
  const decision = resolveVoiceLab(env);
  if (decision.enabled) {
    app.use(MOUNT_PATH, createVoiceLabRouter({ budget, fetchImpl, env }));
    console.log('[voicelab] mounted at ' + MOUNT_PATH);
  } else if (decision.reason === 'production') {
    console.warn('[voicelab] VOICE_LAB is set but this is production — the lab is NOT mounted');
  }
  return decision;
}

module.exports = { createVoiceLabRouter, mountVoiceLab, MOUNT_PATH };
