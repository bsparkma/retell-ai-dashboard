/**
 * S8 · THE MATCH CARD'S FIELD ROWS — `fieldReadings()`.
 *
 * The board draws a tick where a field agrees and an amber sentence where it
 * does not. The rule this suite pins is the one that keeps that honest: a tick
 * only where BOTH sides carried the field AND the scorer-facing comparison found
 * nothing, an amber sentence only where `differences()` wrote one, and nothing
 * at all where one side was silent.
 *
 * Fixtures are synthetic; the patient is the module's own Roland test fixture.
 */
import { describe, expect, it } from "vitest";
import type { MatchCandidate } from "@/features/rcm/api";
import { agreement, differences, fieldReadings } from "@/features/rcm/matchWords";

function candidate(over: Partial<MatchCandidate> & { od?: Partial<MatchCandidate["od"]> } = {}): MatchCandidate {
  const { od, ...rest } = over;
  return {
    odClaimNum: 900402,
    odPatNum: 12827,
    score: 90,
    confidence: "HIGH",
    evidence: [{ tag: "CLAIM_NUMBER_MATCH", weight: 35, detail: "" }] as MatchCandidate["evidence"],
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
      lines: [],
      deletedLineCount: 0,
      unknownDeletedLineCount: 0,
      ...od,
    } as MatchCandidate["od"],
    linePairs: [{ odClaimProcNum: 1 }, { odClaimProcNum: 2 }] as MatchCandidate["linePairs"],
    ...rest,
  };
}

const EOB = { serviceDate: "2026-09-01", billedCents: 21000, patientName: "Stedi Test 2" };

describe("fieldReadings — a tick only where both sides were compared and agreed", () => {
  it("ticks every compared field on a candidate that differs in nothing", () => {
    const r = fieldReadings(candidate(), EOB);
    expect(r.claimNumber.status).toBe("agrees");
    expect(r.name.status).toBe("agrees");
    expect(r.date.status).toBe("agrees");
    expect(r.amount.status).toBe("agrees");
    expect(r.lines.status).toBe("agrees");
  });

  it("carries differences() verbatim where a field differs — value first, then the delta", () => {
    const c = candidate({ od: { dateService: "2026-07-21", billedCents: 15600 } });
    const r = fieldReadings(c, EOB);
    const phrases = differences(c, EOB);
    expect(r.date).toEqual({
      status: "differs",
      phrase: phrases.find((d) => d.kind === "date")?.phrase,
      notable: true,
    });
    expect(r.date.status === "differs" && r.date.phrase).toBe("Jul 21, 2026 — 6 weeks earlier");
    expect(r.amount.status === "differs" && r.amount.phrase).toBe("$156.00 — $54.00 less billed");
    // Fields that did not differ keep their tick.
    expect(r.name.status).toBe("agrees");
  });

  it("an absence is neither a tick nor an amber line", () => {
    const r = fieldReadings(candidate({ od: { dateService: null } }), { ...EOB, serviceDate: null });
    expect(r.date.status).toBe("not_compared");
  });

  it("the claim number is the server's tag, never a string comparison", () => {
    const r = fieldReadings(candidate({ evidence: [] }), EOB);
    expect(r.claimNumber.status).toBe("not_compared");
  });

  it("never ticks a field the agreement sentence would not name", () => {
    // The two must be one rule. Take a candidate where some fields are absent,
    // and check that every ticked field appears in agreement()'s sentence.
    const c = candidate({ od: { billedCents: 21000, dateService: null } });
    const eob = { ...EOB, serviceDate: null };
    const sentence = (agreement(c, eob) ?? "").toLowerCase();
    const r = fieldReadings(c, eob);
    const words: Record<string, string> = {
      claimNumber: "claim number",
      name: "name",
      date: "service date",
      amount: "billed total",
      lines: "every line",
    };
    for (const [field, reading] of Object.entries(r)) {
      if (reading.status === "agrees") expect(sentence).toContain(words[field]);
      else expect(sentence).not.toContain(words[field]);
    }
  });

  it("has no key for date of birth or subscriber — the scorer compares neither", () => {
    expect(Object.keys(fieldReadings(candidate(), EOB)).sort()).toEqual(
      ["amount", "claimNumber", "date", "lines", "name"],
    );
  });
});
