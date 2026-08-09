/**
 * Mango ↔ Retell twin correlation (slice M7) — pure functions, unit-tested.
 *
 * WHY THIS EXISTS. Retell answers Roland's after-hours/overflow calls, but those calls
 * still traverse the Mango PBX on their way to Retell. Both systems therefore log the
 * SAME conversation, and the unified store ends up holding two rows for it: a Retell row
 * (which owns the transcript, the analysis and the agent) and a Mango row that is a pure
 * duplicate of it. Measured on the prod store over the 14 days to 2026-08-09: 67 twins,
 * 94% of all Retell calls, and every one of the 67 Mango duplicates was still sitting
 * unworked in the front desk's "Needs attention" view.
 *
 * THERE IS NO HARD JOIN KEY, and there cannot be one from the data as stored — neither
 * system carries a reference to the other, and `unifiedCallStore.normalizeCall` drops
 * `raw_data` anyway. What we have instead is a physical invariant: the two legs are the
 * same audio path, so they END AT THE SAME INSTANT. The Mango leg simply starts earlier,
 * by exactly the time the PBX spent ringing before it forwarded:
 *
 *     Δstart = retell.call_date − mango.call_date        (observed +5s … +29s)
 *     Δend   = (retell.call_date + retell.duration)
 *            − (mango.call_date  + mango.duration)       ≈ 0
 *
 * so `mango_duration − retell_duration === Δstart`, which is exactly what the prod data
 * shows on every twin.
 *
 * WHY THE END-ALIGNMENT TERM CARRIES THE RULE. Same-caller-close-together is COMMON —
 * 43 Mango pairs within 60s of each other in that same 14-day window, plus 77 more
 * within 5 minutes. A "same caller ± a few minutes" rule collides badly on real data.
 * Δend is what makes the match unambiguous: two genuinely distinct calls do not
 * terminate at the same instant. Measured fan-out on prod (matches / max candidates):
 *
 *     Δend ±1s → 56/1     ±2s → 67/1     ±3s → 67/1
 *          ±5s → 68/1    ±10s → 69/1    ±30s → 70/2   ← first ambiguity
 *
 * ±2s sits on the plateau with 15s of headroom before anything becomes ambiguous, and it
 * produced a strict 1:1 bijection in both directions. Do NOT relax this to a Δstart-only
 * rule to "catch a few more" — the Δstart window is not even load-bearing here (an
 * unbounded window still yields 67 with fan-out 1), and loosening it is precisely what
 * would start swallowing the follow-legs described below.
 *
 * WHAT MUST NOT BE LINKED. Of the 67 twins, 19 have another same-caller Mango row within
 * 10 minutes of the AI hanging up. Every one is either the caller REDIALLING (inbound,
 * still missed) or the office CALLING THE PATIENT BACK (outbound, answered). Those are
 * real conversations the worklist exists to surface, and a sloppier rule would bury them.
 * They are excluded here structurally: they do not share an end instant.
 */

/** Max |Δend| for two legs to be the same conversation. See the fan-out table above. */
const END_SKEW_SECONDS = 2;
/**
 * Bounds on the ring-then-forward delay. The lower bound is slightly negative purely to
 * absorb clock skew between Mango's `started_at` and Retell's `start_timestamp` — a Retell
 * leg cannot really begin before the PBX leg that forwarded it.
 */
const MIN_FORWARD_DELAY_SECONDS = -2;
const MAX_FORWARD_DELAY_SECONDS = 120;

/**
 * Retell `disconnection_reason` values that mean the AI handed the caller to a human.
 *
 * When one of these appears the Mango leg is NOT a duplicate — it holds the human half of
 * the conversation, which Retell's transcript by definition does not have — so it must
 * stay in the worklist. Zero of these have been observed in production to date (see
 * `isTransferDisconnect`); this set plus the store's counter is the tripwire that tells us
 * the day that changes.
 */
const TRANSFER_DISCONNECT_REASONS = new Set([
  'call_transfer',
  'agent_transfer',
  'transfer',
  'transferred',
  'agent_hangup_after_transfer',
]);

/** Link roles written onto the two rows. */
const ROLE_PRIMARY = 'primary';          // the Retell row — owns the transcript
const ROLE_DUPLICATE = 'duplicate_leg';  // the Mango row of an AI-COMPLETED call
const ROLE_TRANSFERRED = 'transferred_leg'; // the Mango row of a call the AI transferred

/**
 * Canonical caller key: the last 10 digits, or null when there aren't enough to be a real
 * number. REQUIRED — the two sources format the same number differently (Mango stores
 * "(918) 555-1234" on 1,036 of 1,038 prod rows; Retell stores E.164 on all of them), which
 * is also why the store's existing `byCallerNumber` index cannot be used for this: it keys
 * on the raw string, so it can never match across sources.
 * @param {string|number|null|undefined} number
 * @returns {string|null}
 */
