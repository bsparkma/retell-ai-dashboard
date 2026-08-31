/**
 * THE APPROVE PAGE'S TOTALS ROW — `features/rcm/rollup.ts` (Stage C, §6).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE CLAIM, ONE ASSERTION: THE ROLL-UP IS THE SUM OF THE CLAIM VERDICTS
 * ═════════════════════════════════════════════════════════════════════════════
 * The approve page prints a row per claim and a totals row underneath, on the
 * last screen before an irreversible press. There are two ways to produce that
 * row and only one is safe: add up the numbers the per-claim verdicts already
 * carry, or walk the lines and recompute the money.
 *
 * The second is a SECOND implementation of this module's money. It would agree
 * with the rows above it on the day it was written and diverge the first time
 * `verdictFor` learned something — a partial write-off, a line excluded from a
 * projection, a register that measures rather than derives.
 *
 * So the test asserts the identity itself, field by field, over a mixed check
 * rather than a worked example: whatever the verdicts say, the total is their
 * sum and nothing else.
 *
 * NO REAL PATIENT DATA. Every name and figure below is synthetic.
 */
import { describe, expect, it } from "vitest";
import { decisionsWithClaim, rollUp, rollUpSentence } from "@/features/rcm/rollup";
import { money } from "@/features/rcm/format";
import type { ApprovalClaim, ClaimVerdict } from "@/features/rcm/api";

function verdict(over: Partial<ClaimVerdict> = {}): ClaimVerdict {
  return {
    state: "green",
    register: "projection",
    eobPatientCents: 4500,
    projectedPatientCents: 4500,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 30000,
    decisions: [],
    problems: [],
    sentence: "This patient will owe $45.00 once this posts — the same as the EOB says.",
    ...over,
  };
}

function claim(over: Partial<ApprovalClaim> = {}): ApprovalClaim {
  return {
    claimId: "c-1",
    claimNumber: "53648",
    patientName: "Fixture, Synthetic",
    postable: true,
    alreadyQueued: false,
    checks: [],
    failed: [],
    verdict: verdict(),
    ...over,
  };
}

