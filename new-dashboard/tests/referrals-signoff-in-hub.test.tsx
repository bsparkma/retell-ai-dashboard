/**
 * Sign-off in the Referrals hub (Beau's ruling: the separate "Awaiting
 * sign-off" page goes away; sign-off happens inside the hub).
 *
 * Every behaviour the retired TcReferralSignoff page pinned is pinned here on
 * its new home (the hub panel, or the hub's sign-off view) — see the mapping
 * table in docs/reports/feature-referral-signoff-in-hub.md. Plus the new
 * invariants:
 *  - approve / decline / send back are drawn ONLY for a tc.referral_signoff
 *    holder, only on a referral awaiting sign-off, and call the EXISTING
 *    sign-off routes in the referral's own office;
 *  - Approve asks first wherever approving may email the specialist (policy on,
 *    or unreadable — a doctor cannot read it); only a policy read as off
 *    approves in one click;
 *  - a doctor reaches /tc/referrals (sign-off view by default) without any
 *    server permission changing, and never touches a tc.full route or gets a
 *    staff-only control;
 *  - nothing is decided while /auth/me is in flight;
 *  - the old path redirects to the sign-off view, keeping the deep link.
 *
 * NO NETWORK, NO BACKEND (the referrals API is mocked whole), NO PHI (the
 * synthetic fixtures 12827 roland and 7115 valley).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TcReferral, TcReferralAttachment } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: { isSuperAdmin: boolean; permissions: string[]; role: string } };

const { toastMock, ref, state } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    // tc.full routes — a doctor must never reach these.
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
    // shared (the `signoff` flag picks the route)
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    // the sign-off routes
    listSignoffQueue: vi.fn(),
    getSignoffReferral: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    returnReferral: vi.fn(),
    listSignoffDirectory: vi.fn(),
    doctorEditReferral: vi.fn(),
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

import TcReferralsHub, { HubCard, HubDetail, HubSignoffView } from "@/pages/tc/TcReferralsHub";
import { signoffRedirectTarget } from "@/pages/tc/TcReferralSignoffRedirect";
import { SIGNOFF_AUTOSEND_ON_COPY, SIGNOFF_AUTOSEND_UNKNOWN_COPY } from "@/features/tc/referrals/SignoffActions";
import { HUB_SIGNOFF_WAITING_COPY, type HubViewer } from "@/features/tc/referrals/hubActions";
import { ROLE_HOME, canVisit } from "@/lib/permissions";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const ENTRY = "5a1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const NOW = new Date("2026-10-27T15:00:00.000Z");

const DOCTOR: HubViewer = { tcFull: false, signoff: true };
const ADMIN: HubViewer = { tcFull: true, signoff: true };
const TC: HubViewer = { tcFull: true, signoff: false };

const PERMS = {
  doctor: ["tc.referral_signoff"],
  tc: ["voice.read", "tc.full", "tc.hygiene"],
  admin: ["tc.full", "tc.referral_signoff", "admin.all"],
};

function signedIn(permissions: string[], role = "tc"): AuthState {
  return { status: "authenticated", user: { isSuperAdmin: false, permissions, role } };
}

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
    directoryEntryId: ENTRY,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "Sensitive to biting",
    status: "pending_signoff",
    statusChangedAt: "2026-10-16T15:01:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-16T15:00:00.000Z",
    updatedAt: "2026-10-16T15:01:00.000Z",
    doctorNote: null,
    returned: null,
    attachmentCount: 0,
    events: [],
    ...over,
  };
}

function attachment(over: Partial<TcReferralAttachment> = {}): TcReferralAttachment {
  return {
    attachmentId: "a1c2d3e4-4f50-4a61-8b72-938495a6b7c8",
    referralId: RID,
    fileName: "pa-3.png",
    contentType: "image/png",
    sizeBytes: 2048,
    uploadedBy: "tc@carein.ai",
    uploadedAt: "2026-10-16T15:00:30.000Z",
    ...over,
  };
}

function png(): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "xray-2.png", { type: "image/png" });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = signedIn(PERMS.doctor, "doctor");
  state.search = "";
  state.scope = { offices: ["roland"], loading: false, showOfficeBadges: false };
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listDirectory.mockResolvedValue([]);
  ref.listHub.mockResolvedValue([]);
  ref.listSignoffDirectory.mockResolvedValue([]);
  ref.listReferralAttachments.mockResolvedValue([]);
  ref.getReferralSettings.mockRejectedValue(new Error("not mocked"));
});
afterEach(cleanup);

/** Nothing the doctor may not do was asked of the server. */
function expectNoTcFullCall() {
  for (const fn of [
    ref.getReferralsStatus,
    ref.getReferralSettings,
    ref.listDirectory,
    ref.listHub,
    ref.getReferral,
    ref.editReferralFields,
    ref.reopenReferral,
    ref.markReferral,
    ref.referralVerb,
    ref.sendReferralEmail,
  ]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

// ── the sign-off view (what the doctor uses) ────────────────────────────────

async function openInView(detail: TcReferral, viewer: HubViewer = DOCTOR) {
  ref.listSignoffQueue.mockResolvedValue([detail]);
  ref.getSignoffReferral.mockResolvedValue(detail);
  render(<HubSignoffView offices={["roland"]} showOfficeBadges={false} viewer={viewer} />);
  fireEvent.click(await screen.findByTestId("tc-hub-signoff-row"));
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByTestId("tc-hub-signoff-actions");
  return panel;
}

describe("the sign-off view: queue → panel → the doctor's moves (old R2 page pins)", () => {
  it("queue → panel with history → Approve asks (policy unreadable for a doctor) → the honest ready-to-send line", async () => {
    const pending = referral({
      events: [
        { eventId: "3b1c2d3e-4f50-4a61-8b72-938495a6b7c8", fromStatus: null, toStatus: "draft", actor: "tc@carein.ai", at: "2026-10-16T15:00:00.000Z", note: "", verb: null },
        { eventId: "4b1c2d3e-4f50-4a61-8b72-938495a6b7c8", fromStatus: "draft", toStatus: "pending_signoff", actor: "tc@carein.ai", at: "2026-10-16T15:01:00.000Z", note: "", verb: null },
      ],
    });
    const panel = await openInView(pending);
    ref.listSignoffQueue.mockResolvedValue([]);
    expect(within(panel).getByText("Sensitive to biting")).toBeTruthy();
    const history = within(panel).getByTestId("referral-timeline");
    expect(history.textContent).toMatch(/Pending Dr\. sign-off/);
    expect(history.textContent).toMatch(/tc@carein\.ai/);

    ref.approveReferral.mockResolvedValue(referral({ status: "approved" }));
    fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
    expect(within(panel).getByTestId("tc-hub-approve-confirm").textContent).toBe(SIGNOFF_AUTOSEND_UNKNOWN_COPY);
    expect(ref.approveReferral).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByTestId("tc-hub-approve-confirmed"));
    await waitFor(() => expect(ref.approveReferral).toHaveBeenCalledWith("roland", RID));
    expect((await screen.findByTestId("tc-hub-signoff-done")).textContent).toContain("Ready to send — sending ships in a later update.");
    expect(await screen.findByTestId("tc-hub-signoff-empty")).toBeTruthy();
    expectNoTcFullCall();
  });

  it("Decline needs a reason before it can be pressed, and goes to the decline route", async () => {
    const panel = await openInView(referral());
    ref.declineReferral.mockResolvedValue(referral({ status: "declined" }));
    fireEvent.click(within(panel).getByRole("button", { name: /Decline/ }));
    const confirm = within(panel).getByRole("button", { name: "Decline referral" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText("Why decline?"), { target: { value: "Treat in house first" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(ref.declineReferral).toHaveBeenCalledWith("roland", RID, "Treat in house first"));
    expect(ref.approveReferral).not.toHaveBeenCalled();
  });

  it("an empty queue says so", async () => {
    ref.listSignoffQueue.mockResolvedValue([]);
    render(<HubSignoffView offices={["roland"]} showOfficeBadges={false} viewer={DOCTOR} />);
    expect((await screen.findByTestId("tc-hub-signoff-empty")).textContent).toContain("Nothing is waiting");
  });

  it("oldest first, whatever order the server's rows arrive in", async () => {
    ref.listSignoffQueue.mockResolvedValue([
      referral({ referralId: "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8", patientName: "Test, MangoTest", statusChangedAt: "2026-10-18T15:00:00.000Z" }),
      referral({ statusChangedAt: "2026-10-16T15:00:00.000Z" }),
    ]);
    render(<HubSignoffView offices={["roland"]} showOfficeBadges={false} viewer={DOCTOR} />);
    const rows = await screen.findAllByTestId("tc-hub-signoff-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Test 2, Stedi"), expect.stringContaining("Test, MangoTest")]);
  });
});

describe("the sign-off view: files at sign-off (old R4 / R6.2 page pins)", () => {
  it("lists and views the X-ray through the sign-off route", async () => {
    ref.listReferralAttachments.mockResolvedValue([attachment()]);
    ref.openReferralAttachment.mockResolvedValue("blob:fake-url");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const panel = await openInView(referral());
    fireEvent.click(await within(panel).findByRole("button", { name: "View pa-3.png" }));
    expect(ref.listReferralAttachments).toHaveBeenCalledWith("roland", RID, true);
    await waitFor(() => expect(ref.openReferralAttachment).toHaveBeenCalledWith("roland", RID, attachment().attachmentId, true));
    open.mockRestore();
  });

  it("while editing: Add files, through the sign-off route; the list is re-read from it", async () => {
    ref.listReferralAttachments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([attachment({ attachmentId: "a2c2d3e4-4f50-4a61-8b72-938495a6b7c8", fileName: "xray-2.png", uploadedBy: "doctor@carein.ai" })]);
    const panel = await openInView(referral());
    expect(within(panel).queryByTestId("referral-add-attachments")).toBeNull(); // not until Edit
    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    const add = await within(panel).findByTestId("referral-add-attachments");
    const file = png();
    fireEvent.change(within(add).getByTestId("referral-attachment-input"), { target: { files: [file] } });
    ref.uploadReferralAttachment.mockResolvedValue(attachment({ fileName: "xray-2.png" }));
    fireEvent.click(within(add).getByRole("button", { name: "Attach file" }));
    await waitFor(() => expect(ref.uploadReferralAttachment).toHaveBeenCalledWith("roland", RID, file, true));
    await waitFor(() => expect(ref.listReferralAttachments).toHaveBeenLastCalledWith("roland", RID, true));
    expect(await within(panel).findByText("xray-2.png")).toBeTruthy();
    expect(ref.approveReferral).not.toHaveBeenCalled();
    expect(ref.sendReferralEmail).not.toHaveBeenCalled();
  });
});

describe("the sign-off view: the doctor's edit and send back (old R6 page pins)", () => {
  it("the doctor edits fields and their own note; Approve waits; the panel shows what the server stored", async () => {
    const p = referral();
    const panel = await openInView(p);
    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    const form = await within(panel).findByTestId("referral-fields-form");
    await waitFor(() => expect(ref.listSignoffDirectory).toHaveBeenCalledWith("roland"));
    expect(ref.listDirectory).not.toHaveBeenCalled(); // the directory route is tc.full
    expect((within(panel).getByTestId("tc-hub-approve") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Doctor's note"), { target: { value: "Please see within the week." } });
    fireEvent.change(within(form).getByLabelText("How soon"), { target: { value: "urgent" } });
    ref.doctorEditReferral.mockResolvedValue({ ...p, urgency: "urgent", doctorNote: "Please see within the week." });
    fireEvent.click(within(form).getByRole("button", { name: /Save changes/ }));
    await waitFor(() =>
      expect(ref.doctorEditReferral).toHaveBeenCalledWith("roland", RID, { urgency: "urgent", doctorNote: "Please see within the week." }),
    );
    expect((await within(panel).findByTestId("tc-hub-detail-doctor-note")).textContent).toBe("Please see within the week.");
    expect((within(panel).getByTestId("tc-hub-approve") as HTMLButtonElement).disabled).toBe(false);
    expectNoTcFullCall();
  });

  it("send back with a question: the question is required, and it goes back as a draft", async () => {
    const p = referral();
    const panel = await openInView(p);
    fireEvent.click(within(panel).getByRole("button", { name: /Send back with a question/ }));
    const send = within(panel).getByRole("button", { name: "Send back" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText("What do you need from them?"), { target: { value: "Which tooth — 3 or 14?" } });
    ref.returnReferral.mockResolvedValue({ ...p, status: "draft" });
    ref.listSignoffQueue.mockResolvedValue([]);
    fireEvent.click(send);
    await waitFor(() => expect(ref.returnReferral).toHaveBeenCalledWith("roland", RID, "Which tooth — 3 or 14?"));
    expect((await screen.findByTestId("tc-hub-signoff-done")).textContent).toContain("sent back with your question");
    expect(ref.approveReferral).not.toHaveBeenCalled();
  });
});

describe("the sign-off view: what the approval did (old R5 page pins)", () => {
  async function approveWith(answer: TcReferral) {
    const panel = await openInView(referral({ specialistEmail: "referrals@endo.example.test" }));
    ref.listSignoffQueue.mockResolvedValue([]);
    ref.approveReferral.mockResolvedValue(answer);
    fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
    fireEvent.click(within(panel).getByTestId("tc-hub-approve-confirmed"));
    return screen.findByTestId("tc-hub-signoff-done");
  }

  it("auto-sent: says it was emailed", async () => {
    const done = await approveWith(referral({ status: "sent" }));
    expect(done.textContent).toContain("Emailed to River Endodontics.");
    expect(toastMock.success).toHaveBeenCalledWith("Approved and emailed to River Endodontics.");
  });

  it("auto-send failed: approved, and says the email did not go out", async () => {
    const done = await approveWith(
      referral({ status: "approved", sendProblem: { kind: "failed", note: "Not sent automatically: busy.", actor: "doctor@carein.ai", at: NOW.toISOString() } }),
    );
    expect(done.textContent).toContain("approved.");
    expect(done.textContent).toContain("The automatic email did not go out");
    expect(String(toastMock.error.mock.calls[0]?.[0])).toMatch(/^Approved — but the automatic email did not go out\. Not sent automatically: busy\./);
  });
});

describe("the sign-off view gives a doctor no staff-only ability", () => {
  it("no submit / withdraw / cancel / staff edit / mark / send — and no tc.full route is asked", async () => {
    const panel = await openInView(referral());
    for (const id of ["tc-hub-submit", "tc-hub-withdraw", "tc-hub-cancel", "tc-hub-mark", "tc-hub-send", "tc-hub-moves"]) {
      expect(within(panel).queryByTestId(id), id).toBeNull();
    }
    // The only Edit is the doctor's (it carries the doctor's note).
    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    expect(await within(panel).findByLabelText("Doctor's note")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New referral/ })).toBeNull();
    expectNoTcFullCall();
  });

  it("an admin also holding tc.full: the policy is read, and a policy READ as off approves in one click", async () => {
    ref.getReferralSettings.mockResolvedValue({
      success: true,
      office: "roland",
      signoffRequired: { value: true, source: "default" },
      autosendOnApproval: { value: false, source: "default" },
      canEdit: true,
    });
    const panel = await openInView(referral(), ADMIN);
    await waitFor(() => expect(ref.getReferralSettings).toHaveBeenCalledWith("roland"));
    ref.approveReferral.mockResolvedValue(referral({ status: "approved" }));
    ref.listSignoffQueue.mockResolvedValue([]);
    await waitFor(() => {
      fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
      expect(ref.approveReferral).toHaveBeenCalledWith("roland", RID);
    });
    expect(screen.queryByTestId("tc-hub-approve-confirm")).toBeNull();
  });
});

// ── the hub's own panel (tc.full reader) ────────────────────────────────────

async function openInHub(detail: TcReferral, viewer: HubViewer, autosend: boolean | null) {
  ref.getReferral.mockResolvedValue(detail);
  render(
    <HubDetail office="roland" referralId={detail.referralId} onClose={() => undefined} onChanged={() => undefined} viewer={viewer} signoffRequired autosend={autosend} />,
  );
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByTestId("tc-hub-actions");
  return panel;
}

describe("sign-off inside the hub panel", () => {
  it("a signoff holder gets Approve, Decline and Send back next to the TC's moves; the call is the sign-off route", async () => {
    const panel = await openInHub(referral(), ADMIN, false);
    expect(within(panel).getByTestId("tc-hub-signoff-actions")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Decline/ })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Send back with a question/ })).toBeTruthy();
    // The TC side's moves are still there for an admin, unchanged.
    expect(within(panel).getByTestId("tc-hub-withdraw")).toBeTruthy();
    // tc.full: the staff edit is the edit offered, not a second (doctor's) one.
    expect(within(panel).getAllByRole("button", { name: /^Edit$/ })).toHaveLength(1);
    ref.approveReferral.mockResolvedValue(referral({ status: "approved" }));
    fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
    await waitFor(() => expect(ref.approveReferral).toHaveBeenCalledWith("roland", RID));
    await waitFor(() => expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Approved"));
    expect(ref.referralVerb).not.toHaveBeenCalled();
    expect(ref.sendReferralEmail).not.toHaveBeenCalled();
  });

  it("without tc.referral_signoff: 'Waiting for the doctor's sign-off' and none of the doctor's moves", async () => {
    const panel = await openInHub(referral(), TC, true);
    expect(within(panel).queryByTestId("tc-hub-signoff-actions")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Approve|Decline|Send back/ })).toBeNull();
    expect(within(panel).getByTestId("tc-hub-move-notes").textContent).toBe(HUB_SIGNOFF_WAITING_COPY);
  });

  it("auto-send ON: Approve asks 'approving will email the specialist now' before anything is called", async () => {
    const panel = await openInHub(referral(), ADMIN, true);
    fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
    expect(within(panel).getByTestId("tc-hub-approve-confirm").textContent).toBe(SIGNOFF_AUTOSEND_ON_COPY);
    expect(SIGNOFF_AUTOSEND_ON_COPY).toContain("approving will email the specialist now");
    expect(ref.approveReferral).not.toHaveBeenCalled();
    // Back leaves it as it was.
    fireEvent.click(within(panel).getByRole("button", { name: "Back" }));
    expect(within(panel).queryByTestId("tc-hub-approve-confirm")).toBeNull();
    expect(ref.approveReferral).not.toHaveBeenCalled();
    // Ask again, and go.
    fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
    ref.approveReferral.mockResolvedValue(referral({ status: "sent" }));
    fireEvent.click(within(panel).getByRole("button", { name: /Approve and email/ }));
    await waitFor(() => expect(ref.approveReferral).toHaveBeenCalledWith("roland", RID));
    expect(toastMock.success).toHaveBeenCalledWith("Approved and emailed to River Endodontics.");
  });

  it("the policy unread: Approve still asks, in words that do not claim to know", async () => {
    const panel = await openInHub(referral(), ADMIN, null);
    fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
    expect(within(panel).getByTestId("tc-hub-approve-confirm").textContent).toBe(SIGNOFF_AUTOSEND_UNKNOWN_COPY);
    expect(ref.approveReferral).not.toHaveBeenCalled();
  });

  it("a refused approval says the server's words and moves nothing", async () => {
    const panel = await openInHub(referral(), ADMIN, false);
    ref.approveReferral.mockRejectedValue(new Error("This referral cannot be approved: it is a draft."));
    fireEvent.click(within(panel).getByTestId("tc-hub-approve"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Pending Dr. sign-off");
  });

  it("no doctor's move on any other status, even for a signer", async () => {
    const panel = await openInHub(referral({ status: "approved" }), ADMIN, true);
    expect(within(panel).queryByTestId("tc-hub-signoff-actions")).toBeNull();
  });
});

