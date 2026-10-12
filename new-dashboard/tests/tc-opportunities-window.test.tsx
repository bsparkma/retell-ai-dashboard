/**
 * Opportunities display window + age chips (queue item 45).
 *
 * The server applies the office window (default 18 months) and maxAgeMonths;
 * these tests pin the client side: the chip set, the re-query, the read-only
 * window line, newest-first default order, view-local chip state, and that the
 * dashboard card never sends a chip. Synthetic fixtures only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const oppApi = vi.hoisted(() => ({
  listOpportunities: vi.fn(),
  claimOpportunity: vi.fn(),
  dismissOpportunity: vi.fn(),
}));
vi.mock("@/features/tc/opportunities/opportunitiesApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/opportunities/opportunitiesApi")>();
  return { ...real, ...oppApi };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type {
  OpportunitiesList,
  OpportunityWindow,
  TcOpportunity,
} from "@/features/tc/opportunities/opportunitiesApi";
import {
  AGE_STEPS,
  DEFAULT_SORT,
  SORT_LABELS,
  ageChips,
  sortOpportunities,
  windowSentence,
} from "@/features/tc/opportunities/opportunityView";
import { OpportunitiesInbox } from "@/pages/tc/TcOpportunities";
import { OpportunitiesCard } from "@/features/tc/opportunities/OpportunitiesCard";

function mk(over: Partial<TcOpportunity> = {}): TcOpportunity {
  return {
    opportunityId: "00000000-0000-4000-8000-000000000001",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    patientPhone: null,
    procedures: [
      { procNum: 501, code: "D2740", description: "crown - porcelain/ceramic", feeCents: 120000, tooth: "3", surf: "", plannedDate: "2026-09-15" },
    ],
    valueCents: 120000,
    plannedDate: "2026-09-15",
    newestPlannedDate: "2026-09-15",
    status: "new",
    claimedCaseId: null,
    claimedBy: null,
    claimedAt: null,
    dismissedReason: null,
    dismissedBy: null,
    dismissedAt: null,
    resurrectedAt: null,
    firstSeenAt: "2026-10-01T07:30:00.000Z",
    lastSeenAt: "2026-10-08T07:30:00.000Z",
    ...over,
  };
}

const WIN18: OpportunityWindow = { officeMonths: 18, appliedMonths: 18, since: "2025-04-12", includesUndated: true };

function list(rows: TcOpportunity[], window: OpportunityWindow = WIN18): OpportunitiesList {
  return {
    opportunities: rows,
    totals: { count: rows.length, valueCents: rows.reduce((s, r) => s + r.valueCents, 0) },
    truncated: false,
    sync: {
      lastSyncedAt: "2026-10-12T07:41:00.000Z",
      lastAttemptAt: "2026-10-12T07:41:00.000Z",
      lastStatus: "ok",
      lastError: null,
      proceduresScanned: 4210,
      patients: 2,
      namesPending: 0,
    },
    window,
  };
}

/** Fake server: rows carry newestPlannedDate; maxAgeMonths filters by a fixed cutoff table. */
const FRESH = mk({ opportunityId: "fresh", odPatientId: 12827, patientName: "Test 2, Stedi", valueCents: 5000, newestPlannedDate: "2026-09-30" });
const OLDER = mk({ opportunityId: "older", odPatientId: 12828, patientName: "Test, MangoTest", valueCents: 900000, newestPlannedDate: "2025-12-01" });
const CUTOFF: Record<number, string> = { 1: "2026-09-12", 2: "2026-08-12", 3: "2026-07-12", 4: "2026-06-12", 6: "2026-04-12", 8: "2026-02-12", 12: "2025-10-12" };

function fakeServer() {
  oppApi.listOpportunities.mockImplementation((_office: string, _status: string, maxAge?: number) => {
    if (maxAge === undefined) return Promise.resolve(list([OLDER, FRESH]));
    const since = CUTOFF[maxAge]!;
    const rows = [OLDER, FRESH].filter((r) => (r.newestPlannedDate ?? "") >= since);
    return Promise.resolve(list(rows, { officeMonths: 18, appliedMonths: maxAge, since, includesUndated: false }));
  });
}

