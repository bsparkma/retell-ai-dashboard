/**
 * The review surface: inline fee editing, warning navigation, CDT sections.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS DEFEND
 * ═════════════════════════════════════════════════════════════════════════════
 *  1. AN EDIT SENDS CENTS, AND SHOWS BOTH NUMBERS. The screen must never
 *     present a corrected fee as though it were what the payer's file said —
 *     the struck-through parsed value is the evidence a second reader checks
 *     the correction against.
 *  2. THE WARNING COUNTER COUNTS WARNED-AND-UNDECIDED ROWS, and nothing else. A
 *     counter that included clean rows would show 400 on a file with six real
 *     questions in it, and people would stop looking at it.
 *  3. SECTIONS DO NOT LOSE ROWS. Every row of the batch appears in exactly one
 *     section, and file order survives inside one. A fee that is in the batch
 *     but on no section of the page is a fee somebody posts without ever having
 *     seen it.
 *  4. A POSTED BATCH IS READ-ONLY. Its rows are the record of what was written.
 *     The server refuses the edit as well (409 BATCH_NOT_EDITABLE); this is the
 *     courtesy in front of that refusal, and the courtesy must not be the only
 *     thing there.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Fee schedules carry procedure codes and money
 * and never a patient.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

type Warning = { code: string; message: string };

const BATCH_ID = "22222222-2222-4222-8222-222222222222";

/** Every warned row in these fixtures carries the multi-column ambiguity. */
const AMBIGUOUS: Warning = {
  code: "ambiguous_amount",
  message: "Line 4 carries 3 amounts (1,150.00, 920.00, 805.00). The first was read as the fee.",
};

function batch(over: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    office: "roland",
    filename: "meridian-tiers.pdf",
    fileSha256: "b".repeat(64),
    fileSizeBytes: 190_000,
    sourceType: "pdf",
    status: "parsed",
    rowCount: 5,
    warningCount: 2,
    warnings: [] as Warning[],
    failureReason: null,
    failureCode: null,
    createdBy: "manager@carein.ai",
    createdAt: "2026-09-22T15:00:00.000Z",
    updatedAt: "2026-09-22T15:00:00.000Z",
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    rowId: "cccccccc-0000-4000-8000-000000000000",
    procCode: "D1110",
    feeCents: 9200,
    rawLine: "D1110   Prophylaxis - adult    92.00",
    warnings: [] as Warning[],
    rowOrder: 0,
    decision: "pending",
    decidedBy: null,
    decidedAt: null,
    editedFeeCents: null,
    odFeeNum: null,
    ...over,
  };
}

/**
 * Five rows across four CDT categories, deliberately NOT in code order in the
 * file — D4341 is read before D2740, exactly as a payer's amendment page does.
 * That is what makes "sections in code order, file order inside a section" a
 * property these tests can tell apart from "sorted".
 */
const ROWS = [
  row({ rowId: "r-1", procCode: "D0120", feeCents: 4500, rowOrder: 0 }),
  row({ rowId: "r-2", procCode: "D1110", feeCents: 9200, rowOrder: 1 }),
  row({
    rowId: "r-3",
    procCode: "D4341",
    feeCents: 24500,
    rowOrder: 2,
    rawLine: "D4341   Perio scaling per quadrant   245.00  196.00  171.50",
    warnings: [AMBIGUOUS],
  }),
  row({
    rowId: "r-4",
    procCode: "D2740",
    feeCents: 115000,
    rowOrder: 3,
    rawLine: "D2740   Crown - porcelain/ceramic    1,150.00   920.00     805.00",
    warnings: [AMBIGUOUS],
  }),
  row({ rowId: "r-5", procCode: "D2750", feeCents: 109000, rowOrder: 4 }),
];

function progress(over: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    office: "roland",
    filename: "meridian-tiers.pdf",
    status: "parsed",
    rowCount: 5,
    rowsWritten: 0,
    writableCount: 5,
    excludedCount: 0,
    editedCount: 0,
    blockingCount: 2,
    totalCents: 262200,
    target: null,
    postError: null,
    postingStartedAt: null,
    postedAt: null,
    postedBy: null,
    rolledBackAt: null,
    rolledBackBy: null,
    backup: null,
    running: false,
    ...over,
  };
}

