/**
 * CONFIRMING A FIGURE NEVER RESETS THE PAGE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────
 * Every confirm went through `load()`, which sets `kind: "loading"` — so the
 * whole tree came down and went back up. The document viewer remounted and lost
 * its scroll position and its page; the figure list went back to the top. A
 * biller working down a scanned EOB with thirty money figures had to find her
 * place again after each one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS PINNED HERE, AND WHY EACH PIN IS THE ONE THAT WOULD HAVE CAUGHT IT
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. NO REMOUNT — the viewer's frame is the SAME DOM node afterwards. Node
 *      identity rather than a rendered string: React hands back a new element
 *      object whenever a subtree is destroyed and rebuilt, so `toBe` is the
 *      strongest statement available in jsdom that nothing unmounted. The
 *      scroll position of the figures column is asserted beside it, because that
 *      is the thing a biller actually loses.
 *   2. ADVANCE — focus and the highlight move to the next unconfirmed figure,
 *      and it is the SERVER'S `outstanding.first` that decides which, not an
 *      order the browser worked out for itself.
 *   3. ENTER — answers the focused row and advances, so a run of figures is a
 *      run of keystrokes.
 *   4. FAILURE KEEPS PLACE — the row says so, where she is, and nothing moves:
 *      not the state, not the focus, not the figure she typed.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, check number and dollar
 * figure below is synthetic.
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
const UPLOAD = "f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31";

type Json = Record<string, unknown>;

const S = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  /** Every confirm request the screen sent. */
  sent: [] as Array<{ fields: unknown[] }>,
  /** How many times the screen went back for the whole page. */
  reads: 0,
  confirmError: null as Error | null,
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
      S.reads += 1;
      if (!S.state) throw new Error("no such check");
      return S.state;
    }),
    /*
     * The rail's check. Absent on purpose in this file: the rail is pinned in
     * `rcm-field-confirm-flow.test.tsx`, and leaving it out keeps these renders
     * about the two panes.
     */
    getRemittance: vi.fn(async () => {
      throw new Error("not under test here");
    }),
    confirmFields: vi.fn(async (_office: string, _batchId: string, fields: unknown[]) => {
      S.sent.push({ fields });
      if (S.confirmError) throw S.confirmError;
      /*
       * A FAKE SERVER THAT ACTUALLY APPLIES THE WRITE, and hands its whole
       * recomputed state back — which is the contract the in-place save rests
       * on. A mock that returned the state unchanged would let a screen that
       * silently re-fetched still look correct.
       */
      S.state = applyConfirm(S.state as Json, fields as Instruction[]);
      return { office: "roland", batchId: BATCH, state: S.state, confirmed: [] };
    }),
  };
});

import FieldConfirm from "@/pages/rcm/FieldConfirm";

type Instruction = {
  claimId: string | null;
  lineId: string | null;
  field: string;
  confirmedCents: number | null;
};

/** One field, unconfirmed and read off the scan unless told otherwise. */
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

function addressOf(field: string, claimId: string | null, lineId: string | null) {
  return `${claimId ?? ""}|${lineId ?? ""}|${field}`;
}

/**
 * The server's own job, in miniature: mark the confirmed fields, then recount
 * what is outstanding and say which one is first.
 *
 * `first` walks the check in the order the remittance prints it — the anchor,
 * then each claim's total, then each line's five figures — which is the order
 * `confirmedFigures.requiredFields` builds. The screen must follow the server's
 * order and not the DOM's, and this fake is what makes that assertable.
 */
