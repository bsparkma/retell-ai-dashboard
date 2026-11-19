/**
 * The "Move to…" menu on the hub's CARDS (referral-card-move-button; follow-up
 * to referral-manual-moves #346). Frontend only.
 *
 *  - every card offers exactly the panel menu's actions for this viewer and
 *    status (hubActionPlan) — none when there are none, and none at all for a
 *    doctor / sign-off-only viewer;
 *  - the card is still its own click target: the Move button is a sibling,
 *    opening the menu never opens the detail, clicking the card still does;
 *  - same confirm step + optional note (mark sent: required), same routes as
 *    the panel — pinned: the card and the panel make the identical call;
 *  - a stale card's refusal shows the server's words (where it stands now)
 *    with a Refresh that re-reads the list;
 *  - "Edit (re-approval needed)" opens the panel straight into the reopen edit.
 *
 * NO NETWORK (the referrals API is mocked whole), NO PHI (synthetic 12827 roland).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TcReferral, TcReferralStatus } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: { isSuperAdmin: boolean; permissions: string[]; role: string } };

const { toastMock, ref, state } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralsStatus: vi.fn(),
    getReferralSettings: vi.fn(),
    listDirectory: vi.fn(),
    listHub: vi.fn(),
    getReferral: vi.fn(),
    editReferralFields: vi.fn(),
    reopenReferral: vi.fn(),
    markReferral: vi.fn(),
    referralVerb: vi.fn(),
    sendReferralEmail: vi.fn(),
    deleteReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    listSignoffQueue: vi.fn(),
    getSignoffReferral: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    returnReferral: vi.fn(),
    listSignoffDirectory: vi.fn(),
    doctorEditReferral: vi.fn(),
    verbalSignoff: vi.fn(),
  },
  state: {
    auth: { status: "loading" } as AuthState,
    search: "",
    scope: { offices: ["roland"] as string[], loading: false, showOfficeBadges: false },
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/providers/providersApi", () => ({
  listActiveProviders: vi.fn(async () => []),
  listSignoffProviders: vi.fn(async () => []),
}));
vi.mock("@/contexts/AuthContext", async (orig) => ({
  ...(await orig<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => state.auth,
}));
vi.mock("wouter", async (importOriginal) => {
  const real = await importOriginal<typeof import("wouter")>();
  return { ...real, useSearch: () => state.search };
});
vi.mock("@/features/tc/components/TcShell", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/components/TcShell")>()),
  useTcOffice: () => "roland",
}));
vi.mock("@/features/tc/officeScope", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/officeScope")>();
  return { ...real, useTcOfficeScope: () => state.scope };
});

import TcReferralsHub, { CardMove, HubDetail, runHubMove } from "@/pages/tc/TcReferralsHub";
import { hubActionPlan, type HubViewer } from "@/features/tc/referrals/hubActions";
import { TcApiError } from "@/features/tc/api";
import { TcReferralStatus as Statuses } from "@shared/tc/referrals";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";

const TC: HubViewer = { tcFull: true, signoff: false };
const ADMIN: HubViewer = { tcFull: true, signoff: true };
const DOCTOR: HubViewer = { tcFull: false, signoff: true };
const PERMS = { tc: ["voice.read", "tc.full", "tc.hygiene"] };

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: RID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "case",
    sourceRef: "",
    referringProvider: "DOC1",
    directoryEntryId: null,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "",
    status: "draft",
    statusChangedAt: "2026-11-18T15:01:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-11-18T15:00:00.000Z",
    updatedAt: "2026-11-18T15:01:00.000Z",
    doctorNote: null,
    returned: null,
    attachmentCount: 0,
    events: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = { status: "authenticated", user: { isSuperAdmin: false, permissions: PERMS.tc, role: "tc" } };
  state.search = "";
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.getReferralSettings.mockRejectedValue(new Error("not mocked"));
  ref.listDirectory.mockResolvedValue([]);
  ref.listReferralAttachments.mockResolvedValue([]);
});
afterEach(cleanup);

function renderCard(r: TcReferral, viewer: HubViewer, signoffRequired: boolean | null = true) {
  const onDone = vi.fn();
  const onReopen = vi.fn();
  render(<CardMove office="roland" referral={r} viewer={viewer} signoffRequired={signoffRequired} onDone={onDone} onReopen={onReopen} />);
  return { onDone, onReopen };
}

// ── per role / status ───────────────────────────────────────────────────────

describe("the card's Move button, per role and status", () => {
  it("offers exactly the panel plan's actions for every status (tc and admin); none where the plan has none", () => {
    for (const viewer of [TC, ADMIN]) {
      for (const status of Statuses.options) {
        const plan = hubActionPlan(status, viewer, true);
        renderCard(referral({ status }), viewer);
        const trigger = screen.queryByTestId("tc-hub-card-move-menu");
        if (plan.actions.length === 0) {
          expect(trigger, `${status}: no button`).toBeNull();
        } else {
          expect(trigger, `${status}: a button`).toBeTruthy();
          expect(trigger?.getAttribute("aria-label")).toBe("Move this referral");
          fireEvent.click(trigger as HTMLElement);
          const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
          expect(items.map((i) => i.getAttribute("data-testid"))).toEqual(plan.actions.map((a) => `tc-hub-card-move-${a.verb}`));
        }
        cleanup();
      }
    }
  });

  it("a doctor / sign-off-only viewer gets no Move button on any card", () => {
    for (const status of Statuses.options) {
      renderCard(referral({ status }), DOCTOR);
      expect(screen.queryByTestId("tc-hub-card-moves")).toBeNull();
      cleanup();
    }
  });
});

// ── confirm + note, same routes ─────────────────────────────────────────────

describe("confirm step + note, and the routes", () => {
  it("submit from a draft card: confirm, optional note, then the verb route with the note; the list re-reads", async () => {
    ref.referralVerb.mockResolvedValue(referral({ status: "pending_signoff" }));
    const { onDone } = renderCard(referral(), TC);
    fireEvent.click(screen.getByTestId("tc-hub-card-move-menu"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-submit"));
    const confirm = screen.getByTestId("tc-hub-card-move-confirm");
    expect(ref.referralVerb).not.toHaveBeenCalled();
    fireEvent.change(within(confirm).getByLabelText("Note for the history (optional)"), { target: { value: "Ready for review" } });
    fireEvent.click(within(confirm).getByTestId("tc-hub-card-move-go"));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", RID, "submit", "Ready for review"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(toastMock.success).toHaveBeenCalledWith("Sent for the doctor's sign-off");
  });

  it("Back at the confirm calls nothing; mark sent needs its how / where", async () => {
    ref.markReferral.mockResolvedValue(referral({ status: "sent" }));
    renderCard(referral({ status: "approved" }), TC);
    fireEvent.click(screen.getByTestId("tc-hub-card-move-menu"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-mark_sent"));
    const confirm = screen.getByTestId("tc-hub-card-move-confirm");
    const go = within(confirm).getByTestId("tc-hub-card-move-go") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(within(confirm).getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("tc-hub-card-move-confirm")).toBeNull();
    fireEvent.click(screen.getByTestId("tc-hub-card-move-menu"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-mark_sent"));
    fireEvent.change(screen.getByLabelText("How and where was it sent? *"), { target: { value: "Faxed to their front desk" } });
    fireEvent.click(screen.getByTestId("tc-hub-card-move-go"));
    await waitFor(() => expect(ref.markReferral).toHaveBeenCalledWith("roland", RID, "mark_sent", "Faxed to their front desk"));
    expect(ref.referralVerb).not.toHaveBeenCalled();
  });

  it("PIN: the card and the panel make the identical call for the same move", async () => {
    ref.referralVerb.mockResolvedValue(referral({ status: "cancelled" }));
    // The card.
    renderCard(referral({ status: "pending_signoff" }), TC);
    fireEvent.click(screen.getByTestId("tc-hub-card-move-menu"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-cancel"));
    fireEvent.change(screen.getByLabelText("Note for the history (optional)"), { target: { value: "Patient went elsewhere" } });
    fireEvent.click(screen.getByTestId("tc-hub-card-move-go"));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledTimes(1));
    const fromCard = ref.referralVerb.mock.calls[0];
    cleanup();
    // The panel.
    ref.getReferral.mockResolvedValue(referral({ status: "pending_signoff" }));
    render(<HubDetail office="roland" referralId={RID} onClose={() => undefined} onChanged={() => undefined} viewer={TC} signoffRequired />);
    const panel = await screen.findByTestId("tc-hub-detail");
    fireEvent.click(await within(panel).findByTestId("tc-hub-move-menu"));
    fireEvent.click(within(panel).getByTestId("tc-hub-move-cancel"));
    fireEvent.change(within(panel).getByLabelText("Note for the history (optional)"), { target: { value: "Patient went elsewhere" } });
    fireEvent.click(within(panel).getByTestId("tc-hub-move-go"));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledTimes(2));
    expect(ref.referralVerb.mock.calls[1]).toEqual(fromCard);
    expect(fromCard).toEqual(["roland", RID, "cancel", "Patient went elsewhere"]);
  });

  it("runHubMove: marks to the mark route, the rest to the verb route (note only when given); reopen is never a move", async () => {
    ref.markReferral.mockResolvedValue(referral());
    ref.referralVerb.mockResolvedValue(referral());
    await runHubMove("roland", RID, { verb: "close", to: "closed" }, "");
    expect(ref.markReferral).toHaveBeenCalledWith("roland", RID, "close", "");
    await runHubMove("roland", RID, { verb: "withdraw", to: "draft" }, "");
    expect(ref.referralVerb).toHaveBeenLastCalledWith("roland", RID, "withdraw");
    await expect(runHubMove("roland", RID, { verb: "reopen", to: "pending_signoff" }, "")).rejects.toThrow();
  });
});

// ── stale card ──────────────────────────────────────────────────────────────

describe("a stale card", () => {
  it("shows the server's 'where it stands now' refusal with a Refresh that re-reads the list", async () => {
    ref.referralVerb.mockRejectedValue(
      new TcApiError("This referral cannot be submitted: it is pending dr. sign-off.", 409, "REFERRAL_TRANSITION_NOT_ALLOWED", null, []),
    );
    const { onDone } = renderCard(referral(), TC);
    fireEvent.click(screen.getByTestId("tc-hub-card-move-menu"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-submit"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-go"));
    const err = await screen.findByTestId("tc-hub-card-move-error");
    expect(err.textContent).toContain("This referral cannot be submitted: it is pending dr. sign-off.");
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(within(err).getByRole("button", { name: /Refresh/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("tc-hub-card-move-error")).toBeNull();
  });
});

// ── on the page ─────────────────────────────────────────────────────────────

async function hubWith(...rows: TcReferral[]) {
  ref.listHub.mockResolvedValue(rows);
  render(<TcReferralsHub />);
  await screen.findByTestId("tc-hub-groups");
  return screen.findAllByTestId("tc-hub-card");
}

describe("on the hub page", () => {
  it("the Move button is a separate target: opening its menu does not open the card; clicking the card still does", async () => {
    const [card] = await hubWith(referral());
    const moves = await screen.findByTestId("tc-hub-card-moves");
    // A sibling of the card button, never inside it.
    expect(card.contains(moves)).toBe(false);
    fireEvent.click(within(moves).getByTestId("tc-hub-card-move-menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(ref.getReferral).not.toHaveBeenCalled();
    ref.getReferral.mockResolvedValue(referral());
    fireEvent.click(card);
    await waitFor(() => expect(ref.getReferral).toHaveBeenCalledWith("roland", RID));
  });

  it("a move from a card re-reads the list", async () => {
    await hubWith(referral());
    const before = ref.listHub.mock.calls.length;
    ref.referralVerb.mockResolvedValue(referral({ status: "pending_signoff" }));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-menu"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-submit"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-go"));
    await waitFor(() => expect(ref.listHub.mock.calls.length).toBeGreaterThan(before));
  });

  it("'Edit (re-approval needed)' on an approved card opens the panel straight into the reopen edit", async () => {
    const approved = referral({ status: "approved" as TcReferralStatus });
    await hubWith(approved);
    ref.getReferral.mockResolvedValue(approved);
    fireEvent.click(screen.getByTestId("tc-hub-card-move-menu"));
    fireEvent.click(screen.getByTestId("tc-hub-card-move-reopen"));
    const panel = await screen.findByTestId("tc-hub-detail");
    expect(await within(panel).findByTestId("referral-fields-form")).toBeTruthy();
    expect(ref.reopenReferral).not.toHaveBeenCalled();
  });
});
