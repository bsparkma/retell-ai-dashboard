/**
 * ADD A LINE THE SCAN MISSED, and strike one it invented.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE FEATURE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * A read that misses a procedure line leaves a claim whose lines do not sum to
 * its total, and the gate refuses it. That refusal is one a biller can do nothing
 * about: every figure on screen is right, and the missing one is not on screen to
 * correct. Typing it in is how an incomplete read becomes able to reconcile.
 *
 * SO THE THING THIS FILE PINS IS THAT IT IS NOT A BYPASS. The added line counts
 * in the claim's sum exactly like one the reader found, and the sum is what goes
 * from "does not add up" to "adds up". Nothing here relaxes an arithmetic.
 *
 * And the mirror case: a line the read invented is struck, with a reason, and
 * nothing is deleted.
 *
 * TYPING A MONEY FIGURE HERE IS TRANSCRIPTION, NOT A DECISION — the same owner
 * ruling as a correction, scoped to this screen alone.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, code and dollar figure
 * below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

const BATCH = "8acb0e32-35ae-5cd8-9692-7b5e318a31c2";
const CLAIM = "d1e2b359-a8d7-51a8-978c-7adf27bccc8d";
const LINE = "a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90";
const ADDED = "c7d41f08-2e5b-4a9c-b108-6f3a2d9e4b71";
const UPLOAD = "f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31";

type Json = Record<string, unknown>;

const S = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  /** What the fake server reports after the next add or strike. */
  nextState: null as Record<string, unknown> | null,
  added: [] as Array<{ claimId: string; line: Json }>,
  strikes: [] as Json[],
  error: null as Error | null,
}));

vi.mock("@/contexts/OfficeContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/OfficeContext")>();
  return {
    ...real,
    OfficeProvider: ({ children }: { children: React.ReactNode }) => children,
    useOffice: () => ({
      office: "roland",
      offices: [],
      loading: false,
      error: null,
      setOffice: () => {},
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getFieldConfirm: vi.fn(async () => {
      if (!S.state) throw new Error("no such check");
      return S.state;
    }),
    getRemittance: vi.fn(async () => {
      throw new Error("not under test here");
    }),
    confirmFields: vi.fn(async () => ({
      office: "roland",
      batchId: BATCH,
      state: S.state,
      confirmed: [],
    })),
    addConfirmLine: vi.fn(async (_o: string, _b: string, claimId: string, line: Json) => {
      S.added.push({ claimId, line });
      if (S.error) throw S.error;
      return { addedLineId: ADDED, state: S.nextState ?? S.state };
    }),
    strikeConfirmLine: vi.fn(async (_o: string, _b: string, body: Json) => {
      S.strikes.push(body);
      if (S.error) throw S.error;
      return { struck: body.struck !== false, state: S.nextState ?? S.state };
    }),
  };
});

import FieldConfirm from "@/pages/rcm/FieldConfirm";

function f(field: string, cents: number | null, over: Json = {}): Json {
  return {
    field,
    cents,
    stated: cents !== null,
    source: "extracted",
    confirmed: false,
    extractedCents: cents,
    confirmedBy: null,
    confirmedAt: null,
    ...over,
  };
}

/** A figure a person typed in: confirmed by the act, with no extraction behind it. */
function typed(field: string, cents: number | null): Json {
  return {
    field,
    cents,
    stated: cents !== null,
    source: "added",
    confirmed: true,
    extractedCents: null,
    confirmedBy: "A Biller",
    confirmedAt: "2026-09-30T20:00:00.000Z",
  };
}

function readLine(over: Json = {}): Json {
  return {
    lineId: LINE,
    kind: "extracted",
    position: 0,
    code: "D2750",
    description: "Crown - porcelain/ceramic",
    region: null,
    struck: null,
    fields: [
      f("line_paid", 15300, { confirmed: true, source: "confirmed" }),
      f("line_billed", 131500),
      f("line_allowed", 122900),
      f("line_deductible", 0),
      f("line_copay", 0),
    ],
    ...over,
  };
}

function addedLine(over: Json = {}): Json {
  return {
    lineId: ADDED,
    kind: "added",
    position: 1,
    code: "D0220",
    description: "Intraoral periapical first film",
    region: null,
    struck: null,
    fields: [
      typed("line_paid", 3100),
      typed("line_billed", 4200),
      typed("line_allowed", 3100),
      typed("line_deductible", 0),
      typed("line_copay", 0),
    ],
    ...over,
  };
}