function applyConfirm(state: Json, fields: Instruction[]): Json {
  const next: Json = JSON.parse(JSON.stringify(state));
  const touched = new Set(fields.map((i) => addressOf(i.field, i.claimId, i.lineId)));

  const mark = (row: Json, claimId: string | null, lineId: string | null) => {
    const address = addressOf(String(row.field), claimId, lineId);
    if (!touched.has(address)) return;
    const asked = fields.find(
      (i) => addressOf(i.field, i.claimId, i.lineId) === address,
    ) as Instruction;
    row.confirmed = true;
    row.cents = asked.confirmedCents;
    row.stated = asked.confirmedCents !== null;
    row.source = asked.confirmedCents === row.extractedCents ? "confirmed" : "corrected";
    row.confirmedBy = "A Biller";
    row.confirmedAt = "2026-09-30T20:00:00.000Z";
  };

  /** Every field on the check, in the server's order. */
  const walk: Array<{ row: Json; claimId: string | null; lineId: string | null }> = [
    { row: next.checkTotal as Json, claimId: null, lineId: null },
  ];
  for (const claim of next.claims as Json[]) {
    walk.push({ row: claim.totalPaid as Json, claimId: String(claim.claimId), lineId: null });
    for (const line of claim.lines as Json[]) {
      for (const row of line.fields as Json[]) {
        walk.push({ row, claimId: String(claim.claimId), lineId: String(line.lineId) });
      }
    }
  }

  for (const at of walk) mark(at.row, at.claimId, at.lineId);

  const missing = walk.filter((at) => at.row.confirmed !== true);
  next.outstanding = {
    ok: missing.length === 0,
    outstanding: missing.length,
    first: missing[0]
      ? { claimId: missing[0].claimId, lineId: missing[0].lineId, field: missing[0].row.field }
      : null,
  };
  return next;
}

function confirmState(over: Json = {}): Json {
  return {
    office: "roland",
    batchId: BATCH,
    payer: "MERIDIAN MUTUAL DENTAL",
    checkNumber: "SYN-000123",
    depositDate: "2026-09-15",
    checkTotal: f("check_total", 18400),
    required: true,
    provenance: {
      uploadId: UPLOAD,
      textSource: "ocr",
      ocrPageCount: 2,
      ocrMeanConfidence: 0.983,
    },
    claims: [
      {
        claimId: CLAIM,
        patientName: "Synthetic, Patient A",
        claimNumber: "SYNCLM0001",
        serviceDate: "2026-09-15",
        totalPaid: f("claim_total_paid", 18400),
        /**
         * DOES THIS CLAIM ADD UP? The same `claimLineSum` the gate refuses on,
         * sent so the screen can render it rather than work it out.
         */
        lineSum: {
          lineCount: 1,
          comparable: true,
          lineSumCents: 18400,
          claimTotalCents: 18400,
          differenceCents: 0,
          unstatedCount: 0,
          unconfirmedUnstatedCount: 0,
          ok: true,
        },
        lines: [
          {
            lineId: LINE,
            position: 0,
            code: "D2750",
            description: "Crown - porcelain/ceramic",
            region: null,
            kind: "extracted" as const,
            struck: null,
            fields: [
              f("line_paid", null),
              f("line_billed", 131500),
              f("line_allowed", 122900),
              f("line_deductible", 0),
              f("line_copay", 0),
            ],
          },
        ],
      },
    ],
    outstanding: {
      ok: false,
      outstanding: 7,
      first: { claimId: null, lineId: null, field: "check_total" },
    },
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

function renderConfirm() {
  const memory = memoryLocation({ path: `/rcm/remittances/${BATCH}/confirm`, record: true });
  return render(
    <WouterRouter hook={memory.hook}>
      <FieldConfirm />
    </WouterRouter>,
  );
}

const ANCHOR = addressOf("check_total", null, null);
const CLAIM_TOTAL = addressOf("claim_total_paid", CLAIM, null);
const LINE_PAID = addressOf("line_paid", CLAIM, LINE);

beforeEach(() => {
  S.state = confirmState();
  S.sent = [];
  S.reads = 0;
  S.confirmError = null;
});
afterEach(() => cleanup());

// ─── 1. The save happens in place ────────────────────────────────────────────

describe("confirming a figure does not reset the page", () => {
  it("keeps the document viewer MOUNTED — the same node, not a new one", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-document-frame")).toBeTruthy());

    const frameBefore = screen.getByTestId("rcm-confirm-document-frame");

    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`));
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-by-${ANCHOR}`)).toBeTruthy());

    /*
     * THE PIN. A remount gives a different DOM node for the same testid; a
     * re-render of a mounted tree gives the identical one. Nothing else in jsdom
     * distinguishes the two, and the distinction is the whole defect.
     */
    expect(screen.getByTestId("rcm-confirm-document-frame")).toBe(frameBefore);
  });

  it("keeps the scroll position the biller was at", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-page")).toBeTruthy());

    // Where she had scrolled to. jsdom has no layout, so this is the scroll
    // position as a value — which is exactly what a remount would discard.
    const page = screen.getByTestId("rcm-confirm-page");
    page.scrollTop = 420;

    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`));
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-by-${ANCHOR}`)).toBeTruthy());

    expect(screen.getByTestId("rcm-confirm-page").scrollTop).toBe(420);
  });

  it("does NOT go back to the server for the whole page", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`)).toBeTruthy());
    expect(S.reads).toBe(1);

    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`));
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-by-${ANCHOR}`)).toBeTruthy());

    // One read, at mount. The save's own response carried the new state.
    expect(S.reads).toBe(1);
  });

  it("shows the server's recomputed count, without working it out itself", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-not-done")).toBeTruthy());
    expect(screen.getByTestId("rcm-confirm-not-done").textContent).toContain("7 figures");

    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`));
    await waitFor(() =>
      expect(screen.getByTestId("rcm-confirm-not-done").textContent).toContain("6 figures"),
    );
  });
});

