/**
 * R6.1 — the Referrals hub's lifecycle moves, in jsdom.
 *
 * The bug: a draft opened in the hub could be edited but not moved anywhere —
 * the detail panel drew Edit and the post-approval marks, never Submit,
 * Withdraw or Cancel. These pin:
 *  - hubActionPlan: what the panel offers per status × viewer × sign-off
 *    policy, and that every offer is exactly what the SHARED transition table
 *    (referralNextStatus) says — the client decides which buttons to draw,
 *    never where a move leads;
 *  - the doctor's moves (approve / decline / send back) — RE-PINNED by the
 *    sign-off-in-hub slice (Beau's ruling; R6.1's "never drawn on the hub" is
 *    reversed for sign-off holders only): offered exactly to a
 *    tc.referral_signoff holder, exactly on a referral awaiting sign-off, as
 *    the shared table allows; everyone else gets "Waiting for the doctor's
 *    sign-off" and none of them. Send and the marks are unchanged;
 *  - the panel: Submit / Withdraw / Cancel go through the existing referralVerb
 *    routes and the panel shows only the server's answer.
 *
 * NO NETWORK, NO BACKEND, NOTHING SENDS (the referrals API is mocked whole and
 * the send call is asserted never made), NO PHI (test patient 12827).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TcReferral, TcReferralStatus } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    listDirectory: vi.fn(),
    editReferralFields: vi.fn(),
    reopenReferral: vi.fn(),
    markReferral: vi.fn(),
    referralVerb: vi.fn(),
    sendReferralEmail: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    returnReferral: vi.fn(),
    getReferralsStatus: vi.fn(),
    getReferralSettings: vi.fn(),
    listHub: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { HubDetail, nextMark } from "@/pages/tc/TcReferralsHub";
import {
  HUB_NOT_TC_FULL_COPY,
  HUB_SIGNOFF_VERBS,
  HUB_SIGNOFF_WAITING_COPY,
  HUB_VERBS,
  hubActionLabel,
  hubActionPlan,
  type HubViewer,
} from "@/features/tc/referrals/hubActions";
import { TcApiError } from "@/features/tc/api";
import { TcReferralStatus as StatusEnum, referralNextStatus } from "@shared/tc/referrals";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const ENTRY = "5a1c2d3e-4f50-4a61-8b72-938495a6b7c8";

const TC: HubViewer = { tcFull: true, signoff: false };
const ADMIN: HubViewer = { tcFull: true, signoff: true };
const NOT_TC: HubViewer = { tcFull: false, signoff: false };
const DOCTOR: HubViewer = { tcFull: false, signoff: true };

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: RID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "call",
    sourceRef: "call-fixture-1",
    referringProvider: "",
    directoryEntryId: null,
    practiceName: null,
    specialty: "",
    reason: "Possible cracked tooth",
    teeth: [],
    urgency: "routine",
    narrative: "",
    status: "draft",
    statusChangedAt: "2026-10-20T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "office@carein.ai",
    createdAt: "2026-10-20T15:00:00.000Z",
    updatedAt: "2026-10-20T15:00:00.000Z",
    doctorNote: null,
    returned: null,
    events: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ref.listReferralAttachments.mockResolvedValue([]);
  ref.listDirectory.mockResolvedValue([]);
});
afterEach(() => cleanup());

// ── the plan, pure ──────────────────────────────────────────────────────────

const verbsFor = (s: TcReferralStatus, v: HubViewer = TC, policy: boolean | null = true) =>
  hubActionPlan(s, v, policy).actions.map((a) => a.verb);

describe("hubActionPlan — what the hub offers, from the shared table", () => {
  it("per status, for a tc.full viewer", () => {
    expect(Object.fromEntries(StatusEnum.options.map((s) => [s, verbsFor(s)]))).toEqual({
      draft: ["submit", "cancel"],
      pending_signoff: ["withdraw", "cancel"],
      approved: ["reopen", "mark_sent"],
      sent: ["mark_acknowledged"],
      acknowledged: ["mark_patient_seen"],
      patient_seen: ["close"],
      closed: [],
      declined: [],
      cancelled: [],
    });
  });

  it("is the shared table, not a copy of it: every hub verb is offered iff referralNextStatus allows it, and leads where it says", () => {
    for (const policy of [true, false]) {
      for (const s of StatusEnum.options) {
        const plan = hubActionPlan(s, TC, policy);
        for (const verb of HUB_VERBS) {
          const to = referralNextStatus(s, verb, { signoffRequired: policy });
          const offered = plan.actions.find((a) => a.verb === verb);
          expect(offered?.to ?? null, `${s} --${verb}--> (sign-off ${policy})`).toBe(to);
        }
      }
    }
  });

  it("the TC side's moves never include a doctor's move or a send, whoever is looking", () => {
    for (const v of [TC, ADMIN, NOT_TC, DOCTOR]) {
      for (const s of StatusEnum.options) {
        for (const verb of verbsFor(s, v)) expect(["approve", "decline", "return", "send"]).not.toContain(verb);
      }
    }
  });

  it("NEW INVARIANT: approve / decline / send back only for a tc.referral_signoff holder, only on pending_signoff, as the table allows", () => {
    for (const policy of [true, false, null]) {
      for (const s of StatusEnum.options) {
        for (const v of [TC, ADMIN, NOT_TC, DOCTOR]) {
          const offered = hubActionPlan(s, v, policy).signoff;
          if (!v.signoff || s !== "pending_signoff") {
            expect(offered, `${s} as ${JSON.stringify(v)}`).toEqual([]);
            continue;
          }
          expect(offered).toEqual(["approve", "decline", "return"]);
          for (const verb of HUB_SIGNOFF_VERBS) {
            expect(referralNextStatus(s, verb, { signoffRequired: policy ?? true }), verb).not.toBeNull();
          }
        }
      }
    }
  });

  it("submit names where it leads: sign-off on, off, or the policy unread", () => {
    const at = (p: boolean | null) => hubActionPlan("draft", TC, p).actions.find((a) => a.verb === "submit")!;
    expect(at(true).to).toBe("pending_signoff");
    expect(hubActionLabel(at(true))).toBe("Submit for sign-off");
    expect(at(false).to).toBe("approved");
    expect(hubActionLabel(at(false))).toBe("Submit (sign-off not required — approves it)");
    // Unread policy: still offered (offering never depends on it), label generic.
    expect(at(null).to).toBeNull();
    expect(hubActionLabel(at(null))).toBe("Submit");
  });

  it("awaiting sign-off: a signer gets the moves here; anyone else is told it waits for the doctor", () => {
    const tc = hubActionPlan("pending_signoff", TC, true);
    expect(tc.notes).toEqual([HUB_SIGNOFF_WAITING_COPY]);
    expect(tc.signoff).toEqual([]);
    const admin = hubActionPlan("pending_signoff", ADMIN, true);
    expect(admin.notes).toEqual([]);
    expect(admin.signoff).toEqual(["approve", "decline", "return"]);
    expect(admin.actions.map((a) => a.verb)).toEqual(["withdraw", "cancel"]);
    // Nothing about sign-off on any other status.
    for (const s of StatusEnum.options.filter((x) => x !== "pending_signoff")) {
      expect(hubActionPlan(s, TC, true).notes).toEqual([]);
      expect(hubActionPlan(s, ADMIN, true).notes).toEqual([]);
    }
  });

  it("without tc.full: no moves, and a named reason wherever one would exist", () => {
    expect(hubActionPlan("draft", NOT_TC, true)).toEqual({ actions: [], signoff: [], notes: [HUB_NOT_TC_FULL_COPY] });
    // A doctor on a pending one: their own moves, and no lecture about the TC's.
    expect(hubActionPlan("pending_signoff", DOCTOR, true)).toEqual({
      actions: [],
      signoff: ["approve", "decline", "return"],
      notes: [],
    });
    expect(hubActionPlan("pending_signoff", NOT_TC, true)).toEqual({
      actions: [],
      signoff: [],
      notes: [HUB_NOT_TC_FULL_COPY, HUB_SIGNOFF_WAITING_COPY],
    });
    // A finished referral has nothing to refuse, so says nothing.
    expect(hubActionPlan("closed", NOT_TC, true)).toEqual({ actions: [], signoff: [], notes: [] });
  });

  it("nextMark still agrees with the table", () => {
    for (const s of StatusEnum.options) {
      const mark = nextMark(s);
      const fromPlan = verbsFor(s).find((v) => v.startsWith("mark_") || v === "close") ?? null;
      expect(mark, s).toBe(fromPlan);
    }
  });
});

// ── the panel ───────────────────────────────────────────────────────────────

async function openDetail(detail: TcReferral, opts: { viewer?: HubViewer; signoffRequired?: boolean | null } = {}) {
  ref.getReferral.mockResolvedValue(detail);
  const onChanged = vi.fn();
  render(
    <HubDetail
      office="roland"
      referralId={detail.referralId}
      onClose={() => undefined}
      onChanged={onChanged}
      viewer={opts.viewer ?? TC}
      signoffRequired={opts.signoffRequired === undefined ? true : opts.signoffRequired}
    />,
  );
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByTestId("tc-hub-actions");
  return { panel, onChanged };
}

function expectNothingSent() {
  expect(ref.sendReferralEmail).not.toHaveBeenCalled();
  expect(ref.approveReferral).not.toHaveBeenCalled();
}

describe("the detail panel's moves", () => {
  it("THE BUG: a draft with no specialist yet can be submitted from the hub; the panel shows the server's answer", async () => {
    const d = referral();
    const { panel, onChanged } = await openDetail(d);
    const submit = within(panel).getByTestId("tc-hub-submit") as HTMLButtonElement;
    expect(submit.textContent).toBe("Submit for sign-off");
    expect(submit.disabled).toBe(false);
    expect(within(panel).getByRole("button", { name: /^Edit$/ })).toBeTruthy();

    ref.referralVerb.mockResolvedValue({ ...d, status: "pending_signoff" });
    fireEvent.click(submit);
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", RID, "submit"));
    await waitFor(() => expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Pending Dr. sign-off"));
    expect(toastMock.success).toHaveBeenCalledWith("Sent for the doctor's sign-off");
    expect(onChanged).toHaveBeenCalled();
    // Now awaiting sign-off: withdraw / cancel, and where the doctor acts.
    expect(within(panel).queryByTestId("tc-hub-submit")).toBeNull();
    expect(within(panel).getByTestId("tc-hub-withdraw")).toBeTruthy();
    expect(within(panel).getByTestId("tc-hub-move-notes").textContent).toContain(HUB_SIGNOFF_WAITING_COPY);
    expectNothingSent();
  });

  it("sign-off off for the office: the label says it approves, and the toast follows the server's status", async () => {
    const d = referral();
    const { panel } = await openDetail(d, { signoffRequired: false });
    const submit = within(panel).getByTestId("tc-hub-submit");
    expect(submit.textContent).toBe("Submit (sign-off not required — approves it)");
    ref.referralVerb.mockResolvedValue({ ...d, status: "approved" });
    fireEvent.click(submit);
    await waitFor(() => expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Approved"));
    expect(toastMock.success).toHaveBeenCalledWith("Referral approved (sign-off not required)");
    expectNothingSent();
  });

  it("the policy could not be read: Submit is still there, labelled plainly", async () => {
    const { panel } = await openDetail(referral(), { signoffRequired: null });
    expect(within(panel).getByTestId("tc-hub-submit").textContent).toBe("Submit");
  });

  it("a refused move leaves the referral as it was and says why", async () => {
    const d = referral();
    const { panel } = await openDetail(d);
    ref.referralVerb.mockRejectedValue(
      new TcApiError("This referral cannot be submitted: it is pending dr. sign-off.", 409, "REFERRAL_TRANSITION_NOT_ALLOWED", null, []),
    );
    fireEvent.click(within(panel).getByTestId("tc-hub-submit"));
    expect(await within(panel).findByText("This referral cannot be submitted: it is pending dr. sign-off.")).toBeTruthy();
    expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Draft");
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("awaiting sign-off: withdraw goes back to a draft", async () => {
    const d = referral({ status: "pending_signoff" });
    const { panel } = await openDetail(d);
    expect(within(panel).queryByTestId("tc-hub-signoff-actions")).toBeNull();
    ref.referralVerb.mockResolvedValue({ ...d, status: "draft" });
    fireEvent.click(within(panel).getByTestId("tc-hub-withdraw"));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", RID, "withdraw"));
    await waitFor(() => expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Draft"));
    expect(within(panel).getByTestId("tc-hub-submit")).toBeTruthy();
  });

  it("RE-PINNED: an admin (a signer) gets Approve, Decline and Send back on the hub; a TC gets none", async () => {
    const { panel } = await openDetail(referral({ status: "pending_signoff" }), { viewer: ADMIN });
    expect(within(panel).getByRole("button", { name: /^Approve$/ })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Decline/ })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Send back with a question/ })).toBeTruthy();
    expect(within(panel).queryByTestId("tc-hub-move-notes")).toBeNull();
    expectNothingSent(); // drawn, not pressed
    cleanup();
    const tc = await openDetail(referral({ status: "pending_signoff" }), { viewer: TC });
    expect(within(tc.panel).queryByRole("button", { name: /Approve|Decline|Send back/ })).toBeNull();
    expect(within(tc.panel).getByTestId("tc-hub-move-notes").textContent).toBe(HUB_SIGNOFF_WAITING_COPY);
  });

  it("cancel asks first; only 'Yes, cancel it' moves it", async () => {
    const d = referral();
    const { panel } = await openDetail(d);
    fireEvent.click(within(panel).getByTestId("tc-hub-cancel"));
    const confirm = within(panel).getByTestId("tc-hub-cancel-confirm");
    expect(ref.referralVerb).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(within(panel).queryByTestId("tc-hub-cancel-confirm")).toBeNull();
    expect(ref.referralVerb).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByTestId("tc-hub-cancel"));
    ref.referralVerb.mockResolvedValue({ ...d, status: "cancelled" });
    fireEvent.click(within(panel).getByRole("button", { name: /Yes, cancel it/ }));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", RID, "cancel"));
    await waitFor(() => expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Cancelled"));
    expect(within(panel).getByTestId("tc-hub-readonly").textContent).toContain("finished");
    expect(within(panel).queryByTestId("tc-hub-moves")).toBeNull();
  });

  it("without tc.full: no moves and no edit, and the reason is named", async () => {
    const { panel } = await openDetail(referral(), { viewer: NOT_TC });
    expect(within(panel).queryByTestId("tc-hub-submit")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^Edit$/ })).toBeNull();
    expect(within(panel).getByTestId("tc-hub-move-notes").textContent).toContain(HUB_NOT_TC_FULL_COPY);
  });

  it("the post-approval world is unchanged: an approved one offers re-approval edit and the mark, no submit", async () => {
    const { panel } = await openDetail(referral({ status: "approved", directoryEntryId: ENTRY, practiceName: "River Endodontics" }));
    expect(within(panel).queryByTestId("tc-hub-moves")).toBeNull();
    expect(within(panel).getByRole("button", { name: /Edit \(re-approval needed\)/ })).toBeTruthy();
    expect(within(panel).getByTestId("tc-hub-mark")).toBeTruthy();
    expectNothingSent();
  });
});
