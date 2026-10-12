'use strict';

/**
 * Perio voice entry's on/off switch (queue item 35).
 *
 * `HYG_VOICE` must be EXACTLY the string '1'. Anything else ('true', 'on', ' 1',
 * a typo, unset) is OFF.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO PRODUCTION REFUSAL HERE, UNLIKE THE LAB
 * ═════════════════════════════════════════════════════════════════════════════
 * config/voiceLab.js refuses production even with its flag set, because the lab
 * is a measurement page that must never ship. Perio voice is a PRODUCT feature
 * that will ship after the pilot, so it has no hard prod refusal: production is
 * off simply because production never sets the flag. Turning it on there later
 * is an app-setting change, not a code change.
 *
 * Off means: the token route is not mounted (POST /api/hyg/voice/token falls
 * through to the 404), and /auth/me says `hygVoice: false`, so the perio sheet
 * renders no voice UI at all.
 */

const FLAG_ENV = 'HYG_VOICE';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isHygVoiceEnabled(env = process.env) {
  return env[FLAG_ENV] === '1';
}

module.exports = { FLAG_ENV, isHygVoiceEnabled };
