/**
 * WHOSE MOVE IS IT, AND WHAT DOES THE CHIP SAY.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS SUITE EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * `features/rcm/waitingOn.ts` is the single predicate behind two columns on two
 * screens — the Checks list's *Waiting on* cell and Today's *What happens next*
 * — and, since slice 1 of the UI overhaul, behind the status chip on both of
 * those plus the check's own page. Four rendered things, one call. It had no
 * unit coverage at all.
 *
 * That is the wrong shape of risk for a file whose entire job is to stop four
 * screens growing four opinions. The screens are tested by rendering them,
 * which is slow and only ever exercises the two or three states a fixture
 * happens to be in; the precedence ladder has ten rungs and the interesting
 * ones are the collisions near the top.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED, AND WHY EACH ONE WOULD COST A MORNING
 * ─────────────────────────────────────────────────────────────────────────────
 *  · EVERY state renders in BOTH registers. A state with one sentence and not
 *    the other renders an empty cell on one of the two screens, and an empty
 *    cell reads as "nothing to do here".
 *  · THE PRECEDENCE COLLISIONS. A takeback that is also unreviewed must read as
 *    a takeback; a stuck check in shadow mode must read as stuck, because the
 *    banner about a switch is the wrong remedy shown first.
 *  · SHADOW MODE ABSENT IS NOT "POSTING IS ON". The whole reason the Checks
 *    list was wrong before this slice.
 *  · THE CHIP VOCABULARY IS SIX WORDS AND TAKES THEM FROM THE TABS. If a chip
 *    could be renamed without its tab following, the module would be back to
 *    two vocabularies for one check.
 *
 * NO REAL PATIENTS. Every payer, number and name below is synthetic.
 */
import { describe, expect, it } from "vitest";
import type { Remittance } from "@/features/rcm/api";
import {
  isTakeback,
  waitingFor,
  WAITING_STATES,
  type WaitingState,
} from "@/features/rcm/waitingOn";
import { CHECK_CHIPS, checkChip, FILTER_COPY } from "@/features/rcm/worklist";

/**
 * A check with nothing outstanding. Every test below turns ON exactly the
 * fields its own state needs, so a fixture cannot quietly satisfy two rungs of
 * the ladder and make a precedence assertion pass for the wrong reason.
 */
function check(over: Partial<Remittance> = {}): Remittance {
  return {
    batchId: "b-1",
    officeId: "roland",
    payer: "SYNTHETIC DENTAL",
    checkNumber: "830200001",
    eftNumber: null,
    traceNumber: null,
    paymentMethod: "check",
    depositDate: "2026-03-02",
    totalAmountCents: 12_500,
    postedAmountCents: 0,
    plbTotalCents: 0,
    claimCount: 4,
    patientNames: { shown: [], more: 0 },
    status: "open",
    source: "835",
    flags: [],
    notes: "",
    createdAt: "2026-03-02T15:00:00.000Z",
    createdBy: null,
    balance: {
      batchTotalCents: 12_500,
      claimTotalCents: 12_500,
      differenceCents: 0,
      plbTotalCents: 0,
      balanced: true,
    },
    needsAttention: false,
    attentionReasons: [],
    attentionObservations: [],
    reviewReasonCount: 0,
    unmatchedClaimCount: 0,
    queuedClaimCount: 0,
    approvalAttemptedAt: null,
    approvalAttemptedBy: null,
    parkedAt: null,
    parkedBy: null,
    parkedNote: null,
    setAsideAt: null,
    setAsideBy: null,
    setAsideReason: null,
    setAsideNote: null,
    ...over,
  } as Remittance;
}

// ─── Both registers, for every state ─────────────────────────────────────────

