/**
 * Pre-IA fix F5 (docs/reports/feature-tc-incoming-work-ia.md §4 D4, §7):
 * the sign-off page fans out across offices and honours ?office= like
 * Checkout does.
 *
 * Sign-off-in-hub: the page is gone; these pins now hold for the Referrals
 * hub's sign-off view (what a doctor gets at /tc/referrals), and the alert
 * links into it.
 *
 * Before: the nav badge counted every office in scope, but on "All offices"
 * the page asked to pick one; and the alert's ?office= was ignored.
 *
 *   - "All offices" lists every office's referrals, badged, oldest first;
 *   - a referral is read and approved in the office it was LISTED from;
 *   - one office failing shows the other's rows and says what is missing;
 *   - ?office=&referral= opens that referral — only for an office in scope;
 *   - the alert links there.
 *
 * No PHI: the patients are the synthetic fixtures.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const state = vi.hoisted(() => ({
  search: "",
  navigated: [] as string[],
  scope: { offices: ["roland", "valley"] as string[], loading: false, showOfficeBadges: true },
}));

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: Object.assign(toastMock, { success: vi.fn(), error: vi.fn() }) }));

vi.mock("wouter", async (importOriginal) => {
  const real = await importOriginal<typeof import("wouter")>();
  return {
    ...real,
    useSearch: () => state.search,
    useLocation: () => ["/tc/referrals", (to: string) => state.navigated.push(to)],
  };
});

// A doctor: tc.referral_signoff and nothing else.
vi.mock("@/contexts/AuthContext", async (orig) => ({
  ...(await orig<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ status: "authenticated", user: { isSuperAdmin: false, permissions: ["tc.referral_signoff"], role: "doctor" } }),
}));

vi.mock("@/features/tc/officeScope", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/officeScope")>();
  return { ...real, useTcOfficeScope: () => state.scope };
});

const ref = vi.hoisted(() => ({
  listSignoffQueue: vi.fn(),
  getSignoffReferral: vi.fn(),
  listReferralAttachments: vi.fn(),
  approveReferral: vi.fn(),
  getSignoffSummary: vi.fn(),
}));
vi.mock("@/features/tc/referrals/referralsApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/referrals/referralsApi")>();
  return { ...real, ...ref };
});

import TcReferralsHub from "@/pages/tc/TcReferralsHub";
import { useSignoffWatch } from "@/features/tc/referrals/useSignoffWatch";
import type { TcReferral } from "@shared/tc/referrals";

const ROLAND_ID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const VALLEY_ID = "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8";

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: ROLAND_ID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "hyg_visit",
    sourceRef: "visit-1",
    referringProvider: "DOC1",
    directoryEntryId: null,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "",
    status: "pending_signoff",
    statusChangedAt: "2026-10-22T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-22T14:00:00.000Z",
    updatedAt: "2026-10-22T15:00:00.000Z",
    ...over,
  };
}

const VALLEY = referral({
  referralId: VALLEY_ID,
  officeId: "valley",
  odPatientId: 7115,
  patientName: "Stedi TestValley",
  practiceName: "Valley Oral Surgery",
  // Older than Roland's: it must sort first across the merge.
  statusChangedAt: "2026-10-22T13:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  state.search = "";
  state.navigated = [];
  state.scope = { offices: ["roland", "valley"], loading: false, showOfficeBadges: true };
  ref.listSignoffQueue.mockImplementation(async (o: string) => (o === "roland" ? [referral()] : [VALLEY]));
  ref.getSignoffReferral.mockImplementation(async (o: string, id: string) =>
    id === VALLEY_ID ? { ...VALLEY, officeId: o } : referral({ officeId: o as "roland" }),
  );
  ref.listReferralAttachments.mockResolvedValue([]);
  ref.approveReferral.mockImplementation(async (_o: string, id: string) =>
    id === VALLEY_ID ? { ...VALLEY, status: "approved" } : referral({ status: "approved" }),
  );
});
afterEach(cleanup);

describe("F5: the hub's sign-off view fans out across offices", () => {
  it("on All offices it lists every office's referrals, badged, oldest first — no 'pick an office'", async () => {
    render(<TcReferralsHub />);
    const rows = await screen.findAllByTestId("tc-hub-signoff-row");
    expect(ref.listSignoffQueue).toHaveBeenCalledWith("roland");
    expect(ref.listSignoffQueue).toHaveBeenCalledWith("valley");
    expect(rows.map((r) => within(r).getByText(/Stedi/).textContent)).toEqual(["Stedi TestValley", "Test 2, Stedi"]);
    expect(rows.every((r) => within(r).queryByTestId("office-badge") !== null)).toBe(true);
  });

  it("a referral is opened and approved in the office it was listed from", async () => {
    render(<TcReferralsHub />);
    const rows = await screen.findAllByTestId("tc-hub-signoff-row");
    fireEvent.click(rows[0] as HTMLElement); // Valley's
    await screen.findByTestId("tc-hub-detail");
    expect(ref.getSignoffReferral).toHaveBeenCalledWith("valley", VALLEY_ID);
    fireEvent.click(await screen.findByTestId("tc-hub-approve"));
    // A doctor cannot read the auto-send policy, so Approve asks first.
    fireEvent.click(screen.getByTestId("tc-hub-approve-confirmed"));
    await waitFor(() => expect(ref.approveReferral).toHaveBeenCalledWith("valley", VALLEY_ID));
    expect(ref.approveReferral).not.toHaveBeenCalledWith("roland", expect.anything());
  });

  it("one office failing still shows the other's rows, and says which office is missing", async () => {
    ref.listSignoffQueue.mockImplementation(async (o: string) => {
      if (o === "valley") throw new Error("Valley is unreachable");
      return [referral()];
    });
    render(<TcReferralsHub />);
    const rows = await screen.findAllByTestId("tc-hub-signoff-row");
    expect(rows).toHaveLength(1);
    expect(await screen.findByText(/Showing partial data/)).toBeTruthy();
  });

  it("one office in scope: one fetch, no badges", async () => {
    state.scope = { offices: ["roland"], loading: false, showOfficeBadges: false };
    render(<TcReferralsHub />);
    const rows = await screen.findAllByTestId("tc-hub-signoff-row");
    expect(ref.listSignoffQueue).toHaveBeenCalledTimes(1);
    expect(within(rows[0] as HTMLElement).queryByTestId("office-badge")).toBeNull();
  });
});

describe("F5: ?office= is honoured, like Checkout", () => {
  it("?office=valley&referral=<id> opens that referral in Valley", async () => {
    state.search = `office=valley&referral=${VALLEY_ID}`;
    render(<TcReferralsHub />);
    await screen.findByTestId("tc-hub-detail");
    expect(ref.getSignoffReferral).toHaveBeenCalledWith("valley", VALLEY_ID);
  });

  it("an office outside the scope is ignored — nothing is opened", async () => {
    state.scope = { offices: ["roland"], loading: false, showOfficeBadges: false };
    state.search = `office=valley&referral=${VALLEY_ID}`;
    render(<TcReferralsHub />);
    await screen.findAllByTestId("tc-hub-signoff-row");
    expect(ref.getSignoffReferral).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tc-hub-detail")).toBeNull();
  });

  it("the sign-off alert links to the referral it announces, in the hub's sign-off view", async () => {
    const summary = (newest: { referralId: string; patientName: string; at: string } | null) => ({
      success: true as const,
      office: "valley" as const,
      enabled: true,
      waiting: newest ? 1 : 0,
      newest,
    });
    ref.getSignoffSummary.mockResolvedValue(summary(null));
    renderHook(() => useSignoffWatch(["valley"], false));
    await waitFor(() => expect(ref.getSignoffSummary).toHaveBeenCalledTimes(1));
    ref.getSignoffSummary.mockResolvedValue(
      summary({ referralId: VALLEY_ID, patientName: "Stedi TestValley", at: "2026-10-22T16:00:00.000Z" }),
    );
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const opts = toastMock.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    opts.action.onClick();
    expect(state.navigated).toEqual([`/tc/referrals?view=signoff&office=valley&referral=${VALLEY_ID}`]);
  });
});
