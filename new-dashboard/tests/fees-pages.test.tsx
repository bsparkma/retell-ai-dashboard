/**
 * The two fee-schedule screens.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS DEFEND
 * ═════════════════════════════════════════════════════════════════════════════
 * The reference importer this module was ported from made its interpretations
 * SILENTLY: it took the first money token on a multi-column row whatever tier
 * the office held, and wrote one line's single amount against every code on it.
 * Nobody could have caught either, because nothing on screen said a choice had
 * been made. The parser now flags those rows — and a flag the UI does not
 * render is a flag that does not exist.
 *
 * So the assertions below are, in order of how much they matter:
 *
 *  1. A WARNED ROW SHOWS ITS RAW LINE. The line is the only thing that lets a
 *     reader judge whether the interpretation was right. A warning without it
 *     is a warning nobody can act on.
 *  2. $0.00 RENDERS AS $0.00. Not blank, not an em dash. Zero means not
 *     covered / bundled / no fee, and the reference discarded every one.
 *  3. A FAILED BATCH SHOWS ITS REASON, on the list and on the detail page. A
 *     file that would not parse must never look like a file that vanished.
 *  4. THE UPLOAD IS DISABLED UNDER "ALL OFFICES". Roland and Riley hold
 *     different contracts with the same payers; guessing is the expensive kind
 *     of wrong.
 *
 * NO NETWORK, NO BACKEND, NO PHI. A fee schedule carries procedure codes and
 * money and never a patient — every fixture below is synthetic anyway: invented
 * round fees, and two payers (NORTHSTAR DENTAL, MERIDIAN BENEFIT) that do not
 * exist.
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

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

type Warning = { code: string; message: string };

interface Batch {
  batchId: string;
  office: "roland" | "valley";
  filename: string;
  fileSha256: string;
  fileSizeBytes: number;
  sourceType: "pdf" | "csv";
  status: "parsed" | "failed";
  rowCount: number;
  warningCount: number;
  warnings: Warning[];
  failureReason: string | null;
  failureCode: string | null;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface Row {
  rowId: string;
  procCode: string;
  feeCents: number;
  rawLine: string;
  warnings: Warning[];
  rowOrder: number;
}

const SHA = "a".repeat(64);

function batch(over: Partial<Batch> = {}): Batch {
  return {
    batchId: "11111111-1111-4111-8111-111111111111",
    office: "roland",
    filename: "northstar-2027.pdf",
    fileSha256: SHA,
    fileSizeBytes: 240_000,
    sourceType: "pdf",
    status: "parsed",
    rowCount: 3,
    warningCount: 0,
    warnings: [],
    failureReason: null,
    failureCode: null,
    createdBy: "manager@carein.ai",
    createdAt: "2026-09-20T14:30:00.000Z",
    updatedAt: "2026-09-20T14:30:00.000Z",
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    rowId: "aaaaaaaa-0000-4000-8000-000000000001",
    procCode: "D1110",
    feeCents: 9200,
    rawLine: "D1110   Prophylaxis - adult                        92.00",
    warnings: [],
    rowOrder: 0,
    ...over,
  };
}

/** The multi-column row: three tier columns, first one taken, flagged. */
const AMBIGUOUS_ROW = row({
  rowId: "aaaaaaaa-0000-4000-8000-000000000002",
  procCode: "D2740",
  feeCents: 115000,
  rawLine: "D2740   Crown - porcelain/ceramic    1,150.00   920.00     805.00",
  rowOrder: 1,
  warnings: [
    {
      code: "ambiguous_amount",
      message:
        "Line 4 carries 3 amounts (1,150.00, 920.00, 805.00). The first was read as D2740's fee. Check it is the right column.",
    },
  ],
});

/** $0.00 — not covered / bundled / no fee. The reference dropped these. */
const ZERO_ROW = row({
  rowId: "aaaaaaaa-0000-4000-8000-000000000003",
  procCode: "D9986",
  feeCents: 0,
  rawLine: "D9986   Missed appointment                                0.00",
  rowOrder: 2,
});

