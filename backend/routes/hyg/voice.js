'use strict';

/**
 * /api/hyg/voice — perio voice entry's ONLY backend surface: one token route
 * (queue item 35).
 *
 *   POST /api/hyg/voice/token?office=roland|valley → { success: true, token, region }
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE IT SITS, AND WHAT IT INHERITS
 * ═════════════════════════════════════════════════════════════════════════════
 * Inside the hyg router (routes/hyg/index.js), so it is below the /api auth gate
 * and tenant context, behind requireModule('hyg'), behind requireReadWrite —
 * which, by HTTP method, makes this POST demand hyg.write — and behind the
 * router-wide requireOffice. The office is required only because every hyg
 * route requires it (index.js note 1); the token itself is not per-office and
 * the office is never sent to Azure.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROUTE IS NOT ALLOWED TO BECOME
 * ═════════════════════════════════════════════════════════════════════════════
 * Audio goes browser → Azure directly. Recognised text stays in the browser and
 * becomes readings in the perio chart the hygienist is already editing; those
 * readings reach CareIN through the chart's EXISTING save, and Open Dental only
 * through the EXISTING stage → confirm → send. So there is no transcript route,
 * no upload route, and no "apply what I said" route. A request that carries a
 * body is refused outright (400) so the token route cannot quietly grow into
 * one. routes/hyg/hygVoice.test.js pins the route table to this one entry.
 *
 * No Open Dental, no patient, no visit store. The Speech key is read from
 * process.env (Key Vault secret `azure-speech-key`, via config/secrets.js) and
 * handed only to the token service — the SAME mint the voice lab built for this
 * purpose (services/voiceLab/speechToken.js). The lab's budget and its route
 * are not required here; only that one function is.
 *
 * Logs carry codes, minutes and milliseconds only.
 *
 * ON ONLY WHEN `HYG_VOICE === '1'` (config/hygVoice.js). The check runs per
 * request with the same predicate /auth/me reports, so the route and the UI
 * can never disagree; when it is off the request falls through to the 404 as
 * if the route did not exist.
 */

const express = require('express');
const { isHygVoiceEnabled } = require('../../config/hygVoice');
const { HygVoiceBudget } = require('../../services/hyg/voiceBudget');
const { mintSpeechToken, SpeechTokenError } = require('../../services/voiceLab/speechToken');

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
 * @param {{ budget?: HygVoiceBudget, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [deps]
 */
function createHygVoiceRouter({ budget = new HygVoiceBudget(), fetchImpl, env = process.env } = {}) {
  const router = express.Router();

  router.post('/token', async (req, res) => {
    if (hasPayload(req.body)) {
      return res.status(400).json({
        success: false,
        code: 'HYG_VOICE_NO_PAYLOAD',
        error: 'The voice token route takes no request body. Nothing that was said is sent to CareIN.',
      });
    }

    const key = env.AZURE_SPEECH_API_KEY;
    const region = env.AZURE_SPEECH_REGION;
    if (!key || !region) {
      console.warn('[hyg-voice] token refused: HYG_VOICE_SPEECH_UNCONFIGURED');
      return res.status(503).json({
        success: false,
        code: 'HYG_VOICE_SPEECH_UNCONFIGURED',
        error: 'Azure Speech is not configured on this server, so voice entry cannot start. Keep charting by keyboard.',
      });
    }

    const reservation = budget.reserve();
    if (!reservation.ok) {
      console.warn(
        `[hyg-voice] token refused: HYG_VOICE_BUDGET_EXHAUSTED (${reservation.usedMinutes}/${reservation.capMinutes} min)`
      );
      return res.status(429).json({
        success: false,
        code: 'HYG_VOICE_BUDGET_EXHAUSTED',
        error:
          `Today's perio voice budget is used up (${reservation.usedMinutes} of ${reservation.capMinutes} minutes ` +
          'reserved). It resets at midnight Central. Keep charting by keyboard; nothing already charted is affected.',
        usedMinutes: reservation.usedMinutes,
        capMinutes: reservation.capMinutes,
        resetsAt: reservation.resetsAt,
      });
    }

    const started = Date.now();
    try {
      const token = await mintSpeechToken({ key, region, ...(fetchImpl ? { fetchImpl } : {}) });
      console.log(
        `[hyg-voice] token minted in ${Date.now() - started}ms ` +
          `(${reservation.usedMinutes}/${reservation.capMinutes} min reserved today)`
      );
      return res.json({ success: true, token, region });
    } catch (err) {
      budget.release();
      const code = err instanceof SpeechTokenError ? err.code : 'STS_ERROR';
      const status = err instanceof SpeechTokenError && err.status ? ` HTTP ${err.status}` : '';
      console.warn(`[hyg-voice] token mint failed after ${Date.now() - started}ms: ${code}${status}`);
      return res.status(502).json({
        success: false,
        code: 'HYG_VOICE_TOKEN_FAILED',
        error: "Azure Speech did not issue a token. Nothing was reserved against today's voice budget.",
      });
    }
  });

  return router;
}

/** The process's one budget, made on first use — exported so a test can reach the one the app spends. */
let processBudget = null;

/** @returns {HygVoiceBudget} */
function processHygVoiceBudget() {
  if (!processBudget) processBudget = new HygVoiceBudget();
  return processBudget;
}

/**
 * The switch in front of the router: on per request when HYG_VOICE === '1',
 * otherwise a plain fall-through to whatever answers next (the 404).
 *
 * @param {{ env?: NodeJS.ProcessEnv, budget?: HygVoiceBudget, fetchImpl?: typeof fetch }} [opts]
 * @returns {import('express').RequestHandler}
 */
function hygVoiceGate({ env = process.env, budget = processHygVoiceBudget(), fetchImpl } = {}) {
  const voiceRouter = createHygVoiceRouter({ env, budget, fetchImpl });
  return (req, res, next) => {
    if (!isHygVoiceEnabled(env)) return next();
    return voiceRouter(req, res, next);
  };
}

module.exports = { createHygVoiceRouter, hygVoiceGate, processHygVoiceBudget };
