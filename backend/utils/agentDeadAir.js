'use strict';

/**
 * "Dropped by Karen" — did the AI go silent on a caller who was mid-conversation?
 *
 * From ~2026-09-29 to 2026-10-26 the after-hours agent (v14) went silent after the
 * caller's first sentence on appointment calls: a routing node waited for a turn the
 * caller was waiting for Karen to take, and Retell hung up on the silence with
 * disconnection_reason 'inactivity'. 28 of 89 calls ended that way and nobody noticed for
 * four weeks, because those rows looked like every other short call. Fixed in agent v16;
 * this flag exists so a recurrence is visible on the worklist within a day.
 *
 * A call is flagged only when ALL of these hold:
 *   - disconnection_reason === 'inactivity'   (Retell ended it on silence)
 *   - direction is inbound                     (a caller rang us)
 *   - the LAST turn with words in it is the caller's — they spoke, then nothing came back.
 *
 * When the AGENT spoke last before the silence, the caller walked away from a question;
 * that is abandonment, not an agent failure, and is NOT flagged. Turns with empty content
 * are skipped, so an agent turn that produced no words after the caller's sentence is the
 * defect itself, not evidence the agent answered.
 *
 * Pure and derived: reads only fields already on the stored call (disconnection_reason,
 * direction, transcript_json in the canonical shape from utils/transcriptShape.js) and
 * persists nothing. Computed at read time by routes/unifiedCalls.js.
 */

const DEAD_AIR_REASON = 'inactivity';

/**
 * @typedef {'dead_air' | 'not_inactivity' | 'not_inbound' | 'no_transcript' | 'agent_spoke_last'} DeadAirVerdict
 */

/**
 * Why a call is or isn't flagged. `no_transcript` is broken out so the read path can count
 * inactivity calls it could not judge rather than silently treating them as fine.
 *
 * @param {{ disconnection_reason?: unknown, direction?: unknown, transcript_json?: unknown } | null | undefined} call
 * @returns {DeadAirVerdict}
 */
function classifyDeadAir(call) {
  if (!call || call.disconnection_reason !== DEAD_AIR_REASON) return 'not_inactivity';
  if (typeof call.direction !== 'string' || call.direction.trim().toLowerCase() !== 'inbound') {
    return 'not_inbound';
  }
  const turns = Array.isArray(call.transcript_json) ? call.transcript_json : null;
  if (!turns || turns.length === 0) return 'no_transcript';

  let last = null;
  for (const turn of turns) {
    if (turn && typeof turn.content === 'string' && turn.content.trim() !== '') last = turn;
  }
  if (!last) return 'no_transcript';
  return last.role === 'user' ? 'dead_air' : 'agent_spoke_last';
}

/**
 * @param {Parameters<typeof classifyDeadAir>[0]} call
 * @returns {boolean}
 */
function isAgentDeadAir(call) {
  return classifyDeadAir(call) === 'dead_air';
}

module.exports = { isAgentDeadAir, classifyDeadAir, DEAD_AIR_REASON };