// ─── 2. Focus and highlight move to the next unconfirmed figure ──────────────

describe("the work moves on by itself", () => {
  it("highlights and focuses the next unconfirmed figure, in the server's order", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`)).toBeTruthy());

    // Nothing is focused before she starts: a screen that grabbed focus on mount
    // would move the page out from under somebody who was reading it.
    expect(screen.getByTestId(`rcm-confirm-field-${ANCHOR}`).dataset.focused).toBeUndefined();

    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`));

    // The anchor is first in the server's order, so the claim total is next.
    await waitFor(() =>
      expect(screen.getByTestId(`rcm-confirm-field-${CLAIM_TOTAL}`).dataset.focused).toBe("true"),
    );
    expect(document.activeElement).toBe(screen.getByTestId(`rcm-confirm-yes-${CLAIM_TOTAL}`));
  });

  it("walks the whole check, and stops highlighting when there is nothing left", async () => {
    // One field left: the line's copay.
    S.state = confirmState({
      checkTotal: f("check_total", 18400, { confirmed: true, source: "confirmed" }),
      outstanding: {
        ok: false,
        outstanding: 1,
        first: { claimId: CLAIM, lineId: LINE, field: "line_copay" },
      },
    });
    const state = S.state as Json;
    (state.claims as Json[])[0].totalPaid = f("claim_total_paid", 18400, {
      confirmed: true,
      source: "confirmed",
    });
    const lines = ((state.claims as Json[])[0].lines as Json[])[0];
    lines.fields = [
      f("line_paid", null, { confirmed: true, source: "confirmed" }),
      f("line_billed", 131500, { confirmed: true, source: "confirmed" }),
      f("line_allowed", 122900, { confirmed: true, source: "confirmed" }),
      f("line_deductible", 0, { confirmed: true, source: "confirmed" }),
      f("line_copay", 0),
    ];

    const COPAY = addressOf("line_copay", CLAIM, LINE);
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${COPAY}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${COPAY}`));

    // Everything checked: the primary becomes the way on, and nothing is
    // highlighted because there is no next figure to go to.
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-done")).toBeTruthy());
    expect(document.querySelector('[data-focused="true"]')).toBeNull();
  });

  it("selects the next figure's LINE too, so the document can follow the work", async () => {
    // The claim total is the last thing before the line's five figures.
    S.state = confirmState({
      checkTotal: f("check_total", 18400, { confirmed: true, source: "confirmed" }),
      outstanding: {
        ok: false,
        outstanding: 6,
        first: { claimId: CLAIM, lineId: null, field: "claim_total_paid" },
      },
    });

    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${CLAIM_TOTAL}`)).toBeTruthy());

    // Before: no line is selected, so the row is not marked as the active one.
    expect(screen.getByTestId(`rcm-confirm-line-${LINE}`).className).not.toContain(
      "border-foreground/40",
    );

    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${CLAIM_TOTAL}`));

    /*
     * The next figure is `line_paid` on that line, so the line becomes the
     * selected one — which is what the document panel keys its page off once the
     * stored read carries geometry for a line. Until it does, the page does not
     * move, which is why this asserts the SELECTION and not a page number.
     */
    await waitFor(() =>
      expect(screen.getByTestId(`rcm-confirm-line-${LINE}`).className).toContain(
        "border-foreground/40",
      ),
    );
  });
});

// ─── 3. Enter answers the row ────────────────────────────────────────────────

describe("Enter confirms the focused figure and advances", () => {
  it("confirms on Enter, then moves on", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`)).toBeTruthy());

    fireEvent.keyDown(screen.getByTestId(`rcm-confirm-field-${ANCHOR}`), { key: "Enter" });

    await waitFor(() => expect(S.sent.length).toBe(1));
    expect(S.sent[0].fields).toEqual([
      { claimId: null, lineId: null, field: "check_total", confirmedCents: 18400 },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId(`rcm-confirm-field-${CLAIM_TOTAL}`).dataset.focused).toBe("true"),
    );
  });

  it("saves the TYPED figure on Enter when the box is open, not the read one", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-edit-${ANCHOR}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`rcm-confirm-edit-${ANCHOR}`));
    fireEvent.change(screen.getByTestId(`rcm-confirm-input-${ANCHOR}`), {
      target: { value: "211.40" },
    });
    fireEvent.keyDown(screen.getByTestId(`rcm-confirm-input-${ANCHOR}`), { key: "Enter" });

    await waitFor(() => expect(S.sent.length).toBe(1));
    expect(S.sent[0].fields).toEqual([
      { claimId: null, lineId: null, field: "check_total", confirmedCents: 21140 },
    ]);
  });

  it("does nothing on Enter when what is typed is not a figure", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-edit-${ANCHOR}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`rcm-confirm-edit-${ANCHOR}`));
    fireEvent.change(screen.getByTestId(`rcm-confirm-input-${ANCHOR}`), {
      target: { value: "1,84o" },
    });
    fireEvent.keyDown(screen.getByTestId(`rcm-confirm-input-${ANCHOR}`), { key: "Enter" });

    // Not the read figure either. Enter must never fall back to confirming what
    // the machine said while she is partway through disagreeing with it.
    await new Promise((r) => setTimeout(r, 0));
    expect(S.sent.length).toBe(0);
  });
});