/** A claim whose lines come to $153.00 against a claim total of $184.00. */
function shortByThirtyOne(over: Json = {}): Json {
  return {
    office: "roland",
    batchId: BATCH,
    payer: "MERIDIAN MUTUAL DENTAL",
    checkNumber: "SYN-000123",
    depositDate: "2026-09-15",
    checkTotal: f("check_total", 18400, { confirmed: true, source: "confirmed" }),
    required: true,
    provenance: { uploadId: UPLOAD, textSource: "ocr", ocrPageCount: 1, ocrMeanConfidence: 0.99 },
    claims: [
      {
        claimId: CLAIM,
        patientName: "Synthetic, Patient A",
        claimNumber: "SYNCLM0001",
        serviceDate: "2026-09-15",
        totalPaid: f("claim_total_paid", 18400, { confirmed: true, source: "confirmed" }),
        lineSum: {
          lineCount: 1,
          comparable: true,
          lineSumCents: 15300,
          claimTotalCents: 18400,
          differenceCents: -3100,
          unstatedCount: 0,
          unconfirmedUnstatedCount: 0,
          ok: false,
        },
        lines: [readLine()],
      },
    ],
    outstanding: { ok: false, outstanding: 4, first: null },
    sums: {
      ok: true,
      comparable: true,
      checkTotalCents: 18400,
      claimsTotalCents: 18400,
      differenceCents: 0,
    },
    checkImage: null,
    ...over,
  };
}

/** The same claim once the missing x-ray line has been typed in. */
function reconciled(): Json {
  const state = shortByThirtyOne();
  const claim = (state.claims as Json[])[0];
  claim.lines = [readLine(), addedLine()];
  claim.lineSum = {
    lineCount: 2,
    comparable: true,
    lineSumCents: 18400,
    claimTotalCents: 18400,
    differenceCents: 0,
    unstatedCount: 0,
    unconfirmedUnstatedCount: 0,
    ok: true,
  };
  return state;
}

function renderConfirm() {
  const memory = memoryLocation({ path: `/rcm/remittances/${BATCH}/confirm`, record: true });
  return render(
    <WouterRouter hook={memory.hook}>
      <FieldConfirm />
    </WouterRouter>,
  );
}

/** Open the add form and fill in the x-ray line. */
async function fillAddForm(figures: Record<string, string> = {}) {
  fireEvent.click(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`));
  await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-form-${CLAIM}`)).toBeTruthy());
  fireEvent.change(screen.getByTestId(`rcm-confirm-add-code-${CLAIM}`), {
    target: { value: figures.code ?? "D0220" },
  });
  for (const [field, value] of Object.entries({
    line_billed: "42.00",
    line_allowed: "31.00",
    line_deductible: "0",
    line_copay: "0",
    line_paid: "31.00",
    ...figures,
  })) {
    if (field === "code") continue;
    fireEvent.change(screen.getByTestId(`rcm-confirm-add-${field}-${CLAIM}`), {
      target: { value },
    });
  }
}

beforeEach(() => {
  S.state = shortByThirtyOne();
  S.nextState = null;
  S.added = [];
  S.strikes = [];
  S.error = null;
});
afterEach(() => cleanup());

// ─── The gap, named, with the control beside it ───────────────────────────────

describe("the claim says it does not add up, and says which way", () => {
  it("names the difference, and that a line may be missing", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-linesum-off")).toBeTruthy());
    const text = screen.getByTestId("rcm-confirm-linesum-off").textContent ?? "";
    expect(text).toContain("$153.00");
    expect(text).toContain("$184.00");
    expect(text).toContain("$31.00 apart");
    expect(text).toContain("A line may be missing");
  });

  it("says a figure may be wrong when the lines come to MORE than the claim", async () => {
    const state = shortByThirtyOne();
    (state.claims as Json[])[0].lineSum = {
      lineCount: 1,
      comparable: true,
      lineSumCents: 21500,
      claimTotalCents: 18400,
      differenceCents: 3100,
      unstatedCount: 0,
      unconfirmedUnstatedCount: 0,
      ok: false,
    };
    S.state = state;
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-linesum-off")).toBeTruthy());
    expect(screen.getByTestId("rcm-confirm-linesum-off").textContent).toContain(
      "A figure may be wrong",
    );
  });

  it("offers the add control on EVERY claim, under its lines", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`)).toBeTruthy());
    expect(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`).textContent).toContain(
      "Add a line from the page",
    );
  });
});

// ─── Typing the line in ───────────────────────────────────────────────────────

