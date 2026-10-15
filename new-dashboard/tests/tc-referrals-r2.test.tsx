/**
 * Referrals R2 (queue item 53), in jsdom.
 *
 *  - ReferralsPanel on a case: lists referrals with their status; an approved
 *    one says honestly that nothing is sent yet; New referral validates
 *    (reason required, teeth 1–32) and sends no patient (the server derives
 *    it); Save & submit submits; draft / pending actions call their verbs.
 *  - ReferralsPanel in the checkout sidebar (compact): the chip goes live,
 *    and reads "None" with no Start button while referrals is off.
 *  - The sign-off page: queue → detail with history → Approve (ready-to-send
 *    copy) / Decline (needs a reason).
 *  - useSignoffWatch: the arrival alert obeys the `referral_signoff`
 *    preference; an unreadable preference (a doctor) falls back to a banner.
 *
 * With TC_SHOTS=1 it also dumps the sign-off page and the case panel
 * (tccheckout-09 / -10). NO NETWORK, NO BACKEND, NO PHI (test patient 12827).
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TcReferral, TcReferralSignoffSummary } from "@shared/tc/referrals";
import type { TcNotificationLevel, TcNotificationPrefsResponse } from "@shared/tc/notifications";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, chime, ref, state } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  chime: vi.fn(() => true),
  ref: {
    getReferralsStatus: vi.fn(),
    listDirectory: vi.fn(async () => []),
    listReferrals: vi.fn(),
    createReferral: vi.fn(),
    updateReferral: vi.fn(),
    referralVerb: vi.fn(),
    getSignoffSummary: vi.fn(),
    listSignoffQueue: vi.fn(),
    getSignoffReferral: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
  },
  state: { prefs: null as TcNotificationPrefsResponse | null, prefsFail: false },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/notifications/chime", () => ({ playChime: chime, resetChimeForTests: vi.fn() }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/notifications/notificationsApi", () => ({
  getNotificationPrefs: vi.fn(async () => {
    if (state.prefsFail) throw new Error("403");
    return state.prefs;
  }),
}));
vi.mock("@/features/tc/components/TcShell", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/components/TcShell")>()),
  useTcOffice: () => "roland",
}));

import { ReferralsPanel } from "@/features/tc/referrals/ReferralsPanel";
import { SignoffInner } from "@/pages/tc/TcReferralSignoff";
import { useSignoffWatch } from "@/features/tc/referrals/useSignoffWatch";

const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const HANDOFF_ID = "7a1c2d3e-4f50-4a61-8b72-938495a6b7c8";

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: CASE_ID,
    sourceKind: "case",
    sourceRef: CASE_ID,
    referringProvider: "DOC1",
    directoryEntryId: null,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "Sensitive to biting",
    status: "draft",
    statusChangedAt: "2026-10-16T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-16T15:00:00.000Z",
    updatedAt: "2026-10-16T15:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listDirectory.mockResolvedValue([]);
  state.prefs = null;
  state.prefsFail = false;
});
afterEach(cleanup);

describe("ReferralsPanel on a case", () => {
  it("lists the case's referrals; an approved one says nothing is sent yet", async () => {
    ref.listReferrals.mockResolvedValue([referral({ status: "approved" }), referral({ referralId: "1b1c2d3e-4f50-4a61-8b72-938495a6b7c8", status: "pending_signoff" })]);
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    const rows = await screen.findAllByTestId("tc-referral-row");
    expect(ref.listReferrals).toHaveBeenCalledWith("roland", { caseId: CASE_ID });
    expect(within(rows[0]).getByTestId("tc-referral-status").textContent).toBe("Approved");
    expect(within(rows[0]).getByText("Ready to send — sending ships in a later update.")).toBeTruthy();
    expect(within(rows[1]).getByText("Pending Dr. sign-off")).toBeTruthy();
    expect(within(rows[1]).getByRole("button", { name: "Withdraw to edit" })).toBeTruthy();
    expect(within(rows[0]).queryByRole("button")).toBeNull();
  });

  it("renders nothing while referrals is off", async () => {
    ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: false });
    const { container } = render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    await waitFor(() => expect(ref.getReferralsStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    expect(ref.listReferrals).not.toHaveBeenCalled();
  });

  it("New referral: a reason is required and teeth must be 1–32; no patient is ever sent", async () => {
    ref.listReferrals.mockResolvedValue([]);
    ref.createReferral.mockResolvedValue(referral());
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    fireEvent.click(await screen.findByRole("button", { name: /New referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog).findByText("Say why you are referring")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Possible cracked tooth" } });
    fireEvent.change(within(dialog).getByLabelText("Teeth"), { target: { value: "3, 40" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog).findByText(/Teeth are numbers 1–32/)).toBeTruthy();
    expect(ref.createReferral).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Teeth"), { target: { value: "#3, 14" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(ref.createReferral).toHaveBeenCalledTimes(1));
    const [office, source, input] = ref.createReferral.mock.calls[0];
    expect(office).toBe("roland");
    expect(source).toEqual({ caseId: CASE_ID });
    expect(input).toMatchObject({ reason: "Possible cracked tooth", teeth: [3, 14], urgency: "routine" });
    for (const k of ["odPatientId", "patientName", "officeId", "status"]) expect(input).not.toHaveProperty(k);
    expect(ref.referralVerb).not.toHaveBeenCalled();
  });

  it("Save & submit submits after saving, and reports what the server said", async () => {
    ref.listReferrals.mockResolvedValue([]);
    ref.createReferral.mockResolvedValue(referral());
    ref.referralVerb.mockResolvedValue(referral({ status: "pending_signoff" }));
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    fireEvent.click(await screen.findByRole("button", { name: /New referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Ortho consult" } });
    fireEvent.click(within(dialog).getByLabelText("Whole mouth"));
    fireEvent.click(within(dialog).getByRole("button", { name: /Save & submit/ }));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", referral().referralId, "submit"));
    expect(ref.createReferral.mock.calls[0][2].teeth).toBe("mouth");
    expect(toastMock.success).toHaveBeenCalledWith("Sent for the doctor's sign-off");
  });

  it("a draft's Submit and Cancel call their verbs", async () => {
    ref.listReferrals.mockResolvedValue([referral()]);
    ref.referralVerb.mockResolvedValue(referral({ status: "pending_signoff" }));
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Submit for sign-off" }));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", referral().referralId, "submit"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel referral" }));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", referral().referralId, "cancel"));
  });
});

describe("ReferralsPanel in the checkout sidebar (compact)", () => {
  it("the chip shows the checkout's referral state; Start referral starts one from the checkout", async () => {
    ref.listReferrals.mockResolvedValue([referral({ status: "pending_signoff", sourceKind: "checkout", sourceRef: HANDOFF_ID })]);
    ref.createReferral.mockResolvedValue(referral());
    render(<ReferralsPanel compact office="roland" source={{ handoffId: HANDOFF_ID }} />);
    await waitFor(() => expect(screen.getByTestId("checkout-referral-chip").textContent).toBe("Pending Dr. sign-off"));
    expect(ref.listReferrals).toHaveBeenCalledWith("roland", { handoffId: HANDOFF_ID });
    fireEvent.click(screen.getByRole("button", { name: /Start referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Perio eval" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(ref.createReferral).toHaveBeenCalledWith("roland", { handoffId: HANDOFF_ID }, expect.anything()));
  });

  it("reads None with no Start button while referrals is off (the sidebar is unchanged)", async () => {
    ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: false });
    render(<ReferralsPanel compact office="roland" source={{ handoffId: HANDOFF_ID }} />);
    await waitFor(() => expect(ref.getReferralsStatus).toHaveBeenCalled());
    expect(screen.getByTestId("checkout-referral").textContent).toMatch(/None/);
    expect(screen.queryByRole("button", { name: /Start referral/ })).toBeNull();
  });

  it("chip vocabulary: Staged for a draft; a cancelled one does not count", async () => {
    ref.listReferrals.mockResolvedValue([
      referral({ status: "cancelled", createdAt: "2026-10-16T16:00:00.000Z" }),
      referral({ referralId: "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8", status: "draft" }),
    ]);
    render(<ReferralsPanel compact office="roland" source={{ handoffId: HANDOFF_ID }} />);
    await waitFor(() => expect(screen.getByTestId("checkout-referral-chip").textContent).toBe("Staged"));
  });
});

describe("the sign-off page", () => {
  it("queue → detail with history → Approve, with the honest ready-to-send line", async () => {
    const pending = referral({ status: "pending_signoff" });
    ref.listSignoffQueue.mockResolvedValueOnce([pending]).mockResolvedValue([]);
    ref.getSignoffReferral.mockResolvedValue({
      ...pending,
      events: [
        { eventId: "3b1c2d3e-4f50-4a61-8b72-938495a6b7c8", fromStatus: null, toStatus: "draft", actor: "tc@carein.ai", at: "2026-10-16T15:00:00.000Z", note: "" },
        { eventId: "4b1c2d3e-4f50-4a61-8b72-938495a6b7c8", fromStatus: "draft", toStatus: "pending_signoff", actor: "tc@carein.ai", at: "2026-10-16T15:01:00.000Z", note: "" },
      ],
    });
    ref.approveReferral.mockResolvedValue(referral({ status: "approved" }));
    render(<SignoffInner office="roland" />);
    fireEvent.click(await screen.findByTestId("tc-signoff-row"));
    const detail = await screen.findByTestId("tc-signoff-detail");
    expect(within(detail).getByText("Sensitive to biting")).toBeTruthy();
    expect(within(detail).getByText(/Pending Dr. sign-off · tc@carein\.ai/)).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(ref.approveReferral).toHaveBeenCalledWith("roland", pending.referralId));
    expect((await screen.findByTestId("tc-signoff-done")).textContent).toContain(
      "Ready to send — sending ships in a later update.",
    );
    expect(await screen.findByTestId("tc-signoff-empty")).toBeTruthy();
  });

  it("Decline needs a reason before it can be pressed", async () => {
    const pending = referral({ status: "pending_signoff" });
    ref.listSignoffQueue.mockResolvedValue([pending]);
    ref.getSignoffReferral.mockResolvedValue({ ...pending, events: [] });
    ref.declineReferral.mockResolvedValue(referral({ status: "declined" }));
    render(<SignoffInner office="roland" />);
    fireEvent.click(await screen.findByTestId("tc-signoff-row"));
    const detail = await screen.findByTestId("tc-signoff-detail");
    fireEvent.click(within(detail).getByRole("button", { name: /Decline/ }));
    const confirm = within(detail).getByRole("button", { name: "Decline referral" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(detail).getByLabelText("Why decline?"), { target: { value: "Treat in house first" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(ref.declineReferral).toHaveBeenCalledWith("roland", pending.referralId, "Treat in house first"));
  });

  it("an empty queue says so", async () => {
    ref.listSignoffQueue.mockResolvedValue([]);
    render(<SignoffInner office="roland" />);
    expect((await screen.findByTestId("tc-signoff-empty")).textContent).toContain("Nothing is waiting");
  });
});

// ── the sign-off arrival obeys the referral_signoff preference ──────────────

function Probe() {
  const w = useSignoffWatch(["roland"]);
  return <div data-testid="probe">{`${w.enabled}:${w.waiting}`}</div>;
}

function summary(waiting: number, n: number): TcReferralSignoffSummary {
  return {
    success: true,
    office: "roland",
    enabled: true,
    waiting,
    newest: { referralId: `5d2a7e10-0000-4000-8000-00000000000${n}`, patientName: `Pat ${n}`, at: `2026-10-16T1${n}:00:00.000Z` },
  };
}

function prefs(level: TcNotificationLevel): TcNotificationPrefsResponse {
  return {
    success: true,
    office: "roland",
    canEditOffice: false,
    events: [
      { event: "checkout_handoff", level: "banner", source: "default", mine: null, officeDefault: null },
      { event: "referral_signoff", level, source: "user", mine: level, officeDefault: null },
    ],
  };
}

async function arrive() {
  ref.getSignoffSummary.mockResolvedValueOnce(summary(1, 1)).mockResolvedValueOnce(summary(2, 2));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const memory = memoryLocation({ path: "/tc" });
    render(
      <WouterRouter hook={memory.hook}>
        <Probe />
      </WouterRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:1"));
    expect(toastMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:2"));
  } finally {
    vi.useRealTimers();
  }
}

describe("the sign-off arrival obeys the referral_signoff preference", () => {
  it("silent: the badge updates, no banner, no sound", async () => {
    state.prefs = prefs("silent");
    await arrive();
    expect(toastMock).not.toHaveBeenCalled();
    expect(chime).not.toHaveBeenCalled();
  });

  it("sound + banner: a banner naming the patient, and the chime", async () => {
    state.prefs = prefs("sound_banner");
    await arrive();
    expect(toastMock).toHaveBeenCalledWith("Pat 2's referral is waiting for your sign-off", expect.anything());
    expect(chime).toHaveBeenCalledTimes(1);
  });

  it("a doctor cannot read preferences (tc.full) — the banner still comes", async () => {
    state.prefsFail = true;
    await arrive();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(chime).not.toHaveBeenCalled();
  });
});

const SHOOT = process.env.TC_SHOTS === "1";
describe.skipIf(!SHOOT)("tc referrals R2 screenshot dumps", () => {
  const out = resolve(import.meta.dirname, ".shots");
  it("09 — Awaiting sign-off, a referral open", async () => {
    const pending = referral({ status: "pending_signoff" });
    ref.listSignoffQueue.mockResolvedValue([pending, referral({ referralId: "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8", patientName: "Test, MangoTest", odPatientId: 12828, status: "pending_signoff", practiceName: "Valley Oral Surgery", specialty: "Oral surgery", reason: "Impacted #17", teeth: [17], urgency: "routine" })]);
    render(
      <div className="max-w-4xl">
        <SignoffInner office="roland" />
      </div>,
    );
    await screen.findAllByTestId("tc-signoff-row");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-09-signoff-queue@1280x700.html"), document.body.innerHTML, "utf8");
  });
  it("10 — a case's referrals", async () => {
    ref.listReferrals.mockResolvedValue([
      referral({ status: "approved" }),
      referral({ referralId: "2b1c2d3e-4f50-4a61-8b72-938495a6b7c8", status: "pending_signoff", practiceName: "Valley Oral Surgery", specialty: "Oral surgery", reason: "Impacted #17", teeth: [17] }),
      referral({ referralId: "3b1c2d3e-4f50-4a61-8b72-938495a6b7c8", status: "draft", practiceName: null, specialty: "Periodontics", reason: "Perio evaluation", teeth: "mouth", urgency: "routine" }),
    ]);
    render(
      <div className="p-6 max-w-3xl">
        <ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />
      </div>,
    );
    await screen.findAllByTestId("tc-referral-row");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-10-case-referrals@1280x800.html"), document.body.innerHTML, "utf8");
  });
});
