/**
 * Screenshot DUMPS for the Opportunities inbox (queue item 41).
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-opportunities-shots.test.tsx
 *   node scripts/shoot-tc-opportunities.mjs
 *
 *   tcopps-01-inbox          all offices: New tab, office badges, sort, a
 *                            name-pending row and a resurrected row
 *   tcopps-02-dismiss        the reason-required dismiss dialog
 *   tcopps-03-existing-case  "Already in a case" tab
 *   tcopps-04-sync-partial   the honest stale-sync warning
 *   tcopps-05-dashboard-card the TC dashboard card (real totals)
 *
 * NO NETWORK, NO BACKEND, NO PHI. Synthetic "Test …" names; the PatNums are
 * the designated fixtures (roland 12827 / 12828, valley 7115) plus obviously
 * synthetic 99xxxx numbers.
 *
 * Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

import type { OpportunitiesList, TcOpportunity } from "@/features/tc/opportunities/opportunitiesApi";
import { OpportunitiesInbox } from "@/pages/tc/TcOpportunities";
import { OpportunitiesCard } from "@/features/tc/opportunities/OpportunitiesCard";
import { TcPageHeader } from "@/features/tc/components/TcShell";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const P = (procNum: number, code: string, description: string, feeCents: number, tooth = "", plannedDate = "2026-08-15") => ({
  procNum,
  code,
  description,
  feeCents,
  tooth,
  surf: "",
  plannedDate,
});

function mk(over: Partial<TcOpportunity>): TcOpportunity {
  return {
    opportunityId: `opp-${Math.random().toString(36).slice(2)}`,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    patientPhone: "(555) 010-0001",
    procedures: [],
    valueCents: 0,
    plannedDate: "2026-08-15",
    status: "new",
    claimedCaseId: null,
    claimedBy: null,
    claimedAt: null,
    dismissedReason: null,
    dismissedBy: null,
    dismissedAt: null,
    resurrectedAt: null,
    firstSeenAt: "2026-10-01T07:31:00.000Z",
    lastSeenAt: "2026-10-08T07:41:00.000Z",
    ...over,
  };
}

const withValue = (o: TcOpportunity): TcOpportunity => ({
  ...o,
  valueCents: o.procedures.reduce((s, p) => s + p.feeCents, 0),
});

const ROLAND = [
  withValue(
    mk({
      odPatientId: 12827,
      procedures: [P(501, "D3330", "endodontic therapy, molar", 110050, "19"), P(502, "D2740", "crown - porcelain/ceramic", 120000, "19"), P(503, "D2950", "core buildup", 28500, "19")],
      plannedDate: "2026-06-02",
    }),
  ),
  withValue(
    mk({
      odPatientId: 12828,
      patientName: "Test, MangoTest",
      patientPhone: "(555) 010-0002",
      procedures: [P(611, "D4341", "perio scaling and root planing, 4+ teeth", 28400), P(612, "D4341", "perio scaling and root planing, 4+ teeth", 28400)],
      plannedDate: "2026-09-10",
      resurrectedAt: "2026-10-08T07:40:00.000Z",
      lastSeenAt: "2026-10-08T07:41:00.000Z",
    }),
  ),
  withValue(
    mk({
      odPatientId: 990104,
      patientName: null,
      patientPhone: null,
      procedures: [P(701, "D6010", "surgical placement of implant body", 210000, "30", "2026-07-21")],
      plannedDate: "2026-07-21",
    }),
  ),
];
const VALLEY = [
  withValue(
    mk({
      officeId: "valley",
      odPatientId: 7115,
      patientName: "TestValley, Stedi",
      patientPhone: "(555) 010-0003",
      procedures: [P(801, "D2392", "resin composite, two surfaces, posterior", 21500, "14", "2026-08-30"), P(802, "D2391", "resin composite, one surface, posterior", 17500, "15", "2026-08-30")],
      plannedDate: "2026-08-30",
    }),
  ),
];

const SYNC_OK = {
  lastSyncedAt: "2026-10-08T07:41:00.000Z",
  lastAttemptAt: "2026-10-08T07:41:00.000Z",
  lastStatus: "ok" as const,
  lastError: null,
  proceduresScanned: 4210,
  patients: 3,
  namesPending: 1,
};

function list(rows: TcOpportunity[], over: Partial<OpportunitiesList> = {}): OpportunitiesList {
  return {
    opportunities: rows,
    totals: { count: rows.length, valueCents: rows.reduce((s, r) => s + r.valueCents, 0) },
    truncated: false,
    sync: SYNC_OK,
    ...over,
  };
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <TcPageHeader
        title="Opportunities"
        subtitle="Treatment planned in Open Dental and not yet scheduled — claim one to start a case"
      />
      {children}
    </div>
  );
}

const SHOOT = process.env.TC_SHOTS === "1";

describe.skipIf(!SHOOT)("tc opportunities screenshot dumps", () => {
  afterEach(cleanup);

  it("01 inbox, all offices", async () => {
    oppApi.listOpportunities.mockImplementation((office: string) =>
      Promise.resolve(office === "roland" ? list(ROLAND) : list(VALLEY, { sync: { ...SYNC_OK, namesPending: 0, lastSyncedAt: "2026-10-08T07:52:00.000Z" } })),
    );
    render(
      <Page>
        <OpportunitiesInbox offices={["roland", "valley"]} showOfficeBadges />
      </Page>,
    );
    await screen.findByText("TestValley, Stedi");
    dump("tcopps-01-inbox@1280x1400");
  });

  it("02 dismiss dialog", async () => {
    oppApi.listOpportunities.mockResolvedValue(list(ROLAND.slice(0, 1)));
    render(
      <Page>
        <OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />
      </Page>,
    );
    await screen.findByText("Test 2, Stedi");
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    const box = await screen.findByLabelText("Reason");
    fireEvent.change(box, { target: { value: "Patient is getting this done at a specialist" } });
    await waitFor(() => screen.getByText("Dismiss this opportunity?"));
    dump("tcopps-02-dismiss");
  });

  it("03 already in a case", async () => {
    oppApi.listOpportunities.mockImplementation((_office: string, status: string) =>
      Promise.resolve(
        list(
          status === "existing_case"
            ? [{ ...ROLAND[0]!, status: "existing_case" as const }, { ...ROLAND[1]!, status: "existing_case" as const, resurrectedAt: null, claimedCaseId: "00000000-0000-4000-8000-0000000000aa", claimedBy: "tc@carein.ai" }]
            : ROLAND,
        ),
      ),
    );
    render(
      <Page>
        <OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />
      </Page>,
    );
    await screen.findByText("Test 2, Stedi");
    fireEvent.click(screen.getByRole("tab", { name: "Already in a case" }));
    await screen.findByText("Attached by tc@carein.ai", { exact: false });
    dump("tcopps-03-existing-case");
  });

  it("04 sync did not finish", async () => {
    oppApi.listOpportunities.mockResolvedValue(
      list(ROLAND.slice(0, 2), {
        sync: { ...SYNC_OK, lastStatus: "partial", lastAttemptAt: "2026-10-09T07:44:00.000Z", lastError: "OD_READ_FAILED" },
      }),
    );
    render(
      <Page>
        <OpportunitiesInbox offices={["roland"]} showOfficeBadges={false} />
      </Page>,
    );
    await screen.findByText("Test 2, Stedi");
    dump("tcopps-04-sync-partial");
  });

  it("05 dashboard card", async () => {
    oppApi.listOpportunities.mockImplementation((office: string) =>
      Promise.resolve(office === "roland" ? list(ROLAND) : list(VALLEY)),
    );
    render(
      <div className="p-6 max-w-7xl mx-auto space-y-4">
        <OpportunitiesCard offices={["roland", "valley"]} />
      </div>,
    );
    await screen.findByText(/diagnosed and not on the schedule/);
    dump("tcopps-05-dashboard-card@1280x300");
  });
});
