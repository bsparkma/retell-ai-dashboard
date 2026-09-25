/**
 * S8 FLOW-SPEED, ITEM 2 — what Open Dental holds, and how it is worded.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE THREE RULES THIS PINS
 * ═════════════════════════════════════════════════════════════════════════════
 *  1. ONLY `R` IS CLAIMED. This repo can prove exactly one Open Dental
 *     ClaimStatus value — `R` is RECEIVED, from `claimMatch.js`'s
 *     `CLAIM_ALREADY_RECEIVED` blocker and from the posting write itself, which
 *     is `PUT /claims/{n} {ClaimStatus:"R", DateReceived}`. Every other letter is
 *     provably NOT received and nothing more, and the fold must not invent
 *     wording for it.
 *
 *  2. PENDING IS NEUTRAL. A chart claim that has not been received is the normal
 *     state of a claim this check is about to pay. Red and amber on these
 *     screens mean the carrier and the chart DISAGREE; spending either on
 *     "not received yet" teaches a reader to discount the one colour meant to
 *     stop her.
 *
 *  3. THE DELTA IS THE MATCH'S, NEVER A SECOND OPINION. A line colours only
 *     where `linePairs[].billedDeltaCents` says the two sides differ. Nothing
 *     here re-compares two amounts — that is how an amber row ends up beside a
 *     green verdict.
 *
 * Fixtures are synthetic; the patient is the module's own Roland test fixture.
 */
import { describe, expect, it } from "vitest";
import type { MatchCandidate } from "@/features/rcm/api";
import {
  alreadyOnTheClaim,
  odAccountLines,
  odClaimStanding,
} from "@/features/rcm/odAccount";
import { claimNumberNote } from "@/features/rcm/matchWords";

function odLine(over: Record<string, unknown> = {}) {
  return {
    claimProcNum: 99001,
    procNum: 5001,
    code: "D0150",
    status: "C",
    feeBilledCents: 21000,
    insPayAmtCents: 0,
    writeOffCents: 0,
    dedAppliedCents: 0,
    insEstCents: 15000,
    isTransfer: false,
    claimPaymentNum: null,
    deleted: false,
    blockedStatus: false,
    ...over,
  };
}

function candidate(over: Record<string, unknown> = {}): MatchCandidate {
  const { od, ...rest } = over as { od?: Record<string, unknown> };
  return {
    odClaimNum: 900402,
    odPatNum: 12827,
    score: 90,
    confidence: "HIGH",
    evidence: [{ tag: "CLAIM_NUMBER_MATCH", weight: 35, detail: "" }],
    blockers: [],
    od: {
      claimStatus: "S",
      dateService: "2026-09-01",
      claimHeaderFeeCents: 21000,
      billedCents: 21000,
      insPaidCents: 0,
      writeOffCents: 0,
      patientName: "Test 2, Stedi",
      patientBirthdate: "1988-07-14",
      subscriberId: "SY4471902",
      lines: [odLine()],
      deletedLineCount: 0,
      unknownDeletedLineCount: 0,
      ...od,
    },
    linePairs: [
      { lineId: "pl-1", position: 1, code: "D0150", odClaimProcNum: 99001, odCode: "D0150", billedDeltaCents: 0, reason: null },
    ],
    ...rest,
  } as unknown as MatchCandidate;
}

describe("the chart claim's standing", () => {
  it("calls R received, and says what that means for a second payment", () => {
    const s = odClaimStanding("R");
    expect(s.received).toBe(true);
    expect(s.label).toBe("Received");
    expect(s.detail).toMatch(/second one/);
  });

  /*
   * THE HONEST HALF. `S`, `W`, `H` and anything else are all provably NOT
   * received and nothing here claims to know which is which — the raw code is
   * carried through so a reader who needs it can have it.
   */
  it.each(["S", "W", "H", "U", "X"])("calls %s pending, without inventing wording for it", (code) => {
    const s = odClaimStanding(code);
    expect(s.received).toBe(false);
    expect(s.label).toBe("Pending in Open Dental");
    expect(s.code).toBe(code);
    // It says what is TRUE of every non-R code and nothing about which one.
    expect(s.detail).toMatch(/not marked received yet/i);
  });

  it("says a status was never sent rather than calling it pending for a reason", () => {
    const s = odClaimStanding(null);
    expect(s.received).toBe(false);
    expect(s.code).toBeNull();
    expect(s.detail).toMatch(/did not send a status/i);
  });
});