describe("every waiting state speaks in both registers", () => {
  /**
   * One row per state, chosen to land on exactly that rung. `nothing` is the
   * bare fixture; the rest turn on one thing each.
   */
  const CASES: Record<WaitingState, Remittance> = {
    set_aside: check({ setAsideAt: "2026-03-04T23:00:00.000Z" }),
    other_office: check({ officeId: "valley" }),
    takeback: check({ totalAmountCents: -4_000 }),
    stuck: check({ attentionReasons: ["posting_failed"] }),
    shadow: check({ queuedClaimCount: 4 }),
    posted: check(),
    match: check({ attentionObservations: ["claims_unmatched"], unmatchedClaimCount: 2 }),
    review: check({ attentionReasons: ["claims_unreviewed"] }),
    approve: check({ attentionReasons: ["claims_awaiting_approval"] }),
    nothing: check(),
  };

  const CTX: Partial<Record<WaitingState, Parameters<typeof waitingFor>[1]>> = {
    shadow: { office: "roland", shadowMode: true },
    posted: { office: "roland", confirmedAt: "2026-03-05T21:30:00.000Z" },
  };

  it("covers the closed set — a state with no case here is a state nobody checked", () => {
    expect(Object.keys(CASES).sort()).toEqual([...WAITING_STATES].sort());
  });

  for (const state of WAITING_STATES) {
    it(`${state}: lands on its own rung and fills both columns`, () => {
      const w = waitingFor(CASES[state], CTX[state] ?? { office: "roland" });
      expect(w.state).toBe(state);
      /*
       * NON-EMPTY IN BOTH. An empty cell on a worklist does not read as "we
       * have nothing to say", it reads as "nothing to do" — which is the one
       * meaning that must never be produced by accident.
       */
      expect(w.waitingOn.trim().length, `${state} waitingOn`).toBeGreaterThan(0);
      expect(w.next.trim().length, `${state} next`).toBeGreaterThan(0);
    });
  }
});

// ─── The sentences the design named ──────────────────────────────────────────

describe("the sentences name WHO, in the words the design asked for", () => {
  it("names the reader, and counts what she owes", () => {
    const w = waitingFor(
      check({ attentionReasons: ["claims_unreviewed"], claimCount: 4, queuedClaimCount: 0 }),
      { office: "roland" },
    );
    expect(w.waitingOn).toBe("You — 4 claims to check over");
  });

  it("names an administrator's switch rather than the reader", () => {
    // The point of the whole state: she cannot move this one, so the sentence
    // must not start with "You".
    const w = waitingFor(check({ queuedClaimCount: 4 }), { office: "roland", shadowMode: true });
    expect(w.waitingOn).toBe("Shadow mode — posting is switched off");
    expect(w.waitingOn.startsWith("You")).toBe(false);
  });

  it("names nobody when the check belongs to another practice", () => {
    const w = waitingFor(check({ officeId: "valley" }), { office: "roland" });
    expect(w.waitingOn).toBe("Nobody — belongs to another office");
    expect(w.urgent).toBe(false);
  });

  it("names the takeback for what it is", () => {
    const w = waitingFor(check({ totalAmountCents: -4_000 }), { office: "roland" });
    expect(w.waitingOn).toBe("A takeback — money the carrier is reclaiming");
    expect(w.urgent).toBe(true);
  });

  it("singularises rather than printing '1 claims'", () => {
    const w = waitingFor(
      check({ attentionReasons: ["claims_unreviewed"], claimCount: 1, queuedClaimCount: 0 }),
      { office: "roland" },
    );
    expect(w.waitingOn).toBe("You — 1 claim to check over");
  });
});

// ─── The collisions ──────────────────────────────────────────────────────────

