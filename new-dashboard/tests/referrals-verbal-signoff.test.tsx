/**
 * Verbal sign-off, per office (referral-verbal-signoff).
 *
 *  - hubVerbalVerbs: offered ONLY when the mode is read as 'verbal', ONLY to a
 *    tc.full viewer, ONLY on a referral awaiting sign-off; an unread mode
 *    offers nothing (the server refuses outside 'verbal' anyway);
 *  - the timeline renders a verbal approval distinctly: "Approved — verbal OK
 *    from Dr. X, recorded by Y"; a plain approve reads as before;
 *  - the hub panel: in verbal mode a TC (no sign-off permission) gets the
 *    verbal box instead of "waiting for the doctor"; no doctor picked = no
 *    button; Approve keeps the "may email" confirm; the call carries the
 *    picked provider id; in doctor mode nothing verbal is drawn;
 *  - settings: "How the doctor signs off" sends signoffMode, shown only while
 *    sign-off is on.
 *
 * NO NETWORK (the APIs are mocked whole), NO PHI (the synthetic fixture 12827
 * roland; provider names synthetic).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TcReferral, TcReferralEvent, TcReferralSettingsResponse } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref, prov } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralsStatus: vi.fn(),
    getReferralSettings: vi.fn(),
    updateReferralSettings: vi.fn(),
    listDirectory: vi.fn(),
    createDirectoryEntry: vi.fn(),
    updateDirectoryEntry: vi.fn(),
    deleteDirectoryEntry: vi.fn(),
    getReferralTemplates: vi.fn(),
    saveReferralTemplate: vi.fn(),
    listHub: vi.fn(),
    getReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    returnReferral: vi.fn(),
    verbalSignoff: vi.fn(),
  },
  prov: {
    listActiveProviders: vi.fn(),
    listSignoffProviders: vi.fn(async () => []),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/providers/providersApi", () => prov);

import { HubDetail } from "@/pages/tc/TcReferralsHub";
import { HUB_SIGNOFF_WAITING_COPY, hubNotesWithVerbal, hubVerbalVerbs, type HubViewer } from "@/features/tc/referrals/hubActions";
import { ReferralTimeline, referralEventLabel } from "@/features/tc/referrals/ReferralTimeline";
import { SIGNOFF_AUTOSEND_ON_COPY, SIGNOFF_AUTOSEND_UNKNOWN_COPY } from "@/features/tc/referrals/SignoffActions";
import { ReferralsSection } from "@/features/tc/settings/ReferralsSection";
import { TcReferralStatus, verbalDoctorLabel } from "@shared/tc/referrals";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const PROV = "7d1c2d3e-4f50-4a61-8b72-938495a6b7c8";

const TC: HubViewer = { tcFull: true, signoff: false };
const DOCTOR: HubViewer = { tcFull: false, signoff: true };

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
    status: "pending_signoff",
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

function ev(over: Partial<TcReferralEvent>): TcReferralEvent {
  return {
    eventId: "3b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    fromStatus: "pending_signoff",
    toStatus: "approved",
    actor: "tc@carein.ai",
    at: "2026-11-18T15:05:00.000Z",
    note: "",
    verb: "approve",
    ...over,
  };
}

const PROVIDER = {
  providerId: PROV,
  officeId: "roland" as const,
  name: "Synthetic Doctor",
  credentialSuffix: "DDS",
  active: true,
  odProvNum: null,
  createdBy: "boss@carein.ai",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedBy: "boss@carein.ai",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  ref.listReferralAttachments.mockResolvedValue([]);
  prov.listActiveProviders.mockResolvedValue([PROVIDER]);
});
afterEach(cleanup);

// ── pure ────────────────────────────────────────────────────────────────────

describe("hubVerbalVerbs", () => {
  it("verbal + tc.full + awaiting sign-off -> the doctor's three; anything else -> none", () => {
    expect(hubVerbalVerbs("pending_signoff", TC, "verbal")).toEqual(["approve", "decline", "return"]);
    expect(hubVerbalVerbs("pending_signoff", { tcFull: true, signoff: true }, "verbal")).toEqual(["approve", "decline", "return"]);
    for (const mode of ["doctor", "off", null] as const) expect(hubVerbalVerbs("pending_signoff", TC, mode)).toEqual([]);
    expect(hubVerbalVerbs("pending_signoff", DOCTOR, "verbal")).toEqual([]);
    for (const s of TcReferralStatus.options.filter((x) => x !== "pending_signoff")) expect(hubVerbalVerbs(s, TC, "verbal")).toEqual([]);
  });

  it("drops only the waiting note, and only when a verbal move is offered", () => {
    const notes = [HUB_SIGNOFF_WAITING_COPY, "other"];
    expect(hubNotesWithVerbal(notes, ["approve"])).toEqual(["other"]);
    expect(hubNotesWithVerbal(notes, [])).toEqual(notes);
  });
});

describe("the timeline", () => {
  it('renders a verbal approval as "Approved — verbal OK from Dr. X, recorded by Y"', () => {
    const verbal = ev({ verbal: { providerId: PROV, providerName: "Synthetic Doctor" } });
    expect(referralEventLabel(verbal)).toBe("Approved — verbal OK from Dr. Synthetic Doctor, recorded by tc@carein.ai");
    expect(referralEventLabel(ev({ verb: "decline", toStatus: "declined", verbal: { providerId: PROV, providerName: "Dr. Synthetic" } }))).toBe(
      "Declined — verbal decision from Dr. Synthetic, recorded by tc@carein.ai",
    );
    expect(referralEventLabel(ev({ verb: "return", toStatus: "draft", verbal: { providerId: PROV, providerName: "Synthetic Doctor" } }))).toBe(
      "Sent back — verbal question from Dr. Synthetic Doctor, recorded by tc@carein.ai",
    );
    render(<ReferralTimeline events={[verbal]} />);
    const line = screen.getByTestId("referral-timeline").textContent ?? "";
    expect(line).toContain("Approved — verbal OK from Dr. Synthetic Doctor, recorded by tc@carein.ai");
    // The recorder is named once, in the line.
    expect(line.split("tc@carein.ai").length - 1).toBe(1);
  });

  it("a plain approve reads exactly as before", () => {
    const plain = ev({ actor: "doc@carein.ai" });
    expect(referralEventLabel(plain)).toBe("Approved");
    render(<ReferralTimeline events={[plain]} />);
    expect(screen.getByTestId("referral-timeline").textContent).toMatch(/^Approved · .+ · doc@carein\.ai$/);
  });

  it("verbalDoctorLabel adds the title once", () => {
    expect(verbalDoctorLabel("Synthetic Doctor")).toBe("Dr. Synthetic Doctor");
    expect(verbalDoctorLabel("Dr. Synthetic")).toBe("Dr. Synthetic");
    expect(verbalDoctorLabel("dr Synthetic")).toBe("dr Synthetic");
  });
});

// ── the hub panel ───────────────────────────────────────────────────────────

async function openInHub(mode: "doctor" | "verbal" | "off" | null, autosend: boolean | null, viewer: HubViewer = TC) {
  ref.getReferral.mockResolvedValue(referral());
  render(
    <HubDetail
      office="roland"
      referralId={RID}
      onClose={() => undefined}
      onChanged={() => undefined}
      viewer={viewer}
      signoffRequired={mode !== "off"}
      autosend={autosend}
      signoffMode={mode}
    />,
  );
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByTestId("tc-hub-actions");
  return panel;
}

describe("the hub panel in verbal mode", () => {
  it("a TC gets the verbal box, not 'waiting'; no doctor picked = no button; Approve asks, then sends the picked id", async () => {
    const panel = await openInHub("verbal", null);
    const box = within(panel).getByTestId("tc-hub-verbal-signoff");
    expect(within(panel).queryByText(HUB_SIGNOFF_WAITING_COPY)).toBeNull();
    expect(within(panel).queryByTestId("tc-hub-signoff-actions")).toBeNull();
    const approve = within(box).getByTestId("tc-hub-verbal-approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    // There is no free-text doctor: the only doctor input is the directory pick.
    const select = (await within(box).findByTestId("tc-hub-verbal-doctor")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.options[1].textContent).toBe("Dr. Synthetic Doctor, DDS");
    fireEvent.change(select, { target: { value: PROV } });
    expect(approve.disabled).toBe(false);
    fireEvent.change(within(box).getByLabelText("Note (optional)"), { target: { value: "OK by phone" } });

    ref.verbalSignoff.mockResolvedValue(referral({ status: "approved" }));
    fireEvent.click(approve);
    expect(within(box).getByTestId("tc-hub-verbal-approve-confirm").textContent).toBe(SIGNOFF_AUTOSEND_UNKNOWN_COPY);
    expect(ref.verbalSignoff).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByTestId("tc-hub-verbal-approve-confirmed"));
    await waitFor(() => expect(ref.verbalSignoff).toHaveBeenCalledWith("roland", RID, PROV, { verb: "approve", note: "OK by phone" }));
    // Never the doctor's own route.
    expect(ref.approveReferral).not.toHaveBeenCalled();
  });

  it("with auto-send on, the confirm says it will email; with it read as off, one click", async () => {
    let panel = await openInHub("verbal", true);
    let select = (await within(panel).findByTestId("tc-hub-verbal-doctor")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: PROV } });
    fireEvent.click(within(panel).getByTestId("tc-hub-verbal-approve"));
    expect(within(panel).getByTestId("tc-hub-verbal-approve-confirm").textContent).toBe(SIGNOFF_AUTOSEND_ON_COPY);
    cleanup();

    ref.verbalSignoff.mockResolvedValue(referral({ status: "approved" }));
    panel = await openInHub("verbal", false);
    select = (await within(panel).findByTestId("tc-hub-verbal-doctor")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: PROV } });
    fireEvent.click(within(panel).getByTestId("tc-hub-verbal-approve"));
    await waitFor(() => expect(ref.verbalSignoff).toHaveBeenCalledWith("roland", RID, PROV, { verb: "approve" }));
  });

  it("decline needs a reason, send back needs a question — both carry the doctor", async () => {
    const panel = await openInHub("verbal", false);
    const select = (await within(panel).findByTestId("tc-hub-verbal-doctor")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: PROV } });
    ref.verbalSignoff.mockResolvedValue(referral({ status: "declined" }));
    fireEvent.click(within(panel).getByRole("button", { name: /Decline/ }));
    const record = within(panel).getByRole("button", { name: "Record decline" }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText("Why did the doctor decline?"), { target: { value: "Treat in house" } });
    fireEvent.click(record);
    await waitFor(() => expect(ref.verbalSignoff).toHaveBeenCalledWith("roland", RID, PROV, { verb: "decline", reason: "Treat in house" }));
  });

  it("no active providers: says so, and offers no way to approve", async () => {
    prov.listActiveProviders.mockResolvedValue([]);
    const panel = await openInHub("verbal", false);
    expect(await within(panel).findByTestId("tc-hub-verbal-no-providers")).toBeTruthy();
    expect((within(panel).getByTestId("tc-hub-verbal-approve") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the hub panel outside verbal mode", () => {
  it("doctor mode (or an unread mode): no verbal box; a TC still sees 'waiting for the doctor'", async () => {
    for (const mode of ["doctor", null] as const) {
      const panel = await openInHub(mode, false);
      expect(within(panel).queryByTestId("tc-hub-verbal-signoff")).toBeNull();
      expect(within(panel).getByText(HUB_SIGNOFF_WAITING_COPY)).toBeTruthy();
      cleanup();
    }
    expect(prov.listActiveProviders).not.toHaveBeenCalledWith("roland");
  });
});

// ── settings ────────────────────────────────────────────────────────────────

function settings(over: Partial<TcReferralSettingsResponse> = {}): TcReferralSettingsResponse {
  return {
    success: true,
    office: "roland",
    signoffRequired: { value: true, source: "office" },
    signoffMode: { value: "doctor", source: "office" },
    autosendOnApproval: { value: false, source: "default" },
    canEdit: true,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

describe("settings: how the doctor signs off", () => {
  beforeEach(() => {
    ref.listDirectory.mockResolvedValue([]);
    ref.getReferralTemplates.mockResolvedValue({ success: true, office: "roland", templates: [], canEdit: true });
  });

  it("picking 'Verbal OK, recorded by staff' sends signoffMode verbal", async () => {
    ref.getReferralSettings.mockResolvedValue(settings());
    ref.updateReferralSettings.mockResolvedValue(settings({ signoffMode: { value: "verbal", source: "office" } }));
    render(<ReferralsSection office="roland" />);
    const how = await screen.findByTestId("ref-signoff-how");
    const verbal = within(how).getByRole("radio", { name: /Verbal OK, recorded by staff/ }) as HTMLInputElement;
    expect((within(how).getByRole("radio", { name: /In the app/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(verbal);
    await waitFor(() => expect(ref.updateReferralSettings).toHaveBeenCalledWith("roland", { signoffMode: "verbal" }));
    await waitFor(() => expect(verbal.checked).toBe(true));
  });

  it("hidden while sign-off is off; locked under the env pin", async () => {
    ref.getReferralSettings.mockResolvedValue(
      settings({ signoffRequired: { value: false, source: "office" }, signoffMode: { value: "off", source: "office" } }),
    );
    render(<ReferralsSection office="roland" />);
    await screen.findByRole("switch", { name: /Doctor signs off/ });
    expect(screen.queryByTestId("ref-signoff-how")).toBeNull();
    cleanup();

    ref.getReferralSettings.mockResolvedValue(
      settings({ signoffRequired: { value: true, source: "env" }, signoffMode: { value: "doctor", source: "env" } }),
    );
    render(<ReferralsSection office="roland" />);
    const how = await screen.findByTestId("ref-signoff-how");
    for (const r of within(how).getAllByRole("radio") as HTMLInputElement[]) expect(r.disabled).toBe(true);
  });
});
