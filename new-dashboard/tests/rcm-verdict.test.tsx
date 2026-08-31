/**
 * The workbench — the verdict, the identity check and the write-off decision.
 *
 * The backend is the source of truth for the arithmetic and for what may be
 * stored (`services/rcm/lineDecisions.test.js`, `routes/rcm/lineDecisions.test.js`).
 * This suite is about what a person is TOLD, and the claims it pins are the ones
 * that would mislead a biller if they broke:
 *
 *  - the verdict SENTENCE is the server's, rendered verbatim — nothing here
 *    re-derives it, re-tenses it, or formats a cent;
 *  - green, amber and red are three visibly different answers, and red says out
 *    loud that the claim cannot be approved;
 *  - a name or a date of birth that disagrees is a WALL, with no "post anyway";
 *  - a subscriber id that disagrees is reported and is NOT a wall;
 *  - "not recorded" and "does not match" never read the same;
 *  - a line the patient owes nothing on has no decision control at all;
 *  - writing a line off cannot be done without picking a reason;
 *  - an approved claim's decisions are frozen, and the screen says why.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Fixtures. Synthetic throughout — the repo's no-real-patient-data rule ───

/**
 * One line of the carrier's adjudication.
 *
 * The two derived figures are written out rather than computed here, because
 * they arrive from the server and a fixture that derived them would be testing a
 * screen the server never feeds.
 */
