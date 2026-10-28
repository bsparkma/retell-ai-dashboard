'use strict';

/**
 * Day-card visit progress — the PURE derivation (no I/O, no clock).
 *
 * GET /api/hyg/day/progress reads three of this platform's own tables and hands
 * the rows here; this decides what each card's pill and step marks say. Kept
 * pure so the whole vocabulary is pinned by one table test
 * (visitProgress.test.js) rather than by whichever route happened to exercise
 * a branch.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HONEST STATES
 * ═════════════════════════════════════════════════════════════════════════════
 * `written` comes from exactly one place: a staged write whose state is
 * `Written`, which visitStore only reaches after a READ-BACK confirmed the write
 * landed (services/hyg/sendVisit.js). Nothing here infers it — not from a
 * `sent_at`, not from a perio send row, not from a checkout alert. A card that
 * says "In chart" when the chart does not have it is the one thing this pill
 * must never do.
 *
 * sendVisit.js says "a visit is never 'sent' — its individual writes are". The
 * overall pill does not contradict that: `sent` means every APPLICABLE write
 * individually reached `Written`, and the four step marks beside it still say
 * which is which.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOT APPLICABLE IS NOT DONE
 * ═════════════════════════════════════════════════════════════════════════════
 *   perio  — `not_applicable` when the visit has no perio write at all. Most
 *            prophies chart no perio, and "Perio —" on every card would read as
 *            a step nobody did.
 *   tc     — `not_applicable` when there is no handoff row AND the visit has
 *            neither treatment items NOR an existing-treatment answer TC must act
 *            on (ready to schedule / see the plan again / cost questions —
 *            feedback round 1) NOR anything to collect at checkout (checkout
 *            v2). The composer REFUSES a handoff with none of the three
 *            (stagedWriteComposer.js: "An empty case in a treatment
 *            coordinator's queue is worse than no case"), so without this such a
 *            visit could never read `sent`. A visit with either and no handoff
 *            staged is `none` — still to do.
 *   note, slip — always applicable. Every visit has both.
 */

/** Staged-write state → step state. `Amending` is perio's correction-in-progress. */
const STAGED_TO_STEP = Object.freeze({
  Draft: 'drafting',
  Amending: 'drafting',
  Staged: 'ready',
  Sending: 'sending',
  Written: 'written',
  Failed: 'failed',
});

/** A perio send still talking to Open Dental. See perioSendStore.js. */
const PERIO_IN_FLIGHT = Object.freeze(['posting', 'filling']);

/** Card step → hyg_staged_write.kind. The slip is the `router` write. */
const STEP_KINDS = Object.freeze({
  note: 'note',
  slip: 'router',
  perio: 'perio',
  tc: 'tc-handoff',
});

/**
 * One staged write's step state.
 *
 * @param {{ state: string, hasError?: boolean } | undefined} row
 * @returns {'none'|'drafting'|'ready'|'sending'|'written'|'failed'}
 */
function stepFromStaged(row) {
  if (!row) return 'none';
  const mapped = STAGED_TO_STEP[row.state];
  // A state this file does not know is NOT guessed into a friendly one. It is
  // surfaced as needing attention, so a migration that adds a state shows up
  // on a card rather than vanishing into "in progress".
  if (!mapped) return 'failed';
  // The schema only lets a Failed row carry a reason, so this is a backstop:
  // a reason on a row that is not Written is a failure somebody must see.
  if (mapped !== 'written' && row.hasError) return 'failed';
  return mapped;
}

/**
 * Derive one visit's progress.
 *
 * @param {null | {
 *   checkoutSentAt: unknown,
 *   checkoutFinalAt: unknown,
 *   treatmentItemCount: number,
 *   tcActionableCount?: number,
 *   collectCount?: number,
 *   stagedWrites: Array<{ kind: string, state: string, hasError?: boolean }>,
 *   latestPerioSendState: string | null,
 * }} visit  null when there is no hyg_visit row for this appointment.
 */