// ─── 4. A failed save keeps her place ────────────────────────────────────────

describe("a save that fails says so where it happened, and nothing moves", () => {
  it("names the failure at the row, leaves the figure unconfirmed, and does not advance", async () => {
    S.confirmError = new Error("That could not be saved.");
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`)).toBeTruthy());

    const frameBefore = screen.getByTestId("rcm-confirm-document-frame");
    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`));

    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-error-${ANCHOR}`)).toBeTruthy());

    // Still unconfirmed, still no trail line, nothing highlighted anywhere, and
    // the viewer never came down.
    expect(screen.getByTestId(`rcm-confirm-yes-${ANCHOR}`)).toBeTruthy();
    expect(screen.queryByTestId(`rcm-confirm-by-${ANCHOR}`)).toBeNull();
    expect(document.querySelector('[data-focused="true"]')).toBeNull();
    expect(screen.getByTestId("rcm-confirm-document-frame")).toBe(frameBefore);
    expect(screen.getByTestId("rcm-confirm-not-done").textContent).toContain("7 figures");
  });

  it("keeps the typed figure in its box so she can try again without retyping", async () => {
    S.confirmError = new Error("That could not be saved.");
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-edit-${ANCHOR}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`rcm-confirm-edit-${ANCHOR}`));
    fireEvent.change(screen.getByTestId(`rcm-confirm-input-${ANCHOR}`), {
      target: { value: "211.40" },
    });
    fireEvent.click(screen.getByTestId(`rcm-confirm-save-${ANCHOR}`));

    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-error-${ANCHOR}`)).toBeTruthy());
    expect(
      (screen.getByTestId(`rcm-confirm-input-${ANCHOR}`) as HTMLInputElement).value,
    ).toBe("211.40");
  });

  it("puts a failed line-wide save on the LINE, not on one of its five figures", async () => {
    S.confirmError = new Error("That could not be saved.");
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-line-all-${LINE}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`rcm-confirm-line-all-${LINE}`));

    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-line-error-${LINE}`)).toBeTruthy());
    expect(screen.queryByTestId(`rcm-confirm-error-${LINE_PAID}`)).toBeNull();
  });
});
