/**
 * Screenshot DUMPS for this slice — the in-place save, and the line the scan
 * missed.
 *
 * Same shape and reasons as the other `*-shots.test.tsx` files: renders the
 * screen into jsdom with fixture data that lives here and writes the markup to
 * `tests/.shots/*.html`, which `scripts/shoot-add-line.mjs` wraps in the app's
 * real built CSS and photographs.
 *
 * THE FIVE:
 *   al-01-gap           the claim is $31.00 short, the gap named, the add
 *                       control under its lines
 *   al-02-form          the form open with the missing x-ray line typed in
 *   al-03-reconciled    the added line with its human-added mark and its trail,
 *                       and the sum now adds up
 *   al-04-advanced      after a confirm: the figure just done carries its trail,
 *                       and the NEXT unconfirmed figure is highlighted and
 *                       focused
 *   al-05-struck        a line struck as not on the page, with who, why, and the
 *                       way back
 *
 * WHAT A STILL FRAME CANNOT SHOW. The scroll positions surviving a confirm are
 * pinned by DOM-NODE IDENTITY in `rcm-confirm-in-place.test.tsx` (a remount hands
 * back a different node for the same testid) and by a scrollTop assertion beside
 * it. A photograph of one state cannot carry that, so `al-04-advanced` shows the
 * observable half — the trail appearing and the highlight moving on — and the
 * no-remount guarantee lives in the test and in the mutation that reinstates the
 * defect.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, code, check number and
 * dollar figure below is synthetic.
 *
 * Skipped unless RCM_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

const OUT = resolve(import.meta.dirname, ".shots");

const BATCH = "8acb0e32-35ae-5cd8-9692-7b5e318a31c2";
const CLAIM = "d1e2b359-a8d7-51a8-978c-7adf27bccc8d";
const LINE = "a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90";
const ADDED = "c7d41f08-2e5b-4a9c-b108-6f3a2d9e4b71";
const UPLOAD = "f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31";

type Json = Record<string, unknown>;

const S = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  nextState: null as Record<string, unknown> | null,
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
    getFieldConfirm: vi.fn(async () => S.state),
    getRemittance: vi.fn(async () => {
      throw new Error("the rail is photographed by the flow-fix shots");
    }),
    confirmFields: vi.fn(async () => ({
      office: "roland",
      batchId: BATCH,
      state: S.nextState ?? S.state,
      confirmed: [],
    })),
    addConfirmLine: vi.fn(async () => ({ addedLineId: ADDED, state: S.nextState ?? S.state })),
    strikeConfirmLine: vi.fn(async () => ({ struck: true, state: S.nextState ?? S.state })),
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

const CHECKED = { confirmed: true, source: "confirmed", confirmedBy: "A. Biller", confirmedAt: "2026-09-30T20:00:00.000Z" };

function typed(field: string, cents: number | null): Json {
  return {
    field,
    cents,
    stated: cents !== null,
    source: "added",
    confirmed: true,
    extractedCents: null,
    confirmedBy: "A. Biller",
    confirmedAt: "2026-09-30T20:12:00.000Z",
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
      f("line_paid", 15300, CHECKED),
      f("line_billed", 131500, CHECKED),
      f("line_allowed", 122900, CHECKED),
      f("line_deductible", 0, CHECKED),
      f("line_copay", 0, CHECKED),
    ],
    ...over,
  };
}

function addedLine(): Json {
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
  };
}

function lineSum(over: Json = {}): Json {
  return {
    lineCount: 1,
    comparable: true,
    lineSumCents: 15300,
    claimTotalCents: 18400,
    differenceCents: -3100,
    unstatedCount: 0,
    unconfirmedUnstatedCount: 0,
    ok: false,
    ...over,
  };
}

function confirmState({
  lines = [readLine()],
  sum = lineSum(),
  outstanding = { ok: true, outstanding: 0, first: null },
  checkTotal = f("check_total", 18400, CHECKED),
  claimTotal = f("claim_total_paid", 18400, CHECKED),
}: Json = {}): Json {
  return {
    office: "roland",
    batchId: BATCH,
    payer: "MERIDIAN MUTUAL DENTAL",
    checkNumber: "SYN-000123",
    depositDate: "2026-09-15",
    checkTotal,
    required: true,
    provenance: { uploadId: UPLOAD, textSource: "ocr", ocrPageCount: 2, ocrMeanConfidence: 0.983 },
    claims: [
      {
        claimId: CLAIM,
        patientName: "Synthetic, Patient A",
        claimNumber: "SYNCLM0001",
        serviceDate: "2026-09-15",
        totalPaid: claimTotal,
        lineSum: sum,
        lines,
      },
    ],
    outstanding,
    sums: {
      ok: true,
      comparable: true,
      checkTotalCents: 18400,
      claimsTotalCents: 18400,
      differenceCents: 0,
    },
    checkImage: null,
  };
}

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

function renderConfirm() {
  const memory = memoryLocation({ path: `/rcm/remittances/${BATCH}/confirm`, record: true });
  return render(
    <WouterRouter hook={memory.hook}>
      <FieldConfirm />
    </WouterRouter>,
  );
}

beforeEach(() => {
  S.state = confirmState();
  S.nextState = null;
});
afterEach(() => cleanup());

const maybe = process.env.RCM_SHOTS === "1" ? describe : describe.skip;

maybe("the line the scan missed, photographed", () => {
  it("01 — the gap named, and the control under the claim's lines", async () => {
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-linesum-off"));
    dump("al-01-gap");
  });

  it("02 — the form open, with the missing line typed in from the page", async () => {
    renderConfirm();
    await waitFor(() => screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`));
    fireEvent.click(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`));
    await waitFor(() => screen.getByTestId(`rcm-confirm-add-form-${CLAIM}`));
    fireEvent.change(screen.getByTestId(`rcm-confirm-add-code-${CLAIM}`), {
      target: { value: "D0220" },
    });
    fireEvent.change(screen.getByTestId(`rcm-confirm-add-description-${CLAIM}`), {
      target: { value: "Intraoral periapical first film" },
    });
    fireEvent.change(screen.getByTestId(`rcm-confirm-add-line_billed-${CLAIM}`), {
      target: { value: "42.00" },
    });
    fireEvent.change(screen.getByTestId(`rcm-confirm-add-line_allowed-${CLAIM}`), {
      target: { value: "31.00" },
    });
    fireEvent.change(screen.getByTestId(`rcm-confirm-add-line_paid-${CLAIM}`), {
      target: { value: "31.00" },
    });
    dump("al-02-form");
  });

  it("03 — the added line, marked and attributed, and the claim now adds up", async () => {
    /*
     * THE GATE GOING FROM DOES-NOT-ADD-UP TO RECONCILED, which is the shot the
     * brief asks for: the state BEFORE is `al-01-gap`, and this is after the
     * line was typed in — same screen, no reload, the sum green.
     */
    S.nextState = confirmState({
      lines: [readLine(), addedLine()],
      sum: lineSum({ lineCount: 2, lineSumCents: 18400, differenceCents: 0, ok: true }),
    });
    renderConfirm();
    await waitFor(() => screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`));
    fireEvent.click(screen.getByTestId(`rcm-confirm-add-open-${CLAIM}`));
    fireEvent.change(screen.getByTestId(`rcm-confirm-add-code-${CLAIM}`), {
      target: { value: "D0220" },
    });
    fireEvent.click(screen.getByTestId(`rcm-confirm-add-save-${CLAIM}`));
    await waitFor(() => screen.getByTestId("rcm-confirm-linesum-ok"));
    dump("al-03-reconciled");
  });

  it("04 — a figure just confirmed, and the work moved on to the next one", async () => {
    // Nothing confirmed yet, so there is a next figure to move to.
    const unchecked = confirmState({
      checkTotal: f("check_total", 18400),
      claimTotal: f("claim_total_paid", 18400),
      lines: [
        readLine({
          fields: [
            f("line_paid", null),
            f("line_billed", 131500),
            f("line_allowed", 122900),
            f("line_deductible", 0),
            f("line_copay", 0),
          ],
        }),
      ],
      outstanding: {
        ok: false,
        outstanding: 7,
        first: { claimId: null, lineId: null, field: "check_total" },
      },
      sum: lineSum({ comparable: false, lineSumCents: null, differenceCents: null }),
    });
    S.state = unchecked;

    const after = JSON.parse(JSON.stringify(unchecked));
    after.checkTotal = f("check_total", 18400, CHECKED);
    after.outstanding = {
      ok: false,
      outstanding: 6,
      first: { claimId: CLAIM, lineId: null, field: "claim_total_paid" },
    };
    S.nextState = after;

    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-yes-||check_total"));
    fireEvent.click(screen.getByTestId("rcm-confirm-yes-||check_total"));
    await waitFor(() => screen.getByTestId("rcm-confirm-by-||check_total"));
    dump("al-04-advanced");
  });

  it("05 — a line struck as not on the page, with who, why, and the way back", async () => {
    S.state = confirmState({
      lines: [
        readLine({
          struck: {
            reason: "The scan read the benefit subtotal row as a procedure.",
            struckBy: "A. Biller",
            struckAt: "2026-09-30T20:05:00.000Z",
          },
        }),
      ],
      sum: lineSum({
        lineCount: 0,
        comparable: false,
        lineSumCents: null,
        differenceCents: null,
      }),
    });
    renderConfirm();
    await waitFor(() => screen.getByTestId(`rcm-confirm-struck-by-${LINE}`));
    dump("al-05-struck");
  });
});