const server = vi.hoisted(() => ({
  batch: null as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  progress: null as Record<string, unknown> | null,
  decided: [] as Array<{ rowId: string; decision: string; feeCents?: number }>,
  decideError: null as { message: string; status: number; code: string } | null,
  permissions: ["fees.read", "fees.write"] as string[],
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Office Manager",
      email: "manager@carein.ai",
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["fees"] },
      role: "office" as const,
      isSuperAdmin: false,
      permissions: server.permissions,
    })),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const targetApi = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(targetApi, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/fees/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/fees/api")>();
  return {
    ...real,
    getImport: vi.fn(async () => {
      if (!server.batch) throw new real.FeesApiError("No such import.", 404, "BATCH_NOT_FOUND");
      return { success: true as const, batch: server.batch, rows: server.rows };
    }),
    getProgress: vi.fn(async () => {
      if (!server.progress) throw new real.FeesApiError("No such import.", 404, "BATCH_NOT_FOUND");
      return { success: true as const, progress: server.progress };
    }),
    listFeeSchedules: vi.fn(async () => ({
      success: true as const,
      office: "roland",
      schedules: [],
    })),
    decideRow: vi.fn(
      async (
        _o: string,
        _b: string,
        rowId: string,
        verdict: { decision: string; feeCents?: number },
      ) => {
        if (server.decideError) {
          throw new real.FeesApiError(
            server.decideError.message,
            server.decideError.status,
            server.decideError.code,
          );
        }
        server.decided.push({ rowId, ...verdict });
        // Reflect the decision back into the "stored" rows, so a re-read after
        // onSettled shows what the server would have recorded. Without this the
        // live-updating counter could not be tested at all.
        server.rows = server.rows.map((r) =>
          r.rowId === rowId
            ? {
                ...r,
                decision: verdict.decision === "reset" ? "pending" : verdict.decision,
                decidedBy: verdict.decision === "reset" ? null : "manager@carein.ai",
                editedFeeCents: verdict.decision === "edited" ? verdict.feeCents : null,
              }
            : r,
        );
        return {
          success: true as const,
          row: { rowId, decision: verdict.decision },
          status: "parsed" as const,
        };
      },
    ),
  };
});

import FeesImportDetail from "@/pages/fees/FeesImportDetail";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  CDT_CATEGORIES,
  cdtCategoryFor,
  groupRowsByCategory,
  isUnresolved,
  unresolvedRowIds,
} from "@/features/fees/cdt";
import {
  effectiveFeeCents,
  feeInputValue,
  parseFeeInput,
  MAX_FEE_CENTS,
  type FeesImportRow,
} from "@/features/fees/api";