// ── the page: who gets which view ───────────────────────────────────────────

describe("the page decides nothing until /auth/me answers", () => {
  it("while auth loads: a spinner, and no route of either kind is asked", async () => {
    state.auth = { status: "loading" };
    render(<TcReferralsHub />);
    expect(screen.getByTestId("tc-hub-auth-loading")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(ref.listSignoffQueue).not.toHaveBeenCalled();
    expectNoTcFullCall();
  });

  it("a doctor at /tc/referrals lands on the sign-off view, through the sign-off routes only", async () => {
    state.auth = signedIn(PERMS.doctor, "doctor");
    ref.listSignoffQueue.mockResolvedValue([referral()]);
    render(<TcReferralsHub />);
    expect(await screen.findByTestId("tc-hub-signoff-row")).toBeTruthy();
    expect(screen.queryByTestId("tc-hub-to-all")).toBeNull(); // no way into the tc.full hub
    expectNoTcFullCall();
  });

  it("a TC without sign-off gets the hub, even on ?view=signoff (an old link), and is never sent to a sign-off route", async () => {
    state.auth = signedIn(PERMS.tc);
    state.search = "view=signoff";
    render(<TcReferralsHub />);
    await screen.findByTestId("tc-hub-groups");
    expect(ref.listHub).toHaveBeenCalled();
    expect(ref.listSignoffQueue).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tc-hub-to-signoff")).toBeNull();
  });

  it("an admin gets the hub, with a way to the every-office sign-off view, and the view from ?view=signoff", async () => {
    state.auth = signedIn(PERMS.admin, "admin");
    render(<TcReferralsHub />);
    await screen.findByTestId("tc-hub-groups");
    expect(screen.getByTestId("tc-hub-to-signoff").getAttribute("href")).toBe("/tc/referrals?view=signoff");
    cleanup();
    state.search = "view=signoff";
    ref.listSignoffQueue.mockResolvedValue([]);
    render(<TcReferralsHub />);
    await screen.findByTestId("tc-hub-signoff-empty");
    expect(screen.getByTestId("tc-hub-to-all").getAttribute("href")).toBe("/tc/referrals");
  });
});

describe("the old path, the doctor's home and the route map", () => {
  it("/tc/referrals/signoff redirects to the sign-off view, keeping a deep link; a bogus office is dropped", () => {
    expect(signoffRedirectTarget("")).toBe("/tc/referrals?view=signoff");
    expect(signoffRedirectTarget(`office=valley&referral=${RID}`)).toBe(`/tc/referrals?view=signoff&office=valley&referral=${RID}`);
    expect(signoffRedirectTarget(`office=elsewhere&referral=${RID}`)).toBe("/tc/referrals?view=signoff");
  });

  it("the doctor's home is the sign-off view, and a doctor may open the hub's path but nothing else in TC", () => {
    expect(ROLE_HOME.doctor).toBe("/tc/referrals?view=signoff");
    expect(canVisit(PERMS.doctor, ROLE_HOME.doctor)).toBe(true);
    expect(canVisit(PERMS.doctor, "/tc/referrals")).toBe(true);
    expect(canVisit(PERMS.doctor, "/tc/referrals/signoff")).toBe(true);
    for (const p of ["/tc", "/tc/dashboard", "/tc/settings", "/tc/checkout", "/tc/cases/abc"]) {
      expect(canVisit(PERMS.doctor, p), p).toBe(false);
    }
    expect(canVisit(PERMS.tc, "/tc/referrals")).toBe(true);
    expect(canVisit(["tc.hygiene"], "/tc/referrals")).toBe(false);
    expect(canVisit(undefined, "/tc/referrals")).toBe(false);
  });
});

// ── fold-in: one "acknowledged", not two ────────────────────────────────────

describe("hub card: no 'Received' badge beside an Acknowledged status", () => {
  const received = { at: "2026-10-25T15:00:00.000Z", via: "link" as const };
  it("acknowledged: the age line says it, the Received badge is not repeated", () => {
    render(<HubCard referral={referral({ status: "acknowledged", received })} now={NOW} onOpen={() => undefined} />);
    expect(screen.getByTestId("tc-hub-age").textContent).toMatch(/^acknowledged /);
    expect(screen.queryByText("Received")).toBeNull();
  });
  it("sent (not yet acknowledged by status): the Received badge still shows", () => {
    render(<HubCard referral={referral({ status: "sent", received })} now={NOW} onOpen={() => undefined} />);
    expect(screen.getByText("Received")).toBeTruthy();
  });
});