describe("the check-level roll-up", () => {
  it("EQUALS the sum of the per-claim verdicts, field by field", () => {
    const claims = [
      claim({
        claimId: "c-1",
        verdict: verdict({
          eobPatientCents: 4500,
          projectedPatientCents: 4500,
          decidedWriteOffCents: 0,
          contractualWriteOffCents: 30000,
        }),
      }),
      claim({
        claimId: "c-2",
        verdict: verdict({
          state: "amber",
          eobPatientCents: 3000,
          projectedPatientCents: 0,
          decidedWriteOffCents: 3000,
          contractualWriteOffCents: 2900,
        }),
      }),
      claim({
        claimId: "c-3",
        verdict: verdict({
          eobPatientCents: 1234,
          projectedPatientCents: 1234,
          decidedWriteOffCents: 0,
          contractualWriteOffCents: 567,
        }),
      }),
    ];

    const roll = rollUp(claims);
    const verdicts = claims.map((c) => c.verdict!);

    /*
     * SUMMED FROM THE VERDICTS THEMSELVES rather than against hand-written
     * constants: a literal here would be a third computation of the same money,
     * and it would be the one that quietly stopped tracking the other two.
     */
    const sum = (pick: (v: ClaimVerdict) => number) =>
      verdicts.reduce((n, v) => n + pick(v), 0);

    expect(roll.eobPatientCents).toBe(sum((v) => v.eobPatientCents));
    expect(roll.projectedPatientCents).toBe(sum((v) => v.projectedPatientCents));
    expect(roll.decidedWriteOffCents).toBe(sum((v) => v.decidedWriteOffCents));
    expect(roll.contractualWriteOffCents).toBe(sum((v) => v.contractualWriteOffCents));
    expect(roll.judged).toBe(3);
    expect(roll.unjudged).toBe(0);
  });

  it("takes the WORST state, because a green total over a red claim is a lie", () => {
    expect(rollUp([claim({ verdict: verdict({ state: "green" }) })]).worst).toBe("green");
    expect(
      rollUp([
        claim({ claimId: "c-1", verdict: verdict({ state: "green" }) }),
        claim({ claimId: "c-2", verdict: verdict({ state: "amber" }) }),
      ]).worst,
    ).toBe("amber");
    expect(
      rollUp([
        claim({ claimId: "c-1", verdict: verdict({ state: "amber" }) }),
        claim({ claimId: "c-2", verdict: verdict({ state: "red" }) }),
      ]).worst,
    ).toBe("red");
  });

  it("a claim with NO verdict contributes nothing and is counted as unjudged", () => {
    /*
     * NOT ZERO. A snapshot in an older shape carries no verdict, and treating it
     * as $0.00 would let the totals row understate what is about to post — the
     * same lie by a quieter route.
     */
    const roll = rollUp([
      claim({ claimId: "c-1", verdict: verdict({ eobPatientCents: 4500, projectedPatientCents: 4500 }) }),
      claim({ claimId: "c-2", verdict: undefined }),
    ]);

    expect(roll.eobPatientCents).toBe(4500);
    expect(roll.judged).toBe(1);
    expect(roll.unjudged).toBe(1);
    // Both rows are still LISTED — a claim omitted from the table would be a
    // claim about to post that the screen never showed.
    expect(roll.rows).toHaveLength(2);
    expect(roll.rows[1].verdict).toBeNull();
  });

  it("a roll-up over no verdicts is not green — it has established nothing", () => {
    const roll = rollUp([claim({ verdict: undefined })]);
    expect(roll.worst).toBeNull();
    expect(rollUpSentence(roll, money).canApprove).toBe(false);
  });

  it("carries every write-off out WITH its claim, its reason and its author", () => {
    /*
     * The permission decision this block is load-bearing for: a reviewer
     * PROPOSES a write-off on `rcm.queue` and somebody with `rcm.write` ACCEPTS
     * it. That split is only honest while the accepting screen names whose
     * decision it is — so the roll-up may never reduce this to a total.
     */
    const rows = decisionsWithClaim([
      claim({
        claimId: "c-2",
        patientName: "Second, Synthetic",
        verdict: verdict({
          state: "amber",
          decidedWriteOffCents: 3000,
          decisions: [
            {
              lineId: "l-9",
              code: "D0274",
              amountCents: 3000,
              reason: "xrays_bitewings",
              reasonLabel: "X-rays — bitewings",
              decidedBy: "reviewer@example.test",
              decidedAt: "2026-03-04T21:00:00.000Z",
            },
          ],
        }),
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].patientName).toBe("Second, Synthetic");
    expect(rows[0].decision.reasonLabel).toBe("X-rays — bitewings");
    expect(rows[0].decision.decidedBy).toBe("reviewer@example.test");
    expect(rows[0].decision.decidedAt).toBe("2026-03-04T21:00:00.000Z");
  });
});

describe("the whole-check sentence", () => {
  it("is a PROJECTION, always, and never wears a confirmation's words", () => {
    /*
     * The approve page is by construction BEFORE the post. A sentence there
     * saying "owes" or "confirmed" would be the honest-states rule failing in
     * the most expensive place there is, so the register is not even a
     * parameter — there is no caller who could hold the other one.
     */
    for (const state of ["green", "amber", "red"] as const) {
      const out = rollUpSentence(rollUp([claim({ verdict: verdict({ state }) })]), money);
      expect(out.register).toBe("projection");
      expect(out.sentence).not.toMatch(/\bconfirmed\b/i);
      expect(out.sentence).not.toMatch(/\bowes\b/);
    }
  });

  it("names the office's own write-off on an amber check, and only there", () => {
    const green = rollUpSentence(rollUp([claim({ verdict: verdict({ state: "green" }) })]), money);
    expect(green.sentence).toContain("exactly what the EOB says");
    expect(green.canApprove).toBe(true);

    const amber = rollUpSentence(
      rollUp([
        claim({
          verdict: verdict({
            state: "amber",
            eobPatientCents: 3000,
            projectedPatientCents: 0,
            decidedWriteOffCents: 3000,
          }),
        }),
      ]),
      money,
    );
    expect(amber.sentence).toContain("$30.00 this office decided to absorb");
    expect(amber.canApprove).toBe(true);
  });

  it("refuses on red and sends the reader to the claim rather than quoting two totals", () => {
    /*
     * In the projection register `projected + decided === eob` holds by
     * construction, so the imbalance sentence is unreachable here — the useful
     * thing to say is which line is the problem, which each claim's own verdict
     * already says.
     */
    const out = rollUpSentence(rollUp([claim({ verdict: verdict({ state: "red" }) })]), money);
    expect(out.canApprove).toBe(false);
    expect(out.sentence).toContain("cannot be approved");
  });
});
