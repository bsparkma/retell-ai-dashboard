/**
 * R6.2 (B) — "New referral" on the hub, in jsdom.
 *
 *  - the patient comes from the per-office Open Dental search (odAttachSearch,
 *    GET /tc/od/patient-search), for THIS office; nothing is auto-picked, even
 *    a single result;
 *  - the shared referral form follows, and the create call carries ONLY the
 *    picked PatNum as the source — no office, no name (the server re-reads
 *    the patient from its own Open Dental);
 *  - files then submit go through the case panel's own sequence;
 *  - the new draft opens in the detail panel from the server's answer;
 *  - without tc.full the button is not drawn (the server refuses anyway).
 *
 * NO NETWORK (the referrals API and the OD search are mocked), NOTHING SENDS,
 * NO PHI (test patient 12827).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TcReferral } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref, od, authState } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralsStatus: vi.fn(),
    getReferralSettings: vi.fn(),
    listDirectory: vi.fn(),
    listHub: vi.fn(),
    getReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    createReferral: vi.fn(),
    updateReferral: vi.fn(),
    referralVerb: vi.fn(),
    editReferralFields: vi.fn(),
    reopenReferral: vi.fn(),
    markReferral: vi.fn(),
    sendReferralEmail: vi.fn(),
  },
  od: { odAttachSearch: vi.fn(), odSearchPatients: vi.fn() },
  authState: { current: { status: "loading" } as unknown },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/api", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/api")>()),
  odAttachSearch: od.odAttachSearch,
  odSearchPatients: od.odSearchPatients,
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => authState.current }));

import { HubInner } from "@/pages/tc/TcReferralsHub";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const PATIENT = {
  patNum: 12827,
  firstName: "Stedi",
  lastName: "Test 2",
  displayName: "Test 2, Stedi",
  birthdate: "1980-01-01",
  phone: "",
  email: "",
  status: "",
};

function draft(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: RID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "manual",
    sourceRef: "",
    referringProvider: "",
    directoryEntryId: null,
    practiceName: null,
    specialty: "",
    reason: "Possible cracked tooth",
    teeth: [],
    urgency: "routine",
    narrative: "",
    status: "draft",
    statusChangedAt: "2026-10-22T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-22T15:00:00.000Z",
    updatedAt: "2026-10-22T15:00:00.000Z",
    doctorNote: null,
    returned: null,
    events: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.current = { status: "loading" };
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.getReferralSettings.mockResolvedValue({ signoffRequired: { value: true, source: "default" } });
  ref.listDirectory.mockResolvedValue([]);
  ref.listHub.mockResolvedValue([]);
  ref.listReferralAttachments.mockResolvedValue([]);
  od.odAttachSearch.mockResolvedValue({ query: "Test", matchMode: "prefix", truncated: false, notes: [], patients: [PATIENT] });
});
afterEach(() => cleanup());

/** Open the picker, search, and pick the one result. Returns the open referral form. */
async function pickPatient() {
  render(<HubInner office="roland" />);
  fireEvent.click(await screen.findByTestId("tc-hub-new-referral"));
  const pick = await screen.findByTestId("tc-hub-new-referral-pick");
  fireEvent.change(within(pick).getByLabelText("Patient"), { target: { value: "Test" } });
  const row = await within(pick).findByRole("button", { name: /Test 2, Stedi/ }, { timeout: 2000 });
  // A single result is shown, never auto-picked.
  expect(screen.queryByTestId("tc-referral-dialog")).toBeNull();
  fireEvent.click(row);
  return screen.findByTestId("tc-referral-dialog");
}

describe("New referral on the hub", () => {
  it("searches THIS office's Open Dental, and the create carries only the picked PatNum", async () => {
    const form = await pickPatient();
    expect(od.odAttachSearch).toHaveBeenCalledWith("roland", "Test");
    expect(od.odSearchPatients).not.toHaveBeenCalled();
    expect(form.textContent).toContain("The patient comes from Open Dental: Test 2, Stedi.");

    fireEvent.change(within(form).getByLabelText("Reason *"), { target: { value: "Possible cracked tooth" } });
    ref.createReferral.mockResolvedValue(draft());
    ref.getReferral.mockResolvedValue(draft());
    fireEvent.click(within(form).getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(ref.createReferral).toHaveBeenCalledTimes(1));
    const [office, source, input] = ref.createReferral.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(office).toBe("roland");
    expect(source).toEqual({ patNum: 12827 }); // no office, no name
    expect(input.reason).toBe("Possible cracked tooth");
    expect(Object.keys(input)).not.toContain("patientName");
    expect(ref.referralVerb).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith("Referral saved as a draft");

    // The new draft opens from the server's answer, and the hub re-reads.
    const panel = await screen.findByTestId("tc-hub-detail");
    await waitFor(() => expect(ref.getReferral).toHaveBeenCalledWith("roland", RID));
    expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Draft");
    expect(panel.textContent).toContain("started from referrals hub");
    expect(ref.listHub.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ref.sendReferralEmail).not.toHaveBeenCalled();
  });

  it("Save & submit: files first, then the submit — the case panel's own sequence", async () => {
    const form = await pickPatient();
    fireEvent.change(within(form).getByLabelText("Reason *"), { target: { value: "Possible cracked tooth" } });
    ref.createReferral.mockResolvedValue(draft());
    ref.referralVerb.mockResolvedValue(draft({ status: "pending_signoff" }));
    ref.getReferral.mockResolvedValue(draft({ status: "pending_signoff" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save & submit" }));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", RID, "submit"));
    expect(toastMock.success).toHaveBeenCalledWith("Sent for the doctor's sign-off");
  });

  it("a refused create says why and stores nothing it can show", async () => {
    const form = await pickPatient();
    fireEvent.change(within(form).getByLabelText("Reason *"), { target: { value: "Possible cracked tooth" } });
    const { TcApiError } = await import("@/features/tc/api");
    ref.createReferral.mockRejectedValue(new TcApiError("That patient is not in this office's Open Dental", 404, "PATIENT_NOT_FOUND", null, []));
    fireEvent.click(within(form).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("That patient is not in this office's Open Dental"));
    expect(ref.referralVerb).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tc-hub-detail")).toBeNull();
  });

  it("without tc.full there is no New referral button", async () => {
    authState.current = { status: "authenticated", user: { isSuperAdmin: false, permissions: ["tc.referral_signoff"] } };
    render(<HubInner office="roland" />);
    await screen.findByTestId("tc-hub-groups");
    expect(screen.queryByTestId("tc-hub-new-referral")).toBeNull();
  });
});
