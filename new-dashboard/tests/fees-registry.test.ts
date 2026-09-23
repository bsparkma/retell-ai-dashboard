/**
 * The fee-schedule module's wiring: route gating, the module registry, and the
 * pure presentation helpers the preview depends on.
 *
 * Pure-lib assertions only — the two pages have their own .tsx suite. What is
 * defended here is the set of facts that are invisible on screen until they are
 * wrong: a route that needs no permission, a module missing from the registry
 * (which silently removes its Home tile and switcher entry), and a $0.00 that
 * renders as nothing.
 */
import { describe, expect, it } from "vitest";

import { requiredActionFor, canVisit, ROUTE_PERMISSIONS } from "../client/src/lib/permissions";
import { MODULES, MODULE_IDS, isModuleId } from "../client/src/lib/modules";
import {
  formatFeeCents,
  formatBytes,
  groupRowsByCode,
  sourceTypeFromFilename,
  isFeesOfficeId,
  FEES_OFFICE_IDS,
  type FeesImportRow,
} from "../client/src/features/fees/api";

// ─── Route gating ────────────────────────────────────────────────────────────

describe("route gating for /fees", () => {
  it("gates /fees on fees.read", () => {
    expect(requiredActionFor("/fees")).toBe("fees.read");
  });

  it("gates the import preview through the same prefix", () => {
    // Longest-prefix-wins means the detail page needs no entry of its own; this
    // asserts it actually inherits rather than falling through to unrestricted,
    // which is what a typo'd prefix would do silently.
    expect(requiredActionFor("/fees/imports/2f1a9c44-0000-4000-8000-000000000000")).toBe(
      "fees.read",
    );
  });

  it("lets a holder of fees.read visit, and bounces someone without it", () => {
    expect(canVisit(["fees.read"], "/fees")).toBe(true);
    expect(canVisit(["fees.read"], "/fees/imports/abc")).toBe(true);
    expect(canVisit(["voice.read", "rcm.read"], "/fees")).toBe(false);
    expect(canVisit([], "/fees")).toBe(false);
    expect(canVisit(undefined, "/fees")).toBe(false);
  });

  it("does not gate any OTHER route on a fees action", () => {
    // A fees action leaking onto an unrelated prefix would lock that page for
    // everybody who does not hold it — the expensive direction of this mistake.
    const feesGated = Object.entries(ROUTE_PERMISSIONS)
      .filter(([, action]) => action.startsWith("fees."))
      .map(([prefix]) => prefix);
    expect(feesGated).toEqual(["/fees"]);
  });

  it("gates the upload no harder than the page — fees.write is enforced server-side", () => {
    // The route requires fees.read only. A reader who cannot import still opens
    // the page and is refused by the server if they try, which is the shape RCM
    // uses: a hidden button teaches nobody why they cannot press it.
    expect(requiredActionFor("/fees")).not.toBe("fees.write");
  });
});

// ─── The module registry ─────────────────────────────────────────────────────

describe("the fees module is registered client-side", () => {
  it("is in the CHECK-constraint vocabulary", () => {
    expect(isModuleId("fees")).toBe(true);
    expect(MODULE_IDS).toContain("fees");
  });

  it("has the entry the Home tile and module switcher render from", () => {
    // Home.tsx reads this registry; there is deliberately nothing to add there.
    // A module with no entry renders no tile and no switcher item, and the
    // failure mode is a page nobody can navigate to.
    const fees = MODULES.fees;
    expect(fees).toBeDefined();
    expect(fees?.id).toBe("fees");
    expect(fees?.label).toBe("Fee Schedules");
    expect(fees?.basePath).toBe("/fees");
    expect(fees?.description).toBeTruthy();
    expect(fees?.icon).toBeTruthy();
  });

  it("lands on a route the permission map actually gates", () => {
    // A basePath that is not in ROUTE_PERMISSIONS is a tile that opens an
    // ungated page; one that does not match a Route is a tile that 404s.
    const fees = MODULES.fees;
    expect(fees).toBeDefined();
    expect(requiredActionFor(fees?.basePath ?? "")).toBe("fees.read");
  });
});

// ─── Money ───────────────────────────────────────────────────────────────────