const fixtures = vi.hoisted(() => ({
  /** office → the batches that office's list returns. */
  lists: {} as Record<string, unknown[]>,
  /** batchId → { batch, rows }, keyed per office to exercise the 404 fallback. */
  detail: null as { batch: unknown; rows: unknown[] } | null,
  detailOffice: "roland" as string,
  listError: null as { message: string; status: number; code: string | null } | null,
  uploadResult: null as { batch: unknown; rows: unknown[] } | null,
  uploadError: null as
    | { message: string; status: number; code: string | null; details: Record<string, unknown> }
    | null,
  uploadCalls: [] as Array<{ office: string; filename: string }>,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [
      { officeId: "roland", officeName: "Roland Family Dental" },
      { officeId: "valley", officeName: "Valley Fort Smith" },
    ],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/fees/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/fees/api")>();
  const { FeesApiError } = real;
  return {
    ...real,
    listImports: vi.fn(async (office: string) => {
      if (fixtures.listError) {
        throw new FeesApiError(
          fixtures.listError.message,
          fixtures.listError.status,
          fixtures.listError.code,
        );
      }
      return {
        success: true as const,
        office,
        batches: fixtures.lists[office] ?? [],
        limit: 50,
        offset: 0,
      };
    }),
    getImport: vi.fn(async (office: string) => {
      if (fixtures.detail === null || office !== fixtures.detailOffice) {
        throw new FeesApiError("No such import.", 404, "BATCH_NOT_FOUND");
      }
      return { success: true as const, ...fixtures.detail };
    }),
    uploadImport: vi.fn(async (office: string, file: File) => {
      fixtures.uploadCalls.push({ office, filename: file.name });
      if (fixtures.uploadError) {
        throw new FeesApiError(
          fixtures.uploadError.message,
          fixtures.uploadError.status,
          fixtures.uploadError.code,
          fixtures.uploadError.details,
        );
      }
      return { success: true as const, ...(fixtures.uploadResult ?? { batch: batch(), rows: [] }) };
    }),
  };
});

import FeesImports from "@/pages/fees/FeesImports";
import FeesImportDetail from "@/pages/fees/FeesImportDetail";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.lists = {};
  fixtures.detail = null;
  fixtures.detailOffice = "roland";
  fixtures.listError = null;
  fixtures.uploadResult = null;
  fixtures.uploadError = null;
  fixtures.uploadCalls = [];
});
afterEach(cleanup);

// ════════════════════════════════════════════════════════════════════════════
// The preview
// ════════════════════════════════════════════════════════════════════════════