function deriveVisitProgress(visit) {
  if (!visit) return { overall: 'not_started', steps: null };

  /** @type {Record<string, { state: string, hasError?: boolean }>} */
  const byKind = {};
  for (const w of visit.stagedWrites || []) byKind[w.kind] = w;

  const note = stepFromStaged(byKind[STEP_KINDS.note]);
  const slip = stepFromStaged(byKind[STEP_KINDS.slip]);

  let perio;
  if (!byKind[STEP_KINDS.perio]) {
    perio = 'not_applicable';
  } else {
    perio = stepFromStaged(byKind[STEP_KINDS.perio]);
    // A send between its bounded steps is still in flight, whatever moment the
    // staged row was caught at. Never upgrades anything to `written`.
    if (perio !== 'written' && perio !== 'failed' && PERIO_IN_FLIGHT.includes(visit.latestPerioSendState)) {
      perio = 'sending';
    }
  }

  let tcState;
  // Feedback round 1: a visit with no new treatment but an existing-treatment
  // answer TC must act on has a handoff to send, so the step applies to it too.
  // Checkout v2: so does a visit with something to collect at checkout.
  if (
    !byKind[STEP_KINDS.tc] &&
    !(visit.treatmentItemCount > 0) &&
    !(visit.tcActionableCount > 0) &&
    !(visit.collectCount > 0)
  ) {
    tcState = 'not_applicable';
  } else {
    tcState = stepFromStaged(byKind[STEP_KINDS.tc]);
  }
  const checkoutSent = visit.checkoutSentAt !== null && visit.checkoutSentAt !== undefined;
  const checkoutFinal = visit.checkoutFinalAt !== null && visit.checkoutFinalAt !== undefined;
  const tc = {
    state: tcState,
    // Front desk was told; the handoff itself has not landed. Reported beside
    // the state, never instead of it, so a FAILED handoff still reads failed.
    checkoutAlerted: checkoutSent && tcState !== 'written',
    checkoutFinal,
  };

  const steps = { note: { state: note }, slip: { state: slip }, perio: { state: perio }, tc };
  const applicable = [note, slip, perio, tcState].filter((s) => s !== 'not_applicable');

  let overall;
  if (applicable.includes('failed')) overall = 'needs_attention';
  else if (applicable.every((s) => s === 'written')) overall = 'sent';
  // READY TO SEND means the whole visit is: every applicable step is staged or
  // already in the chart. A step nobody has started (`none`) keeps it in
  // progress — "Ready to send" beside a note that was never drafted would send
  // a hygienist to the confirm screen with half a visit. Ruled 2026-10-27.
  // All-written was caught above, so this branch always has at least one ready.
  else if (applicable.every((s) => s === 'ready' || s === 'written')) overall = 'ready_to_send';
  else overall = 'in_progress';

  return { overall, steps };
}

/**
 * Parse `?apt=` — a comma list of AptNums. Positive integers only, deduped,
 * at most `max` after dedupe.
 *
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {{ ok: true, aptNums: number[] } | { ok: false, error: string }}
 */
function parseAptNums(raw, max = 200) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'apt query param is required: a comma-separated list of AptNums' };
  }
  const seen = new Set();
  for (const part of raw.split(',')) {
    const t = part.trim();
    // Digits only: "1e3", "0x10", "-4" and "12.0" are not appointment numbers.
    if (!/^[1-9]\d{0,17}$/.test(t)) {
      return { ok: false, error: 'every apt value must be a positive integer AptNum' };
    }
    const n = Number(t);
    if (!Number.isSafeInteger(n)) {
      return { ok: false, error: 'every apt value must be a positive integer AptNum' };
    }
    seen.add(n);
  }
  if (seen.size > max) {
    return { ok: false, error: `at most ${max} AptNums per request` };
  }
  return { ok: true, aptNums: [...seen] };
}

module.exports = { deriveVisitProgress, parseAptNums, stepFromStaged, STEP_KINDS };