function line(over: Record<string, unknown> = {}) {
  const billedCents = (over.billedCents as number) ?? 15000;
  const allowedCents = (over.allowedCents as number) ?? 10000;
  const paidCents = (over.paidCents as number) ?? 8000;
  return {
    lineId: "pl-1",
    position: 1,
    billedCode: "D0150",
    paidCode: null,
    code: "D0150",
    description: "Comprehensive oral evaluation",
    billedCents,
    allowedCents,
    deductibleCents: 0,
    copayCents: 0,
    paidCents,
    adjustmentCents: 0,
    patientRespCents: 0,
    writeOffCents: 0,
    adjustmentReason: null,
    isDowncoded: false,
    isBundled: false,
    isDenied: false,
    flags: [] as string[],
    odClaimProcNum: 99001,
    adjustments: [] as unknown[],
    contractualWriteOffCents: billedCents - allowedCents,
    patientRemainderCents: allowedCents - paidCents,
    decision: null,
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}

function identity(over: Record<string, unknown> = {}) {
  return {
    matched: true,
    blocking: false,
    fields: [
      { field: "name", label: "Name", eob: "Fixture, Synthetic", od: "Fixture, Synthetic", status: "agrees", blocking: false },
      { field: "dob", label: "Date of birth", eob: "1990-01-01", od: "1990-01-01", status: "agrees", blocking: false },
      { field: "subscriber", label: "Subscriber ID", eob: "ABC123456", od: "ABC123456", status: "agrees", blocking: false },
    ],
    ...over,
  };
}

function verdict(over: Record<string, unknown> = {}) {
  return {
    state: "green",
    register: "projection",
    eobPatientCents: 2000,
    projectedPatientCents: 2000,
    decidedWriteOffCents: 0,
    contractualWriteOffCents: 5000,
    decisions: [] as unknown[],
    problems: [] as unknown[],
    sentence: "Patient will owe $20.00 once posted — matches the EOB.",
    ...over,
  };
}

function chart(over: Record<string, unknown> = {}) {
  return {
    odClaimNum: 53648,
    claimStatus: "S",
    fetchedAt: "2026-03-03T15:00:00.000Z",
    billedCents: 15000,
    insPaidCents: 0,
    writeOffCents: 0,
    lines: [
      {
        odClaimProcNum: 99001,
        code: "D0150",
        status: "NotReceived",
        feeBilledCents: 15000,
        insEstCents: 8000,
        insPayAmtCents: 0,
        writeOffCents: 0,
      },
    ],
    ...over,
  };
}

function claim(over: Record<string, unknown> = {}) {
  return {
    claimId: "c-1",
    officeId: "roland",
    claimNumber: "53648",
    checkNumber: "830200001",
    patientName: "Fixture, Synthetic",
    patientDob: "1990-01-01",
    subscriberId: "ABC123456",
    odPatientId: 12828,
    odClaimNum: 53648,
    payer: "DELTA DENTAL OF ARKANSAS",
    serviceDate: "2026-03-02",
    receivedDate: "2026-03-02",
    status: "matched",
    paymentStatus: "unpaid",
    insuranceType: "primary",
    totalBilledCents: 15000,
    totalAllowedCents: 10000,
    totalPaidCents: 8000,
    totalDeductibleCents: 0,
    patientBalanceCents: 2000,
    needsReviewReasons: [] as string[],
    extractionConfidence: 95,
    odMatchStatus: "confirmed",
    rejectedCandidates: 0,
    odMatchAt: "2026-03-03T15:00:00.000Z",
    odMatchConfirmedAt: "2026-03-03T15:05:00.000Z",
    odMatchedBy: "Billing User",
    reviewedAt: "2026-03-03T15:10:00.000Z",
    reviewedBy: "Billing User",
    reviewNote: "checked",
    postingQueueId: null,
    approvedAt: null,
    createdAt: "2026-03-02T10:00:00.000Z",
    lines: [line()],
    provenance: null,
    verdict: verdict(),
    identity: identity(),
    chart: chart(),
    matchSnapshot: null,
    matchSnapshotStale: false,
    ...over,
  };
}

const REASONS = [
  { slug: "xrays_bitewings", label: "X-rays — bitewings" },
  { slug: "xrays_panoramic", label: "X-rays — panoramic" },
  { slug: "xrays_other", label: "X-rays — other films/images (OFIs)" },
  { slug: "not_chargeable", label: "Not chargeable for this procedure" },
  { slug: "build_up", label: "Build-up" },
];

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  claim: null as unknown,
  decisions: [] as { lineId: string; decision: string; reason: string | null }[],
  decideError: null as Error | null,
  auth: { status: "loading" } as
    | { status: "loading" }
    | { status: "authenticated"; user: { isSuperAdmin: boolean; permissions: string[] } },
}));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return { ...real, useAuth: () => state.auth };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getClaim: vi.fn(async (office: string) => ({
      office,
      claim: state.claim ?? claim(),
      writeoffReasons: REASONS,
      matchRules: {
        amountNearCents: 100,
        dateNearDays: 7,
        ambiguityMargin: 10,
        bands: [
          { band: "HIGH", min: 75 },
          { band: "MEDIUM", min: 45 },
          { band: "LOW", min: 0 },
        ],
      },
    })),
    /** The check's claim list, for the pager. Silent failure is deliberate. */
    getRemittance: vi.fn(async () => {
      throw new Error("no check in this test");
    }),
    setLineDecision: vi.fn(
      async (_office: string, claimId: string, lineId: string, decision: string, reason: string | null) => {
        if (state.decideError) throw state.decideError;
        state.decisions.push({ lineId, decision, reason });
        return {
          office: "roland",
          claimId,
          lineId,
          decision,
          reason,
          verdict: verdict({ state: "amber", sentence: "…the server's sentence…" }),
          lines: [],
        };
      },
    ),
    matchClaim: vi.fn(async () => new Promise(() => {})),
    confirmClaimMatch: vi.fn(async () => new Promise(() => {})),
    reviewClaim: vi.fn(async () => new Promise(() => {})),
  };
});