describe("formatFeeCents", () => {
  it("THE ONE THAT MATTERS: $0.00 renders as $0.00, never blank and never a dash", () => {
    // In a fee schedule zero means not covered, bundled, or no fee. The
    // reference importer discarded every one of them with a `> 0` guard; a UI
    // that drew the zero as an empty cell would put the defect back one layer up.
    expect(formatFeeCents(0)).toBe("$0.00");
    expect(formatFeeCents(0)).not.toBe("");
    expect(formatFeeCents(0)).not.toBe("—");
  });

  it("renders cents as dollars, with thousands separators", () => {
    expect(formatFeeCents(4500)).toBe("$45.00");
    expect(formatFeeCents(9200)).toBe("$92.00");
    expect(formatFeeCents(115000)).toBe("$1,150.00");
    expect(formatFeeCents(123456700)).toBe("$1,234,567.00");
  });

  it("keeps the trailing zero cents that a naive division loses", () => {
    expect(formatFeeCents(1820)).toBe("$18.20");
    expect(formatFeeCents(1805)).toBe("$18.05");
    expect(formatFeeCents(10)).toBe("$0.10");
  });

  it("degrades to $0.00 rather than NaN on a value the server should never send", () => {
    expect(formatFeeCents(Number.NaN)).toBe("$0.00");
    expect(formatFeeCents(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });
});

describe("formatBytes", () => {
  it("reads as a size rather than a number", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(0)).toBe("0 KB");
  });
});

// ─── Duplicates ──────────────────────────────────────────────────────────────

function row(over: Partial<FeesImportRow> = {}): FeesImportRow {
  return {
    rowId: `r${Math.random().toString(16).slice(2)}`,
    procCode: "D1110",
    feeCents: 9200,
    rawLine: "D1110   Prophylaxis - adult    92.00",
    warnings: [],
    rowOrder: 0,
    ...over,
  };
}

describe("groupRowsByCode", () => {
  it("keeps file order by first appearance", () => {
    const groups = groupRowsByCode([
      row({ procCode: "D0120", rowOrder: 0 }),
      row({ procCode: "D2740", rowOrder: 1 }),
      row({ procCode: "D0120", rowOrder: 2 }),
    ]);
    expect(groups.map((g) => g.procCode)).toEqual(["D0120", "D2740"]);
  });

  it("flags a code listed twice at DIFFERENT fees as conflicting", () => {
    // A base page and an amendment page. The reference importer kept the first
    // and discarded the second in silence; both are stored now, and this is
    // what puts the two numbers side by side.
    const groups = groupRowsByCode([
      row({ procCode: "D2740", feeCents: 115000 }),
      row({ procCode: "D2740", feeCents: 127500 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].conflicting).toBe(true);
    expect(groups[0].rows.map((r) => r.feeCents)).toEqual([115000, 127500]);
  });

  it("does NOT flag a code listed twice at the SAME fee as conflicting", () => {
    // Untidy, not a decision. Drawing the two alike would spend the reader's
    // attention on the one that does not need it.
    const groups = groupRowsByCode([
      row({ procCode: "D1110", feeCents: 9200 }),
      row({ procCode: "D1110", feeCents: 9200 }),
    ]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].conflicting).toBe(false);
  });

  it("never marks a code that appears once", () => {
    const groups = groupRowsByCode([row({ procCode: "D0120" })]);
    expect(groups[0].conflicting).toBe(false);
  });

  it("returns nothing for no rows", () => {
    expect(groupRowsByCode([])).toEqual([]);
  });
});

// ─── Office keys and file types ──────────────────────────────────────────────

describe("office keys", () => {
  it("admits exactly the two the server admits", () => {
    expect([...FEES_OFFICE_IDS]).toEqual(["roland", "valley"]);
    expect(isFeesOfficeId("roland")).toBe(true);
    expect(isFeesOfficeId("valley")).toBe(true);
  });

  it("refuses the system bucket and everything else", () => {
    // 'unknown' is officeAgents' bucket for unmapped Mango lines. It names no
    // practice, and a payer contract filed under it belongs to nobody.
    expect(isFeesOfficeId("unknown")).toBe(false);
    expect(isFeesOfficeId("all")).toBe(false);
    expect(isFeesOfficeId("ROLAND")).toBe(false);
    expect(isFeesOfficeId("")).toBe(false);
    expect(isFeesOfficeId(null)).toBe(false);
    expect(isFeesOfficeId(7)).toBe(false);
  });
});

describe("sourceTypeFromFilename", () => {
  it("reads the extension, case-insensitively", () => {
    expect(sourceTypeFromFilename("northstar-2027.pdf")).toBe("pdf");
    expect(sourceTypeFromFilename("NORTHSTAR-2027.PDF")).toBe("pdf");
    expect(sourceTypeFromFilename("schedule.csv")).toBe("csv");
  });

  it("refuses everything else, so the page can say so without a round trip", () => {
    expect(sourceTypeFromFilename("fees.xlsx")).toBeNull();
    expect(sourceTypeFromFilename("fees")).toBeNull();
    expect(sourceTypeFromFilename("")).toBeNull();
  });
});