function callerKey(number) {
  const digits = String(number == null ? '' : number).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * A call's start instant in epoch seconds, or null when the date is unusable.
 * @param {{call_date?: string}} call
 * @returns {number|null}
 */
function startSeconds(call) {
  if (!call || !call.call_date) return null;
  const ms = new Date(call.call_date).getTime();
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * A call's duration in seconds, floored at 0 for missing/garbage values.
 * @param {{duration_seconds?: number}} call
 * @returns {number}
 */
function durationSeconds(call) {
  const d = Number(call && call.duration_seconds);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Whether a Retell `disconnection_reason` means the call was handed to a human.
 * Tolerant of case/spacing so an unseen Retell variant still trips the wire rather than
 * being silently treated as an AI-completed call.
 * @param {string|null|undefined} reason
 * @returns {boolean}
 */
function isTransferDisconnect(reason) {
  if (typeof reason !== 'string') return false;
  const normalized = reason.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return false;
  return TRANSFER_DISCONNECT_REASONS.has(normalized) || normalized.includes('transfer');
}

/**
 * Are these two rows the same conversation?
 *
 * Deliberately strict about its arguments: it takes the Mango leg and the Retell leg in
 * that order and refuses anything else, so a caller cannot accidentally "link" two Mango
 * rows (the redial case) or two Retell rows.
 *
 * @param {object} mangoCall the Mango (PBX) leg
 * @param {object} retellCall the Retell (AI) leg
 * @returns {boolean}
 */
function isTwin(mangoCall, retellCall) {
  if (!mangoCall || !retellCall) return false;
  if (mangoCall.source !== 'mango' || retellCall.source !== 'retell') return false;

  // An OUTBOUND Mango leg is the office dialling the patient — never the inbound leg that
  // was forwarded to the AI. Excluded explicitly as well as by Δend, because this is the
  // case (staff calling a patient back after an AI call) where a human's work would be
  // hidden if the rule were ever loosened. `direction` is null on older rows, so only an
  // explicit 'outbound' disqualifies.
  if (String(mangoCall.direction || '').toLowerCase() === 'outbound') return false;

  const key = callerKey(mangoCall.caller_number);
  if (!key || key !== callerKey(retellCall.caller_number)) return false;

  const mangoStart = startSeconds(mangoCall);
  const retellStart = startSeconds(retellCall);
  if (mangoStart === null || retellStart === null) return false;

  const mangoDuration = durationSeconds(mangoCall);
  // A zero-length PBX leg has no span to align against — anything would "match" it within
  // tolerance once the AI leg is short too. Refuse rather than guess.
  if (mangoDuration <= 0) return false;

  const forwardDelay = retellStart - mangoStart;
  if (forwardDelay < MIN_FORWARD_DELAY_SECONDS || forwardDelay > MAX_FORWARD_DELAY_SECONDS) {
    return false;
  }

  const endSkew = (retellStart + durationSeconds(retellCall)) - (mangoStart + mangoDuration);
  return Math.abs(endSkew) <= END_SKEW_SECONDS;
}

/**
 * Find the ONE Retell leg that twins this Mango leg.
 *
 * Ambiguity is a refusal, not a coin flip: if two candidates both satisfy the rule we link
 * neither and report it, because linking the wrong one hides the wrong row. This never
 * fired on 14 days of production data (fan-out was 1 for every twin) — it exists so that
 * if the assumption ever breaks, it breaks loudly and safely.
 *
 * @param {object} mangoCall
 * @param {Iterable<object>} candidates Retell calls to consider
 * @returns {{twin: object|null, ambiguous: boolean}}
 */
function findTwin(mangoCall, candidates) {
  const matches = [];
  for (const candidate of candidates || []) {
    if (isTwin(mangoCall, candidate)) {
      matches.push(candidate);
      if (matches.length > 1) break; // one extra is all we need to know it's ambiguous
    }
  }
  if (matches.length === 1) return { twin: matches[0], ambiguous: false };
  return { twin: null, ambiguous: matches.length > 1 };
}

/**
 * The role the MANGO leg should carry, given its Retell twin.
 *
 * An AI-completed call leaves a Mango leg that is pure duplication — nothing on it that
 * the primary doesn't already hold — so it can drop out of the default worklist view. A
 * TRANSFERRED call is the opposite: the Mango leg carries the human conversation the AI's
 * transcript lacks, so it keeps a distinct role and stays visible.
 *
 * @param {object} retellTwin
 * @returns {'duplicate_leg'|'transferred_leg'}
 */
function mangoLegRole(retellTwin) {
  return isTransferDisconnect(retellTwin && retellTwin.disconnection_reason)
    ? ROLE_TRANSFERRED
    : ROLE_DUPLICATE;
}

module.exports = {
  callerKey,
  startSeconds,
  durationSeconds,
  isTwin,
  findTwin,
  isTransferDisconnect,
  mangoLegRole,
  END_SKEW_SECONDS,
  MIN_FORWARD_DELAY_SECONDS,
  MAX_FORWARD_DELAY_SECONDS,
  TRANSFER_DISCONNECT_REASONS,
  ROLE_PRIMARY,
  ROLE_DUPLICATE,
  ROLE_TRANSFERRED,
};