describe("adding a line from the page", () => {
  it("sends the code and every figure, in cents", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`)).toBeTruthy());
    await fillAddForm();
    fireEvent.click(screen.getByTestId(`rcm-confirm-add-save-${CLAIM}`));

    await waitFor(() => expect(S.added.length).toBe(1));
    expect(S.added[0].claimId).toBe(CLAIM);
    expect(S.added[0].line).toEqual({
      code: "D0220",
      description: null,
      billedCents: 4200,
      allowedCents: 3100,
      deductibleCents: 0,
      copayCents: 0,
      paidCents: 3100,
    });
  });

  it("sends a BLANK box as null, which is the page not stating that figure", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`)).toBeTruthy());
    await fillAddForm({ line_allowed: "" });
    fireEvent.click(screen.getByTestId(`rcm-confirm-add-save-${CLAIM}`));

    await waitFor(() => expect(S.added.length).toBe(1));
    /*
     * null, and the KEY IS PRESENT. A missing key would have the server record
     * "the page says nothing" about a figure nobody looked at; a zero would assert
     * the plan allowed nothing, which is a claim about a patient's balance.
     */
    expect(S.added[0].line.allowedCents).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(S.added[0].line, "allowedCents")).toBe(true);
  });

  it("will not send until there is a code, and says so in words", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`)).toBeTruthy());
    await fillAddForm({ code: "" });

    const save = screen.getByTestId(`rcm-confirm-add-save-${CLAIM}`) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // NO REASON-LESS GREYED BUTTON. The row says what is missing.
    expect(screen.getByTestId(`rcm-confirm-add-blocked-${CLAIM}`).textContent).toContain(
      "procedure code",
    );
  });

  it("will not send a box that is not an amount, and does not treat it as blank", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`)).toBeTruthy());
    await fillAddForm({ line_paid: "31.0o" });

    const save = screen.getByTestId(`rcm-confirm-add-save-${CLAIM}`) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId(`rcm-confirm-add-blocked-${CLAIM}`).textContent).toContain(
      "not an amount",
    );
    fireEvent.click(save);
    await new Promise((r) => setTimeout(r, 0));
    expect(S.added.length).toBe(0);
  });

  it("THE GATE GOES FROM DOES-NOT-ADD-UP TO RECONCILED, in place", async () => {
    S.nextState = reconciled();
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-linesum-off")).toBeTruthy());

    const frameBefore = screen.getByTestId("rcm-confirm-document-frame");
    await fillAddForm();
    fireEvent.click(screen.getByTestId(`rcm-confirm-add-save-${CLAIM}`));

    await waitFor(() => expect(screen.getByTestId("rcm-confirm-linesum-ok")).toBeTruthy());
    expect(screen.getByTestId("rcm-confirm-linesum-ok").textContent).toContain("The lines add up");
    expect(screen.queryByTestId("rcm-confirm-linesum-off")).toBeNull();

    // In place: the viewer never came down, and the form closed itself.
    expect(screen.getByTestId("rcm-confirm-document-frame")).toBe(frameBefore);
    expect(screen.queryByTestId(`rcm-confirm-add-form-${CLAIM}`)).toBeNull();
  });

  it("renders the added line with a human-added mark and its trail", async () => {
    S.state = reconciled();
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-line-${ADDED}`)).toBeTruthy());

    const row = screen.getByTestId(`rcm-confirm-line-${ADDED}`);
    expect(row.dataset.kind).toBe("added");
    expect(screen.getByTestId(`rcm-confirm-added-mark-${ADDED}`).textContent).toContain(
      "Typed from the page",
    );

    /*
     * THE TRAIL SAYS ADDED, NOT CORRECTED. A correction is a person disagreeing
     * with the machine about a figure; this is a person supplying one the machine
     * never offered, and "the scan read …" would be a sentence about a misread
     * that did not happen.
     */
    const trail = screen.getByTestId(`rcm-confirm-by-${CLAIM}|${ADDED}|line_paid`).textContent ?? "";
    expect(trail).toContain("added by A Biller from the page image");
    expect(trail).not.toContain("corrected");
  });

  it("asks for no confirmation of an added line — she typed it off the page", async () => {
    S.state = reconciled();
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-line-${ADDED}`)).toBeTruthy());
    expect(screen.queryByTestId(`rcm-confirm-line-all-${ADDED}`)).toBeNull();
    expect(screen.queryByTestId(`rcm-confirm-yes-${CLAIM}|${ADDED}|line_paid`)).toBeNull();
  });

  it("reports a refusal at the form, and keeps what she typed", async () => {
    S.error = new Error("A line needs the procedure code printed beside it.");
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`)).toBeTruthy());
    await fillAddForm();
    fireEvent.click(screen.getByTestId(`rcm-confirm-add-save-${CLAIM}`));

    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-add-error-${CLAIM}`)).toBeTruthy());
    expect(
      (screen.getByTestId(`rcm-confirm-add-code-${CLAIM}`) as HTMLInputElement).value,
    ).toBe("D0220");
  });
});