describe("the chart claim's lines", () => {
  it("carries the delta the MATCH computed, and marks nothing else", () => {
    const rows = odAccountLines(candidate());
    expect(rows).toHaveLength(1);
    expect(rows[0].billedDeltaCents).toBe(0);
    expect(rows[0].code).toBe("D0150");
    expect(rows[0].insEstCents).toBe(15000);
  });

  it("passes a real disagreement through verbatim", () => {
    const c = candidate({
      linePairs: [
        { lineId: "pl-1", position: 1, code: "D0150", odClaimProcNum: 99001, odCode: "D0150", billedDeltaCents: 5400, reason: null },
      ],
    });
    expect(odAccountLines(c)[0].billedDeltaCents).toBe(5400);
  });

  /*
   * A LINE THE MATCH NEVER PAIRED HAS NO DELTA — null, not zero. Zero would say
   * the two sides agree about a line nobody compared, which is the absence-as-
   * agreement failure this module keeps deleting one level up.
   */
  it("gives an unpaired line no delta at all, rather than zero", () => {
    const c = candidate({ linePairs: [] });
    expect(odAccountLines(c)[0].billedDeltaCents).toBeNull();
  });

  it("drops deleted lines and marks the ones that could not be read", () => {
    const c = candidate({
      od: {
        lines: [
          odLine(),
          odLine({ claimProcNum: 99002, code: "D1110", deleted: true }),
          odLine({ claimProcNum: 99003, code: "D0274", deleted: "unknown" }),
        ],
      },
    });
    const rows = odAccountLines(c);
    expect(rows.map((r) => r.code)).toEqual(["D0150", "D0274"]);
    expect(rows[1].unreadable).toBe(true);
  });

  it("marks a line Open Dental has already attached a check to", () => {
    const c = candidate({ od: { lines: [odLine({ claimPaymentNum: 4242 })] } });
    expect(odAccountLines(c)[0].paymentAttached).toBe(true);
  });

  /*
   * OLDER SNAPSHOTS CARRY NEITHER FIELD. They are real records in the database,
   * and a first draft of this function took the whole claim screen down to a
   * blank page on them.
   */
  it("survives a snapshot that predates chart lines", () => {
    const c = candidate({ od: { lines: undefined }, linePairs: undefined });
    expect(odAccountLines(c)).toEqual([]);
  });
});

describe("what the chart claim already carries", () => {
  it("says nothing when it carries nothing, because that is the ordinary case", () => {
    expect(alreadyOnTheClaim(candidate())).toBeNull();
  });

  it("names a payment, a write-off, or both", () => {
    expect(alreadyOnTheClaim(candidate({ od: { insPaidCents: 12000 } }))).toMatch(
      /insurance payment/,
    );
    expect(alreadyOnTheClaim(candidate({ od: { writeOffCents: 600 } }))).toMatch(/write-off/);
    expect(
      alreadyOnTheClaim(candidate({ od: { insPaidCents: 12000, writeOffCents: 600 } })),
    ).toMatch(/insurance payment and a write-off/);
  });
});

describe("the carrier's claim number, as small print", () => {
  it("says so plainly when it names this claim", () => {
    const note = claimNumberNote(candidate(), { claimNumber: "830200001" });
    expect(note.agrees).toBe(true);
    expect(note.text).toContain("830200001");
  });

  /*
   * ITS MISMATCH ALONE IS NOT A WARNING. The copy must not read as one, and the
   * caller renders it muted — the ceremony this fact earns is the Q2 confirm at
   * the press, which is untouched.
   */
  it("states a mismatch without raising an alarm about it", () => {
    const c = candidate({ evidence: [] });
    const note = claimNumberNote(c, { claimNumber: "830200001" });
    expect(note.agrees).toBe(false);
    expect(note.text).toContain("settles nothing");
    expect(note.text).not.toMatch(/warning|wrong|problem|mismatch|do not link/i);
  });

  it("tells 'none sent' apart from 'names another claim'", () => {
    const c = candidate({ evidence: [] });
    expect(claimNumberNote(c, { claimNumber: null }).text).toMatch(/sent no claim number/);
    expect(claimNumberNote(c, { claimNumber: "830200001" }).text).toMatch(/is not Open Dental/);
  });
});