function renderDetail() {
  const memory = memoryLocation({ path: `/fees/imports/${BATCH_ID}`, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <AuthProvider>
          <OfficeProvider>
            <TooltipProvider>
              <FeesImportDetail />
            </TooltipProvider>
          </OfficeProvider>
        </AuthProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

beforeEach(() => {
  server.batch = batch();
  server.rows = ROWS.map((r) => ({ ...r }));
  server.progress = progress();
  server.decided = [];
  server.decideError = null;
  server.permissions = ["fees.read", "fees.write"];
});

afterEach(cleanup);

// ════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════════════════════

describe("the fee input", () => {
  it("reads what a person actually types off a payer PDF", () => {
    expect(parseFeeInput("920")).toBe(92000);
    expect(parseFeeInput("920.00")).toBe(92000);
    expect(parseFeeInput("$920.00")).toBe(92000);
    expect(parseFeeInput("$1,150.00")).toBe(115000);
    expect(parseFeeInput("  920.5  ")).toBe(92050);
  });

  it("reads $0.00 as a fee, because in a fee schedule it is one", () => {
    // Not covered, bundled, or no charge. The importer this module was ported
    // from dropped every zero with a `> 0` guard; refusing to type one would
    // put that back a layer up.
    expect(parseFeeInput("0")).toBe(0);
    expect(parseFeeInput("0.00")).toBe(0);
  });

  it("REFUSES rather than rounding or guessing", () => {
    // Three decimals is not a fee. Rounding it would store a number nobody
    // typed, silently, which is this module's founding complaint.
    expect(parseFeeInput("92.005")).toBeNull();
    expect(parseFeeInput("-920")).toBeNull();
    expect(parseFeeInput("nine hundred")).toBeNull();
    expect(parseFeeInput("")).toBeNull();
    expect(parseFeeInput("920.00.00")).toBeNull();
    // The same ceiling the parser and the column CHECK apply.
    expect(parseFeeInput(String(MAX_FEE_CENTS / 100 + 1))).toBeNull();
  });

  it("round-trips through the value the box starts with", () => {
    for (const cents of [0, 5, 9200, 115000, 123456789]) {
      expect(parseFeeInput(feeInputValue(cents))).toBe(cents);
    }
  });
});

describe("effectiveFeeCents", () => {
  const base = ROWS[3] as unknown as FeesImportRow;

  it("is the override ONLY for an edited row", () => {
    expect(effectiveFeeCents({ ...base, decision: "edited", editedFeeCents: 92000 })).toBe(92000);
    expect(effectiveFeeCents({ ...base, decision: "accepted", editedFeeCents: null })).toBe(115000);
    expect(effectiveFeeCents({ ...base, decision: "pending", editedFeeCents: null })).toBe(115000);
  });

  it("treats an edit to $0.00 as an edit, not as an absent one", () => {
    expect(effectiveFeeCents({ ...base, decision: "edited", editedFeeCents: 0 })).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sections
// ════════════════════════════════════════════════════════════════════════════

describe("CDT sections", () => {
  const rows = ROWS as unknown as FeesImportRow[];

  it("files every code under its leading digit", () => {
    expect(cdtCategoryFor("D0120").digit).toBe("0");
    expect(cdtCategoryFor("D9986").digit).toBe("9");
    // Lower case arrives from nowhere the parser controls, but costs nothing.
    expect(cdtCategoryFor("d2740").digit).toBe("2");
    // Anything unrecognisable still lands SOMEWHERE. A row in no section is a
    // row somebody posts without ever having seen it.
    expect(cdtCategoryFor("XX").digit).toBe("other");
  });

  it("LOSES NO ROWS, and puts each in exactly one section", () => {
    const sections = groupRowsByCategory(rows);
    const seen = sections.flatMap((s) => s.rows.map((r) => r.rowId));
    expect(seen.sort()).toEqual(rows.map((r) => r.rowId).sort());
    expect(new Set(seen).size).toBe(rows.length);
  });

  it("orders sections by code and rows by FILE order inside one", () => {
    const sections = groupRowsByCategory(rows);
    // The file lists D4341 before D2740; the sections still read D0, D1, D2, D4.
    expect(sections.map((s) => s.category.digit)).toEqual(["0", "1", "2", "4"]);
    // And inside restorative, the file's own order is kept — that is the only
    // correspondence the preview has with the document on the reader's desk.
    const restorative = sections.find((s) => s.category.digit === "2");
    expect(restorative?.rows.map((r) => r.procCode)).toEqual(["D2740", "D2750"]);
  });

  it("drops empty sections rather than rendering an empty heading", () => {
    const sections = groupRowsByCategory(rows);
    expect(sections.some((s) => s.category.digit === "8")).toBe(false);
    expect(sections.every((s) => s.rows.length > 0)).toBe(true);
  });

  it("has one shared list of ten categories, in code order", () => {
    expect(CDT_CATEGORIES).toHaveLength(10);
    expect(CDT_CATEGORIES.map((c) => c.digit)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(CDT_CATEGORIES[0].label).toMatch(/Diagnostic/);
    expect(CDT_CATEGORIES[9].label).toMatch(/Adjunctive/);
  });
});

describe("the unresolved predicate", () => {
  const rows = ROWS as unknown as FeesImportRow[];

  it("counts warned AND undecided rows, and nothing else", () => {
    // The same predicate the server's gate uses. A counter that included clean
    // rows would read 400 on a file with six real questions in it.
    expect(unresolvedRowIds(groupRowsByCategory(rows))).toEqual(["r-4", "r-3"]);
  });

  it("treats every decision as resolving, INCLUDING edited", () => {
    const warned = rows[3];
    expect(isUnresolved({ ...warned, decision: "pending" })).toBe(true);
    for (const decision of ["accepted", "excluded", "edited"] as const) {
      expect(isUnresolved({ ...warned, decision })).toBe(false);
    }
    // A clean row never needs a decision and never blocks.
    expect(isUnresolved({ ...rows[0], decision: "pending" })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The screen
// ════════════════════════════════════════════════════════════════════════════

describe("the preview, rendered", () => {
  it("draws one section per category present, with its counts", async () => {
    renderDetail();
    await screen.findByTestId("fees-import-detail");
    await waitFor(() => expect(screen.getAllByTestId("fees-section").length).toBe(4));

    const sections = screen.getAllByTestId("fees-section");
    expect(sections.map((s) => s.getAttribute("data-section"))).toEqual(["0", "1", "2", "4"]);
    // Restorative holds two fees and no questions; periodontics holds one of
    // each.
    expect(within(sections[2]).getByTestId("fees-section-header").textContent).toMatch(/2 fees/);
    expect(
      within(sections[3]).getByTestId("fees-section-header-unresolved").textContent,
    ).toMatch(/1 to answer/);
  });

  it("offers a jump menu naming exactly the sections on the page", async () => {
    renderDetail();
    await screen.findByTestId("fees-section-nav");

    // Both the desktop list and the mobile select render from the same array,
    // so a section can never exist with no way to reach it.
    expect(screen.getByTestId("fees-section-link-0")).toBeTruthy();
    expect(screen.getByTestId("fees-section-link-4")).toBeTruthy();
    expect(screen.queryByTestId("fees-section-link-8")).toBeNull();

    const select = screen.getByTestId("fees-section-jump-select") as HTMLSelectElement;
    // Four sections plus the placeholder.
    expect(select.options).toHaveLength(5);
    expect(select.options[4].textContent).toMatch(/Periodontics \(1, 1 to answer\)/);
  });

  it("counts the unanswered warnings, and steps between them", async () => {
    renderDetail();
    const nav = await screen.findByTestId("fees-warning-nav");
    expect(nav.getAttribute("data-unresolved")).toBe("2");
    expect(screen.getByTestId("fees-warning-nav-count").textContent).toMatch(
      /2 rows need an answer/,
    );

    const highlighted = () =>
      screen
        .getAllByTestId("fees-row")
        .filter((el) => el.getAttribute("data-highlighted") === "true")
        .map((el) => el.getAttribute("data-row-id"));

    expect(highlighted()).toEqual([]);

    // Next walks them in the order the eye travels: section order, then file
    // order — D2740 (restorative) before D4341 (periodontics), even though the
    // file lists them the other way round.
    fireEvent.click(screen.getByTestId("fees-warning-next"));
    expect(highlighted()).toEqual(["r-4"]);
    fireEvent.click(screen.getByTestId("fees-warning-next"));
    expect(highlighted()).toEqual(["r-3"]);
    // And it wraps, because this is a ring of things still to do.
    fireEvent.click(screen.getByTestId("fees-warning-next"));
    expect(highlighted()).toEqual(["r-4"]);
    fireEvent.click(screen.getByTestId("fees-warning-prev"));
    expect(highlighted()).toEqual(["r-3"]);
  });

  it("LIVE-UPDATES the count as rows are answered, and says so at zero", async () => {
    renderDetail();
    await screen.findByTestId("fees-warning-nav");

    const accepts = screen.getAllByTestId("fees-row-accept");
    expect(accepts).toHaveLength(2);
    fireEvent.click(accepts[0]);

    await waitFor(() =>
      expect(screen.getByTestId("fees-warning-nav").getAttribute("data-unresolved")).toBe("1"),
    );
    // Singular, because "1 rows need an answer" reads as a typo and a sentence
    // that reads as a typo is one people stop reading.
    expect(screen.getByTestId("fees-warning-nav-count").textContent).toBe("1 row needs an answer");

    fireEvent.click(screen.getAllByTestId("fees-row-accept")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("fees-warning-nav").getAttribute("data-unresolved")).toBe("0"),
    );
    // At zero it SAYS SO rather than disappearing: a counter that vanishes
    // leaves the reader unsure whether they finished or the control broke.
    expect(screen.getByTestId("fees-warning-nav").textContent).toMatch(/No warnings left/);
  });
});

describe("editing a fee in place", () => {
  it("round-trips: click the amount, type, Enter, and it sends CENTS", async () => {
    renderDetail();
    await screen.findByTestId("fees-import-detail");

    const crown = await waitFor(() => {
      const found = screen.getAllByTestId("fees-row").find((r) => r.getAttribute("data-row-id") === "r-4");
      if (!found) throw new Error("the crown row has not rendered");
      return found;
    });
    expect(within(crown).getByTestId("fees-row-amount").textContent).toBe("$1,150.00");

    fireEvent.click(within(crown).getByTestId("fees-fee-edit"));
    const input = within(crown).getByTestId("fees-fee-input") as HTMLInputElement;
    // The box opens on the current value, with no `$` and no separators, so a
    // person editing $1,150.00 does not have to delete punctuation first.
    expect(input.value).toBe("1150.00");

    fireEvent.change(input, { target: { value: "920.00" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(server.decided).toHaveLength(1));
    // CENTS on the wire, never dollars — parsing dollars server-side is where
    // rounding gets invented.
    expect(server.decided[0]).toEqual({
      rowId: "r-4",
      decision: "edited",
      feeCents: 92000,
    });
  });

  it("shows the corrected fee AND the parsed one it replaced", async () => {
    server.rows = ROWS.map((r) =>
      r.rowId === "r-4"
        ? { ...r, decision: "edited", editedFeeCents: 92000, decidedBy: "manager@carein.ai" }
        : { ...r },
    );
    renderDetail();
    await screen.findByTestId("fees-import-detail");

    const crown = await waitFor(() => {
      const found = screen.getAllByTestId("fees-row").find((r) => r.getAttribute("data-row-id") === "r-4");
      if (!found) throw new Error("the crown row has not rendered");
      return found;
    });

    // The effective fee is what is shown large — it is what will be written.
    expect(within(crown).getByTestId("fees-row-amount").textContent).toBe("$920.00");
    // And the file's own number survives beside it. Without this the screen
    // would present a corrected fee as though the payer had sent it.
    const from = within(crown).getByTestId("fees-row-edited-from");
    expect(from.textContent).toMatch(/edited from/);
    expect(from.textContent).toMatch(/\$1,150\.00/);
    expect(from.textContent).toMatch(/manager@carein\.ai/);
    // The row counts as decided, so it no longer blocks.
    expect(within(crown).getByTestId("fees-row-decision").getAttribute("data-decision")).toBe(
      "edited",
    );
    expect(screen.getByTestId("fees-warning-nav").getAttribute("data-unresolved")).toBe("1");
  });

  it("Escape abandons the edit and sends nothing", async () => {
    renderDetail();
    await screen.findByTestId("fees-import-detail");
    const crown = await waitFor(() => {
      const found = screen.getAllByTestId("fees-row").find((r) => r.getAttribute("data-row-id") === "r-4");
      if (!found) throw new Error("the crown row has not rendered");
      return found;
    });

    fireEvent.click(within(crown).getByTestId("fees-fee-edit"));
    const input = within(crown).getByTestId("fees-fee-input");
    fireEvent.change(input, { target: { value: "920.00" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(within(crown).queryByTestId("fees-fee-input")).toBeNull();
    expect(server.decided).toEqual([]);
    expect(within(crown).getByTestId("fees-row-amount").textContent).toBe("$1,150.00");
  });

  it("refuses an unreadable amount in place, without a round trip", async () => {
    renderDetail();
    await screen.findByTestId("fees-import-detail");
    const crown = await waitFor(() => {
      const found = screen.getAllByTestId("fees-row").find((r) => r.getAttribute("data-row-id") === "r-4");
      if (!found) throw new Error("the crown row has not rendered");
      return found;
    });

    fireEvent.click(within(crown).getByTestId("fees-fee-edit"));
    fireEvent.change(within(crown).getByTestId("fees-fee-input"), {
      target: { value: "nine twenty" },
    });
    fireEvent.click(within(crown).getByTestId("fees-fee-save"));

    expect(within(crown).getByTestId("fees-fee-error").textContent).toMatch(/Type an amount/);
    expect(server.decided).toEqual([]);
    // Still open, holding what they typed, rather than silently reverting it.
    expect((within(crown).getByTestId("fees-fee-input") as HTMLInputElement).value).toBe(
      "nine twenty",
    );
  });

  it("surfaces a server refusal instead of pretending the edit landed", async () => {
    server.decideError = {
      message: "That is larger than any real fee; it was not accepted.",
      status: 400,
      code: "BAD_FEE",
    };
    renderDetail();
    await screen.findByTestId("fees-import-detail");
    const crown = await waitFor(() => {
      const found = screen.getAllByTestId("fees-row").find((r) => r.getAttribute("data-row-id") === "r-4");
      if (!found) throw new Error("the crown row has not rendered");
      return found;
    });

    fireEvent.click(within(crown).getByTestId("fees-fee-edit"));
    fireEvent.change(within(crown).getByTestId("fees-fee-input"), { target: { value: "920.00" } });
    fireEvent.click(within(crown).getByTestId("fees-fee-save"));

    await waitFor(() =>
      expect(within(crown).getByTestId("fees-fee-error").textContent).toMatch(/larger than any/),
    );
    // The editor STAYS OPEN, holding what they typed. Closing it would look
    // like the edit had landed, and re-typing a number the server has already
    // refused is not the correction the reader needs to make.
    expect((within(crown).getByTestId("fees-fee-input") as HTMLInputElement).value).toBe("920.00");

    // And nothing was recorded: backing out shows the stored value, unchanged.
    fireEvent.click(within(crown).getByTestId("fees-fee-cancel"));
    expect(within(crown).getByTestId("fees-row-amount").textContent).toBe("$1,150.00");
    expect(within(crown).queryByTestId("fees-row-edited-from")).toBeNull();
  });

  it("a CLEAN row is editable too — a warning is not the only reason to correct one", async () => {
    renderDetail();
    await screen.findByTestId("fees-import-detail");
    const prophy = await waitFor(() => {
      const found = screen.getAllByTestId("fees-row").find((r) => r.getAttribute("data-row-id") === "r-2");
      if (!found) throw new Error("the prophy row has not rendered");
      return found;
    });
    // No warning, so no accept/exclude controls — but the fee is still a number
    // the office may hold differently, and a parser that read it confidently
    // can still have read it wrongly.
    expect(within(prophy).queryByTestId("fees-row-decision")).toBeNull();
    expect(within(prophy).getByTestId("fees-fee-edit")).toBeTruthy();
  });
});

describe("read-only states", () => {
  it("a POSTED batch renders its rows, and refuses to edit them", async () => {
    server.batch = batch({ status: "posted" });
    server.progress = progress({ status: "posted", rowsWritten: 5, blockingCount: 0 });
    renderDetail();
    await screen.findByTestId("fees-import-detail");

    // The rows are still SHOWN — they are the record of what was written, and
    // hiding them would leave nothing to check the practice against.
    await waitFor(() => expect(screen.getAllByTestId("fees-row").length).toBe(5));
    expect(screen.getAllByTestId("fees-row-amount").length).toBe(5);
    // But nothing on them can be changed. The server refuses this too, with
    // 409 BATCH_NOT_EDITABLE; the absent control is the courtesy in front of
    // that refusal.
    expect(screen.queryAllByTestId("fees-fee-edit")).toHaveLength(0);
    expect(screen.queryByTestId("fees-preview-banner")).toBeNull();
    expect(screen.getByTestId("fees-posted-banner")).toBeTruthy();
  });

  it("a reader without fees.write sees everything and can change nothing", async () => {
    server.permissions = ["fees.read"];
    renderDetail();
    await screen.findByTestId("fees-import-detail");

    await waitFor(() => expect(screen.getAllByTestId("fees-row").length).toBe(5));
    expect(screen.queryAllByTestId("fees-fee-edit")).toHaveLength(0);
    // The accept/exclude buttons still render, disabled — a control that
    // vanishes for a reader makes the screen look different rather than
    // restricted, and they still need to see that a decision is outstanding.
    for (const button of screen.getAllByTestId("fees-row-accept")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    // And they can still navigate the warnings, which is most of why they are
    // looking.
    expect(screen.getByTestId("fees-warning-nav").getAttribute("data-unresolved")).toBe("2");
  });

  it("a FAILED batch shows the reason and no rows at all", async () => {
    server.batch = batch({
      status: "failed",
      rowCount: 0,
      failureReason: "No fee-shaped rows were found in this PDF.",
      failureCode: "NO_ROWS_PARSED",
    });
    server.rows = [];
    server.progress = progress({ status: "failed", rowCount: 0, writableCount: 0 });
    renderDetail();

    await screen.findByTestId("fees-detail-failed");
    expect(screen.getByTestId("fees-detail-failure-code").textContent).toBe("NO_ROWS_PARSED");
    expect(screen.queryAllByTestId("fees-row")).toHaveLength(0);
    expect(screen.queryByTestId("fees-warning-nav")).toBeNull();
  });
});