// ─── Striking a line the read invented ───────────────────────────────────────

describe("a line the scan invented", () => {
  it("demands a reason before it can be struck", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-strike-open-${LINE}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rcm-confirm-strike-open-${LINE}`));

    const save = screen.getByTestId(`rcm-confirm-strike-save-${LINE}`) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId(`rcm-confirm-strike-blocked-${LINE}`).textContent).toContain(
      "what it actually is",
    );
  });

  it("sends the reason, and names the line as one the scan read", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-strike-open-${LINE}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rcm-confirm-strike-open-${LINE}`));
    fireEvent.change(screen.getByTestId(`rcm-confirm-strike-reason-${LINE}`), {
      target: { value: "A benefit subtotal row, not a procedure." },
    });
    fireEvent.click(screen.getByTestId(`rcm-confirm-strike-save-${LINE}`));

    await waitFor(() => expect(S.strikes.length).toBe(1));
    expect(S.strikes[0]).toEqual({
      claimId: CLAIM,
      lineId: LINE,
      reason: "A benefit subtotal row, not a procedure.",
    });
  });

  it("names an ADDED line by its own id, so the two id spaces never cross", async () => {
    S.state = reconciled();
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-strike-open-${ADDED}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rcm-confirm-strike-open-${ADDED}`));
    fireEvent.change(screen.getByTestId(`rcm-confirm-strike-reason-${ADDED}`), {
      target: { value: "Typed the wrong code." },
    });
    fireEvent.click(screen.getByTestId(`rcm-confirm-strike-save-${ADDED}`));

    await waitFor(() => expect(S.strikes.length).toBe(1));
    expect(S.strikes[0]).toEqual({
      claimId: CLAIM,
      addedLineId: ADDED,
      reason: "Typed the wrong code.",
    });
    expect(S.strikes[0].lineId).toBeUndefined();
  });

  it("shows a struck line struck, with who struck it and why, and offers it back", async () => {
    const state = shortByThirtyOne();
    (state.claims as Json[])[0].lines = [
      readLine({
        struck: {
          reason: "A benefit subtotal row, not a procedure.",
          struckBy: "A Biller",
          struckAt: "2026-09-30T20:05:00.000Z",
        },
      }),
    ];
    S.state = state;
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-line-${LINE}`)).toBeTruthy());

    expect(screen.getByTestId(`rcm-confirm-line-${LINE}`).dataset.struck).toBe("true");
    const by = screen.getByTestId(`rcm-confirm-struck-by-${LINE}`).textContent ?? "";
    expect(by).toContain("struck by A Biller");
    expect(by).toContain("subtotal row");

    /*
     * AND IT CAN BE PUT BACK. Striking a real line takes its money out of the sum,
     * so a mis-strike would otherwise leave a check that can never reconcile and a
     * biller with nothing to press.
     */
    fireEvent.click(screen.getByTestId(`rcm-confirm-unstrike-${LINE}`));
    await waitFor(() => expect(S.strikes.length).toBe(1));
    expect(S.strikes[0]).toEqual({ claimId: CLAIM, lineId: LINE, struck: false });
  });

  it("stops offering to confirm the figures on a struck line", async () => {
    const state = shortByThirtyOne();
    (state.claims as Json[])[0].lines = [
      readLine({ struck: { reason: "Not a procedure.", struckBy: "A Biller", struckAt: null } }),
    ];
    S.state = state;
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-line-${LINE}`)).toBeTruthy());

    // She has said it is not on the page. Offering to check its figures against
    // that page would be asking her a question she has just withdrawn.
    expect(screen.queryByTestId(`rcm-confirm-line-all-${LINE}`)).toBeNull();
  });

  it("says nothing can be added up when every line is struck", async () => {
    const state = shortByThirtyOne();
    const claim = (state.claims as Json[])[0];
    claim.lines = [readLine({ struck: { reason: "Not a procedure.", struckBy: "A Biller", struckAt: null } })];
    claim.lineSum = {
      lineCount: 0,
      comparable: false,
      lineSumCents: null,
      claimTotalCents: 18400,
      differenceCents: null,
      unstatedCount: 0,
      unconfirmedUnstatedCount: 0,
      ok: false,
    };
    S.state = state;
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-linesum-off")).toBeTruthy());
    expect(screen.getByTestId("rcm-confirm-linesum-off").textContent).toContain(
      "Every line struck",
    );
  });
});