beforeEach(() => {
  oppApi.listOpportunities.mockReset();
});
afterEach(cleanup);

describe("view rules", () => {
  it("chips: the steps below the office window, then the window as 'All'", () => {
    expect(AGE_STEPS).toEqual([1, 2, 3, 4, 6, 8, 12, 18]);
    expect(ageChips([18]).map((c) => [c.months, c.label])).toEqual([
      [1, "1 mo"], [2, "2 mo"], [3, "3 mo"], [4, "4 mo"], [6, "6 mo"], [8, "8 mo"], [12, "12 mo"], [null, "18 mo · All"],
    ]);
    expect(ageChips([6]).map((c) => c.label)).toEqual(["1 mo", "2 mo", "3 mo", "4 mo", "6 mo · All"]);
    expect(ageChips([24]).map((c) => c.months)).toEqual([1, 2, 3, 4, 6, 8, 12, 18, null]);
    expect(ageChips([18, 6]).at(-1)).toEqual({ months: null, label: "All" });
    expect(ageChips([]).at(-1)?.months).toBeNull();
  });

  it("default sort is newest plan first; undated last; the existing sorts stay", () => {
    expect(DEFAULT_SORT).toBe("newest");
    expect(Object.keys(SORT_LABELS)).toEqual(["newest", "value", "planned", "lastSeen"]);
    const undated = mk({ opportunityId: "u", odPatientId: 3, valueCents: 1, newestPlannedDate: null, plannedDate: null });
    expect(sortOpportunities([OLDER, undated, FRESH], "newest").map((r) => r.opportunityId)).toEqual(["fresh", "older", "u"]);
    expect(sortOpportunities([FRESH, OLDER], "value").map((r) => r.opportunityId)).toEqual(["older", "fresh"]);
  });

  it("the window line says what is shown and the window it sits in", () => {
    expect(windowSentence([])).toBeNull();
    expect(windowSentence([{ officeLabel: "Roland", window: WIN18 }])).toBe("Showing plans from the last 18 months");
    expect(
      windowSentence([{ officeLabel: "Roland", window: { ...WIN18, appliedMonths: 1 } }]),
    ).toBe("Showing plans from the last 1 month · office window 18 months");
    expect(
      windowSentence([
        { officeLabel: "Roland", window: WIN18 },
        { officeLabel: "Riley", window: { ...WIN18, officeMonths: 6, appliedMonths: 6 } },
      ]),
    ).toBe("Showing plans from the last 18 months (Roland), 6 months (Riley)");
  });
});