describe("the import preview", () => {
  it("THE STAR: a warned row is visually distinct AND shows the line it came from", async () => {
    fixtures.detail = {
      batch: batch({ rowCount: 3, warningCount: 1 }),
      rows: [row(), AMBIGUOUS_ROW, ZERO_ROW],
    };
    renderAt(<FeesImportDetail />, "/fees/imports/11111111-1111-4111-8111-111111111111");

    await screen.findByTestId("fees-import-detail");
    const rows = await screen.findAllByTestId("fees-row");
    expect(rows).toHaveLength(3);

    // Exactly one row is marked warned, and it is the ambiguous one.
    const warned = rows.filter((r) => r.getAttribute("data-warned") === "true");
    expect(warned).toHaveLength(1);
    expect(warned[0].textContent).toContain("$1,150.00");

    // The warning's own sentence, from the server.
    const warning = screen.getByTestId("fees-row-warning");
    expect(warning.textContent).toMatch(/carries 3 amounts/);
    expect(warning.textContent).toContain("ambiguous_amount");

    // AND THE RAW LINE — the whole reason the column is stored. Without it a
    // reader cannot tell whether 1,150.00 was the right column.
    const raw = screen.getByTestId("fees-row-raw-line");
    expect(raw.textContent).toContain("1,150.00   920.00     805.00");

    // The unwarned rows carry no raw line, so the flagged one stands out.
    expect(screen.getAllByTestId("fees-row-raw-line")).toHaveLength(1);
  });

  it("renders $0.00 as $0.00 — never blank, never a dash", async () => {
    fixtures.detail = { batch: batch({ rowCount: 1 }), rows: [ZERO_ROW] };
    renderAt(<FeesImportDetail />, "/fees/imports/11111111-1111-4111-8111-111111111111");

    const amount = await screen.findByTestId("fees-row-amount");
    expect(amount.textContent).toBe("$0.00");
  });

  it("groups a duplicate code so both fees are seen side by side", async () => {
    const first = row({
      rowId: "d1",
      procCode: "D2740",
      feeCents: 115000,
      rawLine: "D2740   Crown   1,150.00",
      rowOrder: 0,
    });
    const amended = row({
      rowId: "d2",
      procCode: "D2740",
      feeCents: 127500,
      rawLine: "D2740   Crown   1,275.00",
      rowOrder: 1,
      warnings: [
        {
          code: "duplicate_code",
          message:
            "D2740 appears 2 times in this file at DIFFERENT fees ($1,150.00, $1,275.00). Decide which one is the rate you hold before posting any of them.",
        },
      ],
    });
    fixtures.detail = {
      batch: batch({ rowCount: 3, warningCount: 1 }),
      rows: [first, amended, row({ rowId: "d3", rowOrder: 2 })],
    };
    renderAt(<FeesImportDetail />, "/fees/imports/11111111-1111-4111-8111-111111111111");

    await screen.findByTestId("fees-import-detail");
    const groups = await screen.findAllByTestId("fees-row-group");
    // Two groups from three rows: the duplicate collapsed into one.
    expect(groups).toHaveLength(2);

    const crown = groups.find((g) => g.getAttribute("data-proc-code") === "D2740");
    expect(crown).toBeDefined();
    expect(crown?.getAttribute("data-conflicting")).toBe("true");
    // Both amounts in the SAME group, so the disagreement is one glance.
    expect(crown?.textContent).toContain("$1,150.00");
    expect(crown?.textContent).toContain("$1,275.00");
    expect(screen.getByTestId("fees-duplicate-badge").textContent).toMatch(/different fees/);
  });

  it("renders file-level warnings at the top, separately from the rows", async () => {
    fixtures.detail = {
      batch: batch({
        rowCount: 1,
        warningCount: 1,
        warnings: [
          {
            code: "multiple_codes_on_line",
            message:
              "Line 3 names 3 procedure codes (D0210, D0220, D0230), so there is no way to tell which fee belongs to which. No fees were read from it.",
          },
        ],
      }),
      rows: [row()],
    };
    renderAt(<FeesImportDetail />, "/fees/imports/11111111-1111-4111-8111-111111111111");

    const fileWarnings = await screen.findByTestId("fees-file-warnings");
    expect(fileWarnings.textContent).toMatch(/D0210, D0220, D0230/);
    // It is NOT filed among the rows: it describes something absent from them.
    expect(screen.queryAllByTestId("fees-row-warning")).toHaveLength(0);
  });

  it("carries the preview-only banner, and names Open Dental in it", async () => {
    fixtures.detail = { batch: batch(), rows: [row()] };
    renderAt(<FeesImportDetail />, "/fees/imports/11111111-1111-4111-8111-111111111111");

    const banner = await screen.findByTestId("fees-preview-banner");
    expect(banner.textContent).toMatch(/Preview only/i);
    expect(banner.textContent).toMatch(/nothing has been sent to Open Dental/i);
  });

  it("shows a failed batch's reason and code, and no row table", async () => {
    fixtures.detail = {
      batch: batch({
        status: "failed",
        rowCount: 0,
        filename: "meridian.csv",
        sourceType: "csv",
        failureReason:
          "More than one column could be the fee (UCR Fee, Allowed Amount, Contracted Fee). Rename or remove the ones you did not mean, so there is exactly one.",
        failureCode: "CSV_AMBIGUOUS_COLUMNS",
      }),
      rows: [],
    };
    renderAt(<FeesImportDetail />, "/fees/imports/11111111-1111-4111-8111-111111111111");

    const failed = await screen.findByTestId("fees-detail-failed");
    expect(failed.textContent).toMatch(/could not be read/i);
    expect(screen.getByTestId("fees-detail-failure-reason").textContent).toMatch(/UCR Fee/);
    expect(screen.getByTestId("fees-detail-failure-code").textContent).toBe(
      "CSV_AMBIGUOUS_COLUMNS",
    );
    expect(screen.queryAllByTestId("fees-row")).toHaveLength(0);
  });

  it("surfaces the server's refusal rather than an empty preview", async () => {
    fixtures.detail = null;
    renderAt(<FeesImportDetail />, "/fees/imports/99999999-9999-4999-8999-999999999999");

    const error = await screen.findByTestId("fees-detail-error");
    expect(error.textContent).toMatch(/No such import/i);
    expect(screen.queryByTestId("fees-row")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The import list and the upload
// ════════════════════════════════════════════════════════════════════════════

describe("the import list", () => {
  it("lists this office's imports with counts and the uploader", async () => {
    fixtures.lists.roland = [
      batch({ batchId: "b1", filename: "northstar-2027.pdf", rowCount: 6, warningCount: 0 }),
      batch({
        batchId: "b2",
        filename: "meridian-tiers.pdf",
        rowCount: 2,
        warningCount: 2,
        createdAt: "2026-09-19T10:00:00.000Z",
      }),
    ];
    renderAt(<FeesImports />, "/fees");

    await screen.findByTestId("fees-imports-list");
    const rows = screen.getAllByTestId("fees-import-row");
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].textContent).toContain("northstar-2027.pdf");
    expect(rows[0].textContent).toContain("manager@carein.ai");
    expect(rows[0].textContent).toContain("6 fees");

    const warningBadge = screen.getByTestId("fees-import-warning-badge");
    expect(warningBadge.textContent).toMatch(/2 warnings/);
  });

  it("shows a failed batch's badge AND its reason on the row itself", async () => {
    // A "Failed" badge whose why is one click away is a badge somebody learns
    // to ignore.
    fixtures.lists.roland = [
      batch({
        batchId: "b3",
        filename: "meridian.csv",
        sourceType: "csv",
        status: "failed",
        rowCount: 0,
        failureReason: "No procedure-code column. Expected one headed something like \"Code\".",
        failureCode: "CSV_NO_CODE_COLUMN",
      }),
    ];
    renderAt(<FeesImports />, "/fees");

    await screen.findByTestId("fees-imports-list");
    expect(screen.getByTestId("fees-import-failed-badge").textContent).toMatch(/Failed/);
    const reason = screen.getByTestId("fees-import-failure-reason");
    expect(reason.textContent).toMatch(/No procedure-code column/);
    expect(reason.textContent).toContain("CSV_NO_CODE_COLUMN");
  });

  it("says an empty list LOADED, rather than showing nothing", async () => {
    fixtures.lists.roland = [];
    renderAt(<FeesImports />, "/fees");

    const empty = await screen.findByTestId("fees-imports-empty");
    expect(empty.textContent).toMatch(/No imports yet/i);
    expect(screen.queryByTestId("fees-imports-error")).toBeNull();
  });

  it("an error is not an empty list", async () => {
    fixtures.listError = { message: "MODULE_NOT_ENTITLED", status: 403, code: null };
    renderAt(<FeesImports />, "/fees");

    const error = await screen.findByTestId("fees-imports-error");
    expect(error.textContent).toMatch(/MODULE_NOT_ENTITLED/);
    expect(screen.queryByTestId("fees-imports-empty")).toBeNull();
  });

  it("fans out across both offices under All, and labels every row", async () => {
    localStorage.setItem("carein.office", "all");
    fixtures.lists.roland = [batch({ batchId: "r1", filename: "roland.pdf", office: "roland" })];
    fixtures.lists.valley = [
      batch({
        batchId: "v1",
        filename: "riley.pdf",
        office: "valley",
        createdAt: "2026-09-21T09:00:00.000Z",
      }),
    ];
    renderAt(<FeesImports />, "/fees");

    await screen.findByTestId("fees-imports-list");
    const rows = screen.getAllByTestId("fees-import-row");
    expect(rows).toHaveLength(2);
    // Merged newest-first ACROSS offices, not per-office runs stitched together.
    expect(rows[0].textContent).toContain("riley.pdf");

    const labels = screen.getAllByTestId("fees-import-row-office").map((el) => el.textContent);
    expect(labels).toContain("Roland");
    expect(labels).toContain("Riley");
  });
});

describe("the upload", () => {
  it("THE OTHER STAR: under All offices the upload is disabled until one is picked", async () => {
    // Roland and Riley hold different contracts with the same payers. A
    // schedule filed against the wrong one would eventually reprice a practice
    // against terms it never agreed to, so there is no sensible default.
    localStorage.setItem("carein.office", "all");
    fixtures.lists.roland = [];
    fixtures.lists.valley = [];
    renderAt(<FeesImports />, "/fees");

    const button = await screen.findByTestId("fees-upload-button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("fees-upload-needs-office")).toBeTruthy();

    // Picking one enables it.
    fireEvent.click(screen.getByTestId("fees-upload-office-valley"));
    await waitFor(() => {
      expect((screen.getByTestId("fees-upload-button") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId("fees-upload-needs-office")).toBeNull();
  });

  it("is enabled straight away under a concrete office, and uploads to THAT office", async () => {
    fixtures.lists.roland = [];
    fixtures.uploadResult = { batch: batch({ rowCount: 6 }), rows: [] };
    renderAt(<FeesImports />, "/fees");

    const button = await screen.findByTestId("fees-upload-button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // No picker at all — there is nothing to ask.
    expect(screen.queryByTestId("fees-upload-office-picker")).toBeNull();

    const input = screen.getByTestId("fees-file-input") as HTMLInputElement;
    const file = new File(["Code,Fee\nD1110,92.00\n"], "northstar.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByTestId("fees-upload-done");
    expect(fixtures.uploadCalls).toEqual([{ office: "roland", filename: "northstar.csv" }]);
  });

  it("renders a parse failure's message, code, AND the batch the server stored", async () => {
    // The whole point of storing a failed batch: "I uploaded it and nothing
    // happened" must not be the outcome.
    fixtures.lists.roland = [];
    fixtures.uploadError = {
      message:
        "More than one column could be the fee (UCR Fee, Allowed Amount, Contracted Fee). Rename or remove the ones you did not mean, so there is exactly one.",
      status: 422,
      code: "CSV_AMBIGUOUS_COLUMNS",
      details: { batch: batch({ batchId: "f1", filename: "meridian.csv", status: "failed", rowCount: 0, failureReason: "…", failureCode: "CSV_AMBIGUOUS_COLUMNS" }) },
    };
    renderAt(<FeesImports />, "/fees");

    await screen.findByTestId("fees-upload-button");
    const input = screen.getByTestId("fees-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "meridian.csv", { type: "text/csv" })] },
    });

    const error = await screen.findByTestId("fees-upload-error");
    expect(error.textContent).toMatch(/UCR Fee/);
    expect(screen.getByTestId("fees-upload-error-code").textContent).toBe("CSV_AMBIGUOUS_COLUMNS");

    const stored = screen.getByTestId("fees-upload-error-batch");
    expect(stored.textContent).toMatch(/recorded as a failed import/i);
    expect(screen.getByTestId("fees-upload-error-batch-link").textContent).toBe("meridian.csv");
  });

  it("a 415 says so WITHOUT claiming a record was kept", async () => {
    // Nothing is stored when the file type has no lane. Implying otherwise is
    // the same dishonesty in the other direction.
    fixtures.lists.roland = [];
    renderAt(<FeesImports />, "/fees");

    await screen.findByTestId("fees-upload-button");
    const input = screen.getByTestId("fees-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "fees.xlsx", { type: "application/vnd.ms-excel" })] },
    });

    const error = await screen.findByTestId("fees-upload-error");
    expect(error.textContent).toMatch(/neither a PDF nor a CSV/i);
    expect(screen.getByTestId("fees-upload-error-code").textContent).toBe(
      "UNSUPPORTED_FILE_TYPE",
    );
    expect(screen.queryByTestId("fees-upload-error-batch")).toBeNull();
    // And it never reached the network — the extension check is a courtesy that
    // saves a round trip, while the server's own 415 remains the real refusal.
    expect(fixtures.uploadCalls).toEqual([]);
  });

  it("renders a 413 over-size refusal from the server verbatim", async () => {
    fixtures.lists.roland = [];
    fixtures.uploadError = {
      message: "That file is larger than the 10MB limit.",
      status: 413,
      code: "FILE_TOO_LARGE",
      details: {},
    };
    renderAt(<FeesImports />, "/fees");

    await screen.findByTestId("fees-upload-button");
    fireEvent.change(screen.getByTestId("fees-file-input"), {
      target: { files: [new File(["x"], "huge.pdf", { type: "application/pdf" })] },
    });

    const error = await screen.findByTestId("fees-upload-error");
    expect(error.textContent).toMatch(/larger than the 10MB limit/);
    expect(screen.getByTestId("fees-upload-error-code").textContent).toBe("FILE_TOO_LARGE");
  });

  it("names the 10MB ceiling and the two formats before anybody tries", async () => {
    fixtures.lists.roland = [];
    renderAt(<FeesImports />, "/fees");
    const zone = await screen.findByTestId("fees-dropzone");
    expect(zone.textContent).toMatch(/PDF or CSV/i);
    expect(zone.textContent).toMatch(/10MB/);
  });
});
