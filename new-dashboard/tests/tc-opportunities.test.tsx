/**
 * Opportunities inbox (queue item 41).
 *
 * The claim's phase tree is built by od/odPlan.ts — the ONE implementation of
 * groupItemsIntoPhases + inferUrgency — and these tests pin that the inbox
 * reaches it rather than a second copy. Synthetic fixtures only.
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  OPPORTUNITY_STATUSES,
  phasesForOpportunity,
  type OpportunitiesList,
  type TcOpportunity,
} from "@/features/tc/opportunities/opportunitiesApi";
import { groupItemsIntoPhases, itemsFromOdProcedures, stripReviewFields } from "@/features/tc/od/odPlan";
import { sortOpportunities, syncSentence } from "@/features/tc/opportunities/opportunityView";
import { OpportunitiesInbox } from "@/pages/tc/TcOpportunities";
import { OpportunitiesCard } from "@/features/tc/opportunities/OpportunitiesCard";

function mk(over: Partial<TcOpportunity> = {}): TcOpportunity {
  return {
    opportunityId: "00000000-0000-4000-8000-000000000001",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    patientPhone: "(555) 010-0001",
    procedures: [
      { procNum: 501, code: "D2740", description: "crown - porcelain/ceramic", feeCents: 120000, tooth: "3", surf: "", plannedDate: "2026-08-15" },
      { procNum: 502, code: "D3330", description: "endodontic therapy, molar", feeCents: 110050, tooth: "3", surf: "", plannedDate: "2026-08-15" },
    ],
    valueCents: 230050,
    plannedDate: "2026-08-15",
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

function list(rows: TcOpportunity[], over: Partial<OpportunitiesList> = {}): OpportunitiesList {
  return {
    opportunities: rows,
    totals: { count: rows.length, valueCents: rows.reduce((s, r) => s + r.valueCents, 0) },
    truncated: false,
    sync: {
      lastSyncedAt: "2026-10-08T07:41:00.000Z",
      lastAttemptAt: "2026-10-08T07:41:00.000Z",
      lastStatus: "ok",
      lastError: null,
      proceduresScanned: 4210,
      patients: 2,
      namesPending: 0,
    },
    ...over,
  };
}

beforeEach(() => {
  oppApi.listOpportunities.mockReset();
  oppApi.claimOpportunity.mockReset();
  oppApi.dismissOpportunity.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});
afterEach(cleanup);

describe("vocabulary", () => {
  it("statuses equal the migration's CHECK literals", () => {
    const src = readFileSync(
      resolve(__dirname, "../../backend/migrations-tenant/1790600000000_tc_opportunities.js"),
      "utf8",
    );
    const m = /check: "status IN \(([^)]+)\)"/.exec(src);
    expect(m).not.toBeNull();
    const literals = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(literals).toEqual([...OPPORTUNITY_STATUSES]);
  });
});

describe("phasesForOpportunity — ONE implementation (odPlan.ts)", () => {
  it("is exactly odPlan's grouping over the snapshot, cents preserved", () => {
    const opp = mk();
    const expected = groupItemsIntoPhases(
      stripReviewFields(
        itemsFromOdProcedures(
          opp.procedures.map((p) => ({
            procNum: p.procNum,
            toothNum: p.tooth,
            surf: p.surf,
            procCode: p.code,
            description: p.description,
            fee: p.feeCents / 100,
            insEst: 0,
            patAmt: p.feeCents / 100,
          })),
        ),
      ),
    );
    const phases = phasesForOpportunity(opp);
    expect(phases).toEqual(expected);
    // inferUrgency: D3 endo is high (urgent phase), D2 crown is medium.
    expect(phases.map((p) => p.name)).toEqual(["Phase 1 — Urgent Treatment", "Phase 2 — Restorative"]);
    const items = phases.flatMap((p) => p.items ?? []);
    expect(items.map((i) => [i.odProcNum, i.feeCents])).toEqual([
      [502, 110050],
      [501, 120000],
    ]);
  });

  it("an odd-cent fee survives the dollars round trip", () => {
    const phases = phasesForOpportunity(
      mk({ procedures: [{ procNum: 9, code: "D1110", description: "prophylaxis", feeCents: 10999, tooth: "", surf: "", plannedDate: null }] }),
    );
    expect(phases[0]?.items?.[0]?.feeCents).toBe(10999);
  });
});

describe("view rules", () => {
  const a = mk({ opportunityId: "a", odPatientId: 1, valueCents: 100, plannedDate: "2026-05-01", lastSeenAt: "2026-10-01T00:00:00Z" });
  const b = mk({ opportunityId: "b", odPatientId: 2, valueCents: 900, plannedDate: "2026-07-01", lastSeenAt: "2026-10-08T00:00:00Z" });
  const c = mk({ opportunityId: "c", odPatientId: 3, valueCents: 500, plannedDate: null, lastSeenAt: "2026-09-01T00:00:00Z" });
  it("sorts by value, oldest plan, most recently seen", () => {
    expect(sortOpportunities([a, b, c], "value").map((r) => r.opportunityId)).toEqual(["b", "c", "a"]);
    expect(sortOpportunities([a, b, c], "planned").map((r) => r.opportunityId)).toEqual(["a", "b", "c"]);
    expect(sortOpportunities([a, b, c], "lastSeen").map((r) => r.opportunityId)).toEqual(["b", "a", "c"]);
  });
  it("the sync sentence never claims more freshness than the last completed sweep", () => {
    expect(syncSentence(null).text).toMatch(/Not synced yet/);
    expect(syncSentence(list([]).sync).tone).toBe("ok");
    const failed = syncSentence({ ...list([]).sync!, lastStatus: "partial", lastAttemptAt: "2026-10-09T07:30:00Z" });
    expect(failed.tone).toBe("warn");
    expect(failed.text).toMatch(/did not finish — showing the sync from/);
    expect(syncSentence({ ...list([]).sync!, namesPending: 3 }).text).toMatch(/3 names still to read/);
  });
});

describe("OpportunitiesInbox", () => {
  it("lists rows with totals and claims through the odPlan-built tree", async () => {
    const row = mk();
    oppApi.listOpportunities.mockResolvedValue(list([row]));
    oppApi.claimOpportunity.mockResolvedValue({ caseId: "case-1", url: "/tc/cases/case-1", attached: false, opportunity: null });
    render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Test 2, Stedi");
    expect(screen.getByTestId("opportunity-totals").textContent).toMatch(/1\s*patient.*\$2,300\.50/);
    fireEvent.click(screen.getByRole("button", { name: /Claim/ }));
    await waitFor(() => expect(oppApi.claimOpportunity).toHaveBeenCalledWith("roland", expect.objectContaining({ opportunityId: row.opportunityId })));
    await waitFor(() => expect(screen.queryByText("Test 2, Stedi")).toBeNull());
  });

  it("dismiss needs a reason before the button enables", async () => {
    oppApi.listOpportunities.mockResolvedValue(list([mk()]));
    oppApi.dismissOpportunity.mockResolvedValue({ opportunity: null });
    render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Test 2, Stedi");
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    const confirm = await screen.findAllByRole("button", { name: "Dismiss" });
    const dialogButton = confirm[confirm.length - 1]!;
    expect((dialogButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "   " } });
    expect((dialogButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Patient declined" } });
    expect((dialogButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(dialogButton);
    await waitFor(() =>
      expect(oppApi.dismissOpportunity).toHaveBeenCalledWith("roland", mk().opportunityId, "Patient declined"),
    );
  });

  it("a row whose name has not been read cannot be claimed, and says why", async () => {
    oppApi.listOpportunities.mockResolvedValue(list([mk({ patientName: null })]));
    render(<OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />);
    await screen.findByText("Name pending");
    expect((screen.getByRole("button", { name: /Claim/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/arrives with the next nightly sync/)).toBeTruthy();
  });

  it("all offices: office badges on, one honest sync line per office", async () => {
    oppApi.listOpportunities.mockImplementation((office: string) =>
      Promise.resolve(
        office === "roland"
          ? list([mk()])
          : list([mk({ opportunityId: "v1", officeId: "valley", odPatientId: 7115, patientName: "TestValley, Stedi" })], { sync: null }),
      ),
    );
    render(<OpportunitiesInbox offices={["roland", "valley"]} showOfficeBadges />);
    await screen.findByText("TestValley, Stedi");
    expect(screen.getByTestId("sync-valley").textContent).toMatch(/Not synced yet/);
    expect(screen.getByTestId("sync-roland").textContent).toMatch(/Synced from Open Dental/);
  });
});

describe("OpportunitiesCard", () => {
  it("shows the REAL new-row totals summed across offices", async () => {
    oppApi.listOpportunities.mockImplementation((office: string) =>
      Promise.resolve(office === "roland" ? list([mk()]) : list([mk({ opportunityId: "v", valueCents: 49950 })])),
    );
    render(<OpportunitiesCard offices={["roland", "valley"]} />);
    await waitFor(() => expect(screen.getByTestId("opportunities-card").textContent).toMatch(/2\s*patients.*\$2,800\.00/));
    expect(oppApi.listOpportunities).toHaveBeenCalledWith("roland", "new");
  });

  it("never synced → says so instead of a reassuring zero", async () => {
    oppApi.listOpportunities.mockResolvedValue(list([], { sync: null }));
    render(<OpportunitiesCard offices={["roland"]} />);
    await screen.findByText(/Not synced from Open Dental yet/);
  });
});