import ClaimMatch from "@/pages/rcm/ClaimMatch";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderClaim() {
  const memory = memoryLocation({ path: "/rcm/claims/c-1", record: true });
  render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>
            <ClaimMatch />
          </OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

beforeEach(() => {
  localStorage.clear();
  state.claim = null;
  state.decisions = [];
  state.decideError = null;
  state.auth = { status: "loading" };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── The verdict line ────────────────────────────────────────────────────────

describe("the patient-responsibility verdict", () => {
  it("GREEN — renders the server's sentence VERBATIM and the three figures behind it", async () => {
    renderClaim();
    const verdictLine = await screen.findByTestId("verdict-line");
    expect(verdictLine.getAttribute("data-verdict")).toBe("green");
    // The sentence is the SERVER's. A client that wrote its own would be a
    // client that can say `$54.8` where the server means `$54.08`.
    expect(screen.getByTestId("verdict-sentence").textContent).toBe(
      "Patient will owe $20.00 once posted — matches the EOB.",
    );
    const figures = screen.getByTestId("verdict-figures").textContent ?? "";
    expect(figures).toContain("EOB says the patient owes");
    expect(figures).toContain("$20.00");
    expect(figures).toContain("Office is absorbing");
    expect(screen.queryByTestId("verdict-cannot-approve")).toBeNull();
  });

  it("AMBER — lists what was decided: the line, the amount, the reason and who", async () => {
    state.claim = claim({
      verdict: verdict({
        state: "amber",
        eobPatientCents: 5000,
        projectedPatientCents: 2000,
        decidedWriteOffCents: 3000,
        decisions: [
          {
            lineId: "pl-2",
            code: "D0274",
            amountCents: 3000,
            reason: "xrays_bitewings",
            reasonLabel: "X-rays — bitewings",
            decidedBy: "Billing User",
            decidedAt: "2026-03-03T16:00:00.000Z",
          },
        ],
        sentence: "Patient will owe $20.00 — $30.00 below the EOB because you wrote off D0274.",
      }),
    });
    renderClaim();
    const verdictLine = await screen.findByTestId("verdict-line");
    expect(verdictLine.getAttribute("data-verdict")).toBe("amber");

    const decisions = screen.getByTestId("verdict-decisions").textContent ?? "";
    expect(decisions).toContain("D0274");
    expect(decisions).toContain("$30.00");
    expect(decisions).toContain("X-rays — bitewings");
    // "Deliberate" is only true if somebody can read WHO decided it, months
    // later, without opening a second screen.
    expect(decisions).toContain("Billing User");
    // Amber is not a refusal.
    expect(screen.queryByTestId("verdict-cannot-approve")).toBeNull();
  });

  it("RED — names the lines, and says out loud that this cannot be approved", async () => {
    state.claim = claim({
      verdict: verdict({
        state: "red",
        eobPatientCents: 5000,
        projectedPatientCents: 2000,
        problems: [
          {
            kind: "od_fee_disagrees",
            code: "D0274",
            lineId: "pl-2",
            detail:
              "D0274 was billed $60.00 on the remittance and $50.00 in Open Dental",
          },
        ],
        sentence:
          "Patient's number can't be trusted yet — something on this claim does not line up with Open Dental. Look at D0274.",
      }),
    });
    renderClaim();
    const verdictLine = await screen.findByTestId("verdict-line");
    expect(verdictLine.getAttribute("data-verdict")).toBe("red");
    expect(screen.getByTestId("verdict-problems").textContent).toContain(
      "D0274 was billed $60.00 on the remittance and $50.00 in Open Dental",
    );
    expect(screen.getByTestId("verdict-cannot-approve").textContent).toContain(
      "cannot be approved",
    );
  });

  it("says nothing it cannot know when the claim is not matched yet", async () => {
    state.claim = claim({ odMatchStatus: "not_run", odClaimNum: null, verdict: undefined, chart: null });
    renderClaim();
    const unknown = await screen.findByTestId("verdict-unknown");
    expect(unknown.textContent).toContain("cannot be worked out until this claim is matched");
    expect(screen.queryByTestId("verdict-line")).toBeNull();
  });

  it("NEVER words a projection as a confirmation", async () => {
    renderClaim();
    const sentence = (await screen.findByTestId("verdict-sentence")).textContent ?? "";
    expect(sentence).toContain("once posted");
    expect(sentence.toLowerCase()).not.toContain("confirmed in open dental");
  });
});

// ─── Identity ────────────────────────────────────────────────────────────────

describe("is this the patient on the EOB", () => {
  it("renders all three facts side by side when they agree", async () => {
    renderClaim();
    const panel = await screen.findByTestId("identity-panel");
    expect(panel.getAttribute("data-identity")).toBe("agrees");
    expect(panel.textContent).toContain("This is the patient on the EOB");
    for (const f of ["name", "dob", "subscriber"]) {
      expect(screen.getByTestId(`identity-${f}`).getAttribute("data-status")).toBe("agrees");
    }
  });

  it("a DATE OF BIRTH mismatch is a WALL, and there is no way past it", async () => {
    state.claim = claim({
      identity: identity({
        matched: false,
        blocking: true,
        fields: [
          { field: "name", label: "Name", eob: "Fixture, Synthetic", od: "Fixture, Synthetic", status: "agrees", blocking: false },
          { field: "dob", label: "Date of birth", eob: "1990-01-01", od: "1991-01-01", status: "differs", blocking: true },
          { field: "subscriber", label: "Subscriber ID", eob: "ABC123456", od: "ABC123456", status: "agrees", blocking: false },
        ],
      }),
    });
    renderClaim();
    const panel = await screen.findByTestId("identity-panel");
    expect(panel.getAttribute("data-identity")).toBe("blocking");
    expect(panel.textContent).toContain("This may not be the same person");
    // BOTH values are shown — a refusal that will not say what disagreed is a
    // refusal nobody can act on.
    const row = screen.getByTestId("identity-dob").textContent ?? "";
    expect(row).toContain("1990-01-01");
    expect(row).toContain("1991-01-01");
    expect(row).toContain("does not match");
    // The remedy is to match it up again. There is no override, and the copy
    // says so rather than leaving somebody looking for one.
    expect(panel.textContent).toContain("there is no way to say");
  });

  it("a NAME mismatch blocks too", async () => {
    state.claim = claim({
      identity: identity({
        matched: false,
        blocking: true,
        fields: [
          { field: "name", label: "Name", eob: "Fixture, Synthetic", od: "Other, Person", status: "differs", blocking: true },
          { field: "dob", label: "Date of birth", eob: "1990-01-01", od: "1990-01-01", status: "agrees", blocking: false },
          { field: "subscriber", label: "Subscriber ID", eob: "ABC123456", od: "ABC123456", status: "agrees", blocking: false },
        ],
      }),
    });
    renderClaim();
    expect((await screen.findByTestId("identity-panel")).getAttribute("data-identity")).toBe(
      "blocking",
    );
  });

  it("a SUBSCRIBER ID mismatch is reported and is NOT a wall", async () => {
    state.claim = claim({
      identity: identity({
        matched: false,
        blocking: false,
        fields: [
          { field: "name", label: "Name", eob: "Fixture, Synthetic", od: "Fixture, Synthetic", status: "agrees", blocking: false },
          { field: "dob", label: "Date of birth", eob: "1990-01-01", od: "1990-01-01", status: "agrees", blocking: false },
          { field: "subscriber", label: "Subscriber ID", eob: "ABC123456", od: "ZZZ999", status: "differs", blocking: false },
        ],
      }),
    });
    renderClaim();
    const panel = await screen.findByTestId("identity-panel");
    expect(panel.getAttribute("data-identity")).toBe("partial");
    expect(panel.textContent).not.toContain("This may not be the same person");
    // …but it is not hidden either, and it reads differently from a real wall.
    expect(screen.getByTestId("identity-subscriber").textContent).toContain("different format");
  });

  it('"not recorded" and "does not match" never read the same', async () => {
    state.claim = claim({
      identity: identity({
        fields: [
          { field: "name", label: "Name", eob: "Fixture, Synthetic", od: "Fixture, Synthetic", status: "agrees", blocking: false },
          { field: "dob", label: "Date of birth", eob: "1990-01-01", od: null, status: "unknown", blocking: false },
          { field: "subscriber", label: "Subscriber ID", eob: "ABC123456", od: null, status: "unknown", blocking: false },
        ],
      }),
    });
    renderClaim();
    const dob = await screen.findByTestId("identity-dob");
    expect(dob.textContent).toContain("not recorded");
    expect(dob.textContent).not.toContain("does not match");
    // An absence refuses nothing.
    expect(screen.getByTestId("identity-panel").getAttribute("data-identity")).toBe("agrees");
  });
});

// ─── The decision control ────────────────────────────────────────────────────

describe("the per-line write-off decision", () => {
  it("a line the patient owes nothing on has no control at all", async () => {
    state.claim = claim({
      lines: [line({ lineId: "pl-1", billedCents: 15000, allowedCents: 10000, paidCents: 10000 })],
    });
    renderClaim();
    // Not rendered DISABLED — a disabled control invites somebody to look for a
    // way to enable it.
    expect(await screen.findByTestId("decision-none-pl-1")).toBeTruthy();
    expect(screen.queryByTestId("decision-pl-1")).toBeNull();
  });

  it("shows the contractual write-off as the CARRIER'S, with no control beside it", async () => {
    renderClaim();
    const fact = await screen.findByTestId("contractual-pl-1");
    expect(fact.textContent).toContain("Contract write-off $50.00");
    expect(fact.textContent).toContain("the carrier's, already accepted");
  });

  it("billing the patient names the amount, and is the state a fresh line is in", async () => {
    renderClaim();
    const bill = await screen.findByTestId("bill-patient-pl-1");
    expect(bill.textContent).toContain("Bill the patient $20.00");
    // `null` means nobody has said, and the money reads that as bill_patient.
    expect(bill.getAttribute("aria-pressed")).toBe("true");
  });

  it("WRITING OFF CANNOT BE DONE WITHOUT A REASON — the button opens the list", async () => {
    renderClaim();
    fireEvent.click(await screen.findByTestId("write-off-pl-1"));

    // Nothing was recorded by pressing "Write it off" on its own.
    expect(state.decisions).toEqual([]);

    const reasons = screen.getByTestId("reasons-pl-1");
    expect(reasons.textContent).toContain("A reason is required");
    for (const r of REASONS) {
      expect(screen.getByTestId(`reason-${r.slug}-pl-1`).textContent).toBe(r.label);
    }

    // Picking one IS the commit — a write-off with no reason is a state the
    // server refuses to store, so it is never a state this screen can produce.
    fireEvent.click(screen.getByTestId("reason-xrays_bitewings-pl-1"));
    await waitFor(() => expect(state.decisions.length).toBe(1));
    expect(state.decisions[0]).toEqual({
      lineId: "pl-1",
      decision: "office_writeoff",
      reason: "xrays_bitewings",
    });
  });

  it("billing the patient sends NO reason", async () => {
    state.claim = claim({
      lines: [line({ decision: "office_writeoff", decisionReason: "build_up", decidedBy: "Billing User" })],
    });
    renderClaim();
    fireEvent.click(await screen.findByTestId("bill-patient-pl-1"));
    await waitFor(() => expect(state.decisions.length).toBe(1));
    expect(state.decisions[0]).toEqual({ lineId: "pl-1", decision: "bill_patient", reason: null });
  });

  it("renders the five reasons the SERVER sent, not a list of its own", async () => {
    renderClaim();
    fireEvent.click(await screen.findByTestId("write-off-pl-1"));
    const buttons = screen.getByTestId("reasons-pl-1").querySelectorAll("button");
    expect(buttons.length).toBe(REASONS.length);
  });

  it("a decided line says what was decided, by whom, at the line", async () => {
    state.claim = claim({
      lines: [
        line({
          decision: "office_writeoff",
          decisionReason: "xrays_panoramic",
          decidedBy: "Billing User",
          decidedAt: "2026-03-03T16:00:00.000Z",
        }),
      ],
    });
    renderClaim();
    const stamp = await screen.findByTestId("decision-stamp-pl-1");
    // The person checking a line six weeks from now is looking AT THE LINE.
    expect(stamp.textContent).toContain("The office is absorbing $20.00");
    expect(stamp.textContent).toContain("X-rays — panoramic");
    expect(stamp.textContent).toContain("Billing User");
  });

  it("an APPROVED claim is frozen, and every control says why", async () => {
    state.auth = {
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.read", "rcm.queue", "rcm.write"] },
    };
    state.claim = claim({ postingQueueId: "q-1", approvedAt: "2026-03-03T17:00:00.000Z" });
    renderClaim();
    const bill = (await screen.findByTestId("bill-patient-pl-1")) as HTMLButtonElement;
    expect(bill.disabled).toBe(true);
    expect((screen.getByTestId("write-off-pl-1") as HTMLButtonElement).disabled).toBe(true);
    // A disabled control with no visible reason reads as a broken one (§15.2,
    // finding 4) — and there is no hover on a tablet. The sentence names what
    // actually happened and NOT permission: this approver holds every
    // permission there is, and sending her to ask for access she already has
    // would be the most confusing thing this screen could say.
    const why = screen.getByTestId("decision-reason-pl-1").textContent ?? "";
    expect(why).toContain("has been approved");
    expect(why).toContain("Fix a wrong write-off in Open Dental");
    expect(why).not.toContain("permission");
  });

  it("a tier that cannot decide is told so, rather than shown a dead button", async () => {
    state.auth = {
      status: "authenticated",
      user: { isSuperAdmin: false, permissions: ["rcm.read"] },
    };
    renderClaim();
    const bill = (await screen.findByTestId("bill-patient-pl-1")) as HTMLButtonElement;
    expect(bill.disabled).toBe(true);
    expect(screen.getByTestId("decision-reason-pl-1")).toBeTruthy();
  });
});

// ─── What the chart holds ────────────────────────────────────────────────────

describe("what Open Dental has", () => {
  it("labels the figures as a READING, not as the present", async () => {
    renderClaim();
    const panel = await screen.findByTestId("chart-panel");
    expect(panel.textContent).toContain("Read from Open Dental");
    expect(panel.textContent).toContain("re-checked again before anything is written");
  });

  it("an insurance estimate Open Dental has not calculated is NEVER printed as $0.00", async () => {
    state.claim = claim({
      chart: chart({
        lines: [
          {
            odClaimProcNum: 99001,
            code: "D0150",
            status: "NotReceived",
            feeBilledCents: 15000,
            insEstCents: null,
            insPayAmtCents: 0,
            writeOffCents: 0,
          },
        ],
      }),
    });
    renderClaim();
    const row = await screen.findByTestId("chart-line-99001");
    expect(row.textContent).toContain("not calculated");
  });

  it("the ledger slot is LABELLED as missing rather than mocked up", async () => {
    renderClaim();
    const slot = await screen.findByTestId("ledger-slot");
    expect(slot.textContent).toContain("not shown here yet");
    expect(slot.textContent).toContain("Open Dental");
  });
});

it("a GREEN verdict over a blocking identity admits that nothing will post", async () => {
  /*
   * Two questions with two answers: the verdict is about the NUMBER, identity is
   * about WHO. The arithmetic can be perfect on the wrong person's chart — but
   * "Patient will owe $480.00 once posted" printed over a panel saying nothing
   * can post is a projection stated with more confidence than it has earned, and
   * the trust anchor is the one line here that must never do that.
   */
  state.claim = claim({
    identity: identity({
      matched: false,
      blocking: true,
      fields: [
        { field: "name", label: "Name", eob: "Fixture, Synthetic", od: "Fixture, Synthetic", status: "agrees", blocking: false },
        { field: "dob", label: "Date of birth", eob: "1990-01-01", od: "1991-01-01", status: "differs", blocking: true },
        { field: "subscriber", label: "Subscriber ID", eob: "ABC123456", od: null, status: "unknown", blocking: false },
      ],
    }),
  });
  renderClaim();
  const caveat = await screen.findByTestId("verdict-identity-caveat");
  expect(caveat.textContent).toContain("nothing will post");
  // The verdict itself is unchanged — the numbers really do agree.
  expect(screen.getByTestId("verdict-line").getAttribute("data-verdict")).toBe("green");
});

it("an ordinary green verdict carries no caveat", async () => {
  renderClaim();
  await screen.findByTestId("verdict-line");
  expect(screen.queryByTestId("verdict-identity-caveat")).toBeNull();
});

// ─── B2: the confirmed register on the screen ────────────────────────────────

describe("after it has posted, the verdict stops forecasting", () => {
  it("says what Open Dental HOLDS, and stamps when that was read", async () => {
    state.claim = claim({
      postingQueueId: "q-1",
      approvedAt: "2026-03-03T17:00:00.000Z",
      confirmedAt: "2026-03-03T18:30:00.000Z",
      verdict: verdict({
        state: "amber",
        register: "confirmed",
        eobPatientCents: 5000,
        projectedPatientCents: 2000,
        decidedWriteOffCents: 3000,
        decisions: [
          {
            lineId: "pl-2",
            code: "D0274",
            amountCents: 3000,
            reason: "xrays_bitewings",
            reasonLabel: "X-rays — bitewings",
            decidedBy: "Billing User",
            decidedAt: "2026-03-03T16:00:00.000Z",
          },
        ],
        sentence:
          "Patient owes $20.00 — $30.00 below the EOB because you wrote off D0274. " +
          "Confirmed in Open Dental.",
      }),
    });
    renderClaim();

    // The server's sentence, verbatim, in the tense the server chose.
    const sentence = (await screen.findByTestId("verdict-sentence")).textContent ?? "";
    expect(sentence).toContain("Confirmed in Open Dental");
    expect(sentence).not.toContain("will owe");

    // …and the figure beside it stops being a forecast too. A label reading
    // "Patient will be billed" over money already in the chart is the same lie
    // one word smaller.
    const figures = screen.getByTestId("verdict-figures").textContent ?? "";
    expect(figures).toContain("Open Dental says the patient owes");
    expect(figures).not.toContain("Patient will be billed");
    /*
     * And the left-hand figure is the PROMISE, not the EOB's raw total. With
     * the raw total there the strip printed the same number twice under a
     * banner naming a third — the shot caught it. $50.00 owed on the EOB less
     * the $30.00 the office absorbed is the $20.00 this check said.
     */
    expect(figures).toContain("This check said the patient would owe");
    expect(figures).toContain("$20.00");
    expect(figures).not.toContain("EOB says the patient owes");

    expect(screen.getByTestId("verdict-confirmed-at").textContent).toMatch(/As Open Dental had it/);
  });

  it("a RED confirmation says the money already moved — not that it cannot be approved", async () => {
    state.claim = claim({
      postingQueueId: "q-1",
      approvedAt: "2026-03-03T17:00:00.000Z",
      confirmedAt: "2026-03-03T18:30:00.000Z",
      verdict: verdict({
        state: "red",
        register: "confirmed",
        eobPatientCents: 2000,
        projectedPatientCents: 2000,
        decidedWriteOffCents: 2000,
        problems: [
          {
            kind: "chart_differs_from_decision",
            code: "D0120",
            lineId: "pl-1",
            detail: "D0120 was posted to leave the patient $0.00 and Open Dental says $20.00",
          },
        ],
        sentence:
          "Open Dental says the patient owes $20.00 — this check said $0.00. " +
          "This needs you before anything else posts. Look at D0120.",
      }),
    });
    renderClaim();

    const why = (await screen.findByTestId("verdict-cannot-approve")).textContent ?? "";
    // Approving is behind her. What she needs to know is that money is in the
    // chart and the rest of the check is waiting on her.
    expect(why).toContain("already in the chart");
    expect(why).not.toContain("cannot be approved");
    expect(screen.getByTestId("verdict-problems").textContent).toContain("Open Dental says $20.00");
  });

  it("a claim that has NOT posted still says 'will owe', with no stamp", async () => {
    renderClaim();
    const sentence = (await screen.findByTestId("verdict-sentence")).textContent ?? "";
    expect(sentence).toContain("will owe");
    expect(screen.queryByTestId("verdict-confirmed-at")).toBeNull();
    expect((screen.getByTestId("verdict-figures").textContent ?? "")).toContain(
      "Patient will be billed",
    );
  });
});