describe("precedence, at the rungs that actually collide", () => {
  it("a takeback that is also unreviewed reads as a takeback", () => {
    /*
     * Money moving backwards is the one a person must not skim past, so it
     * outranks her ordinary queue even though the ordinary queue is also true.
     */
    const w = waitingFor(
      check({ totalAmountCents: -4_000, attentionReasons: ["claims_unreviewed"] }),
      { office: "roland" },
    );
    expect(w.state).toBe("takeback");
  });

  it("a stuck check in shadow mode reads as stuck, not as shadow", () => {
    /*
     * A stuck check is stuck whether or not posting is switched on. Leading
     * with the switch would offer a remedy that does not apply and send her to
     * an administrator for something she can fix herself.
     */
    const w = waitingFor(
      check({ attentionReasons: ["posting_failed"], queuedClaimCount: 4 }),
      { office: "roland", shadowMode: true },
    );
    expect(w.state).toBe("stuck");
  });

  it("set aside outranks everything, including a takeback", () => {
    const w = waitingFor(
      check({ setAsideAt: "2026-03-04T23:00:00.000Z", totalAmountCents: -4_000 }),
      { office: "roland" },
    );
    expect(w.state).toBe("set_aside");
  });

  it("still waiting to be approved is HER move, even in shadow mode", () => {
    // Shadow only speaks once there is nothing left for her to approve.
    const w = waitingFor(
      check({ attentionReasons: ["claims_awaiting_approval"], queuedClaimCount: 2 }),
      { office: "roland", shadowMode: true },
    );
    expect(w.state).toBe("approve");
  });

  it("an absent shadowMode is not a claim that posting is ON", () => {
    /*
     * THE DEFECT THIS SLICE FIXED, pinned as a rule. The Checks list passed no
     * shadowMode at all, so an approved check waiting on an administrator read
     * there as "You — it is ready to approve": work she could not move. The
     * contract is that absent means "this screen did not ask", and the cell
     * then says nothing about the switch either way.
     */
    const approved = check({ queuedClaimCount: 4 });
    expect(waitingFor(approved, { office: "roland" }).state).not.toBe("shadow");
    expect(waitingFor(approved, { office: "roland" }).waitingOn).not.toMatch(/shadow/i);
    expect(waitingFor(approved, { office: "roland", shadowMode: true }).state).toBe("shadow");
  });

  it("reads a takeback off the flags as well as off a negative total", () => {
    expect(isTakeback(check({ totalAmountCents: -1 }))).toBe(true);
    expect(isTakeback(check({ flags: ["negative_total_payment"] }))).toBe(false);
    expect(isTakeback(check({ flags: ["reversal_not_postable"] }))).toBe(true);
    expect(isTakeback(check())).toBe(false);
  });
});

// ─── The chip vocabulary ─────────────────────────────────────────────────────

describe("one chip vocabulary, six words, taken from the tabs", () => {
  it("renders exactly the six states the design named", () => {
    const withChips = WAITING_STATES.filter((s) => CHECK_CHIPS[s] !== null);
    expect([...withChips].sort()).toEqual(
      ["approve", "match", "posted", "review", "set_aside", "stuck"].sort(),
    );
    expect(withChips.map((s) => CHECK_CHIPS[s]!.label)).toEqual(
      expect.arrayContaining([
        "Waiting for your review",
        "Waiting to be matched",
        "Stuck — needs you",
        "Ready to post",
        "✓ Posted",
        "Set aside",
      ]),
    );
  });

  it("takes its words from FILTER_COPY, so a tab and its chip cannot drift", () => {
    /*
     * The assertion is IDENTITY with the tab label, not equality with a string
     * typed here twice. Retyping them would let this test keep passing while
     * the chip and the tab said different things — the exact failure the one
     * vocabulary exists to prevent.
     */
    expect(checkChip("review")!.label).toBe(FILTER_COPY.review.label);
    expect(checkChip("match")!.label).toBe(FILTER_COPY.match.label);
    expect(checkChip("stuck")!.label).toBe(FILTER_COPY.blocked.label);
    expect(checkChip("approve")!.label).toBe(FILTER_COPY.approve.label);
    expect(checkChip("set_aside")!.label).toBe(FILTER_COPY.set_aside.label);
  });

  it("gives no chip to the four states that are sentences", () => {
    // Squeezing "money the carrier is reclaiming" into a badge would either lie
    // by abbreviation or invent a seventh word. The cell beside it says it all.
    for (const state of ["takeback", "shadow", "other_office", "nothing"] as const) {
      expect(checkChip(state), state).toBeNull();
    }
  });

  it("colours weight and never content — amber for stuck, green for ready", () => {
    expect(checkChip("stuck")!.tone).toMatch(/amber/);
    expect(checkChip("approve")!.tone).toMatch(/emerald/);
    /*
     * A chip painted from a LITERAL palette (amber-50, emerald-50, sky-50) must
     * carry its dark-mode counterpart or half the practice reads dark text on a
     * dark ground. A chip using the theme TOKENS (bg-muted) must not — those
     * already resolve per theme, and a `dark:` on top of one would be a second
     * opinion about a colour the design system has already decided.
     */
    for (const state of WAITING_STATES) {
      const chip = checkChip(state);
      if (!chip) continue;
      const literal = /(?:amber|emerald|sky|rose)-[0-9]/.test(chip.tone);
      expect(/dark:/.test(chip.tone), `${state}: ${chip.tone}`).toBe(literal);
    }
  });
});