describe("OpportunitiesInbox — window + chips", () => {
  it("loads the office window, newest plan first, and says so read-only", async () => {
    fakeServer();
    render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Test 2, Stedi");
    expect(oppApi.listOpportunities).toHaveBeenCalledWith("roland", "new");
    expect(screen.getByTestId("opportunity-window").textContent).toBe("Showing plans from the last 18 months");
    const names = screen.getAllByTestId("opportunity-row").map((r) => r.textContent ?? "");
    expect(names[0]).toMatch(/Test 2, Stedi/);
    expect(names[1]).toMatch(/Test, MangoTest/);
    expect(screen.getByTestId("age-chip-all").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("age-chip-all").textContent).toBe("18 mo · All");
  });

  it("a chip re-queries with maxAgeMonths and the list + totals follow the server", async () => {
    fakeServer();
    render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Test, MangoTest");
    fireEvent.click(screen.getByTestId("age-chip-3"));
    await waitFor(() => expect(oppApi.listOpportunities).toHaveBeenLastCalledWith("roland", "new", 3));
    await waitFor(() => expect(screen.queryByText("Test, MangoTest")).toBeNull());
    expect(screen.getByText("Test 2, Stedi")).toBeTruthy();
    expect(screen.getByTestId("opportunity-totals").textContent).toMatch(/1\s*patient/);
    expect(screen.getByTestId("age-chip-3").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("opportunity-window").textContent).toBe(
      "Showing plans from the last 3 months · office window 18 months",
    );
    // Back to the window: no maxAgeMonths at all.
    fireEvent.click(screen.getByTestId("age-chip-all"));
    await waitFor(() => expect(oppApi.listOpportunities).toHaveBeenLastCalledWith("roland", "new"));
    await screen.findByText("Test, MangoTest");
  });

  it("a slow earlier response never paints over the chip's answer", async () => {
    let releaseWindow: (v: OpportunitiesList) => void = () => {};
    oppApi.listOpportunities.mockImplementation((_o: string, _s: string, maxAge?: number) =>
      maxAge === undefined
        ? new Promise<OpportunitiesList>((r) => {
            releaseWindow = r;
          })
        : Promise.resolve(list([FRESH], { officeMonths: 18, appliedMonths: maxAge, since: CUTOFF[maxAge]!, includesUndated: false })),
    );
    render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    fireEvent.click(screen.getByTestId("age-chip-1"));
    await screen.findByText("Test 2, Stedi");
    releaseWindow(list([OLDER, FRESH]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Test, MangoTest")).toBeNull();
    expect(screen.getByTestId("opportunity-window").textContent).toMatch(/last 1 month · office window 18 months/);
  });

  it("the chip survives a tab switch but not a reload (view-local)", async () => {
    fakeServer();
    const first = render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Test 2, Stedi");
    fireEvent.click(screen.getByTestId("age-chip-6"));
    await waitFor(() => expect(oppApi.listOpportunities).toHaveBeenLastCalledWith("roland", "new", 6));
    fireEvent.click(screen.getByRole("tab", { name: "Dismissed" }));
    await waitFor(() => expect(oppApi.listOpportunities).toHaveBeenLastCalledWith("roland", "dismissed", 6));
    first.unmount();
    oppApi.listOpportunities.mockClear();
    render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Test 2, Stedi");
    expect(oppApi.listOpportunities).toHaveBeenCalledWith("roland", "new");
    expect(oppApi.listOpportunities).not.toHaveBeenCalledWith("roland", "new", 6);
    expect(screen.getByTestId("age-chip-all").getAttribute("aria-pressed")).toBe("true");
  });

  it("all offices: the chip goes to every office; differing windows are named per office", async () => {
    oppApi.listOpportunities.mockImplementation((office: string, _s: string, maxAge?: number) =>
      Promise.resolve(
        office === "roland"
          ? list([FRESH], { ...WIN18, appliedMonths: maxAge ?? 18 })
          : list([mk({ opportunityId: "v", officeId: "valley", odPatientId: 7115, patientName: "TestValley, Stedi" })], {
              officeMonths: 6,
              appliedMonths: Math.min(maxAge ?? 6, 6),
              since: "2026-04-12",
              includesUndated: maxAge === undefined,
            }),
      ),
    );
    render(<OpportunitiesInbox offices={["roland", "valley"]} showOfficeBadges />);
    await screen.findByText("TestValley, Stedi");
    expect(screen.getByTestId("age-chip-all").textContent).toBe("All");
    expect(screen.getByTestId("opportunity-window").textContent).toMatch(/18 months \(.+\), 6 months \(.+\)/);
    fireEvent.click(screen.getByTestId("age-chip-2"));
    await waitFor(() => {
      expect(oppApi.listOpportunities).toHaveBeenCalledWith("roland", "new", 2);
      expect(oppApi.listOpportunities).toHaveBeenCalledWith("valley", "new", 2);
    });
  });
});

describe("OpportunitiesCard ignores the chip", () => {
  it("always asks for the office window — never a maxAgeMonths", async () => {
    fakeServer();
    const inbox = render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Test 2, Stedi");
    fireEvent.click(screen.getByTestId("age-chip-1"));
    await waitFor(() => expect(oppApi.listOpportunities).toHaveBeenLastCalledWith("roland", "new", 1));
    inbox.unmount();
    oppApi.listOpportunities.mockClear();
    render(<OpportunitiesCard offices={["roland"]} />);
    await waitFor(() => expect(screen.getByTestId("opportunities-card").textContent).toMatch(/2\s*patients.*\$9,050\.00/));
    expect(oppApi.listOpportunities).toHaveBeenCalledTimes(1);
    expect(oppApi.listOpportunities.mock.calls[0]).toEqual(["roland", "new"]);
  });
});
