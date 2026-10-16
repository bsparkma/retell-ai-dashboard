/**
 * Referrals R3 (queue item 54), in jsdom: starting a referral from the
 * hygiene visit and from a call.
 *
 *  - VisitReferral: absent while referrals is off; one button — "Send for
 *    Dr. sign-off" — no draft; the picker reads the hyg-side directory; the
 *    request carries no patient (the server takes it from the visit).
 *  - CallReferralButton: absent without TC, without voice.send_to_tc, without
 *    a matched patient, or with referrals off; sends only the referral and an
 *    office ASSERTION; "Save & submit" submits through TC.
 *
 * With TC_SHOTS=1 it also dumps the chairside form (tccheckout-11).
 * NO NETWORK, NO BACKEND, NO PHI (test patient 12827).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TcReferral } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, hyg, ref, voice, auth } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  hyg: {
    fetchVisitReferrals: vi.fn(),
    fetchVisitReferralDirectory: vi.fn(),
    startVisitReferral: vi.fn(),
  },
  ref: {
    getReferralsStatus: vi.fn(),
    listDirectory: vi.fn(),
    listReferrals: vi.fn(),
    referralVerb: vi.fn(),
  },
  voice: { startCallReferral: vi.fn() },
  auth: { modules: ["voice", "tc"] as string[], permissions: ["voice.read", "voice.send_to_tc", "tc.full"] as string[] },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/hyg/api", async (orig) => ({
  ...(await orig<typeof import("@/features/hyg/api")>()),
  ...hyg,
}));
vi.mock("@/features/tc/referrals/referralsApi", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/referrals/referralsApi")>()),
  ...ref,
}));
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...voice } };
});
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Front Desk",
      email: "front@carein.ai",
      tenantId: "t",
      tenant: { slug: "x", displayName: "X", modules: auth.modules },
      role: "office",
      isSuperAdmin: false,
      permissions: auth.permissions,
    },
  }),
}));

import { VisitReferral } from "@/features/hyg/visit/VisitReferral";
import { CallReferralButton } from "@/pages/calls/CallReferralButton";

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "hyg_visit",
    sourceRef: "visit-1",
    referringProvider: "",
    directoryEntryId: null,
    practiceName: null,
    specialty: "Periodontics",
    reason: "Deep pockets #30",
    teeth: [30],
    urgency: "soon",
    narrative: "",
    status: "pending_signoff",
    statusChangedAt: "2026-10-16T15:00:00.000Z",
    statusChangedBy: "hygienist@carein.ai",
    createdBy: "hygienist@carein.ai",
    createdAt: "2026-10-16T15:00:00.000Z",
    updatedAt: "2026-10-16T15:00:00.000Z",
    ...over,
  };
}

const ENTRY = {
  entryId: "8a1c2d3e-4f50-4a61-8b72-938495a6b7c8",
  officeId: "roland" as const,
  practiceName: "River Periodontics",
  specialistName: "",
  specialty: "Periodontics",
  contactPerson: "",
  email: "",
  phone: "",
  fax: "",
  notes: "",
  preferredFormatNotes: "",
  active: true,
  createdBy: "x",
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedBy: "x",
  updatedAt: "2026-10-15T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.modules = ["voice", "tc"];
  auth.permissions = ["voice.read", "voice.send_to_tc", "tc.full"];
  hyg.fetchVisitReferralDirectory.mockResolvedValue([ENTRY]);
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listDirectory.mockResolvedValue([ENTRY]);
  ref.listReferrals.mockResolvedValue([]);
});
afterEach(cleanup);

describe("Start referral at the hygiene visit", () => {
  it("is absent while referrals is off (the list read is refused)", async () => {
    hyg.fetchVisitReferrals.mockRejectedValue(new Error("REFERRALS_DISABLED"));
    const { container } = render(<VisitReferral office="roland" aptNum={900001} />);
    await waitFor(() => expect(hyg.fetchVisitReferrals).toHaveBeenCalledWith("roland", 900001));
    expect(container.innerHTML).toBe("");
  });

  it("one button sends it for sign-off; the picker is the hyg-side directory; no patient is sent", async () => {
    hyg.fetchVisitReferrals.mockResolvedValueOnce([]).mockResolvedValue([referral()]);
    hyg.startVisitReferral.mockResolvedValue(referral());
    render(<VisitReferral office="roland" aptNum={900001} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    expect(within(dialog).queryByRole("button", { name: "Save draft" })).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole("option", { name: /River Periodontics/ })).toBeTruthy());
    expect(hyg.fetchVisitReferralDirectory).toHaveBeenCalledWith("roland", 900001);
    expect(ref.listDirectory).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Specialist"), { target: { value: ENTRY.entryId } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Deep pockets #30" } });
    fireEvent.change(within(dialog).getByLabelText("Teeth"), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send for Dr. sign-off" }));
    await waitFor(() => expect(hyg.startVisitReferral).toHaveBeenCalledTimes(1));
    const [office, aptNum, input] = hyg.startVisitReferral.mock.calls[0];
    expect([office, aptNum]).toEqual(["roland", 900001]);
    expect(input).toMatchObject({ directoryEntryId: ENTRY.entryId, specialty: "Periodontics", reason: "Deep pockets #30", teeth: [30] });
    for (const k of ["odPatientId", "patientName", "officeId"]) expect(input).not.toHaveProperty(k);
    expect(toastMock.success).toHaveBeenCalledWith("Sent for the doctor's sign-off");
    expect((await screen.findByTestId("hyg-visit-referral-latest")).textContent).toMatch(/1 referral.*Pending Dr\. sign-off/);
  });
});

describe("Start referral on a call", () => {
  const CALL = { id: "call-1", odPatientId: 12827, officeId: "roland" };

  it("sends only the referral and an office ASSERTION; Save draft does not submit", async () => {
    voice.startCallReferral.mockResolvedValue({ success: true, referral: referral({ status: "draft", sourceKind: "call", sourceRef: "call-1" }) });
    render(<CallReferralButton call={CALL} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Fractured cusp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(voice.startCallReferral).toHaveBeenCalledTimes(1));
    const [id, body] = voice.startCallReferral.mock.calls[0];
    expect(id).toBe("call-1");
    expect(body.office_id).toBe("roland");
    expect(body.referral).toMatchObject({ reason: "Fractured cusp" });
    expect(Object.keys(body).sort()).toEqual(["office_id", "referral"]);
    expect(ref.referralVerb).not.toHaveBeenCalled();
    expect(ref.listReferrals).toHaveBeenCalledWith("roland", { callId: "call-1" });
  });

  it("Save & submit submits the new draft through TC", async () => {
    voice.startCallReferral.mockResolvedValue({ success: true, referral: referral({ status: "draft", sourceKind: "call", sourceRef: "call-1" }) });
    ref.referralVerb.mockResolvedValue(referral());
    render(<CallReferralButton call={CALL} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Fractured cusp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save & submit/ }));
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", referral().referralId, "submit"));
  });

  it("is absent without TC, without voice.send_to_tc, without a matched patient, or with referrals off", async () => {
    auth.modules = ["voice"];
    const a = render(<CallReferralButton call={CALL} />);
    expect(a.container.innerHTML).toBe("");
    a.unmount();

    auth.modules = ["voice", "tc"];
    auth.permissions = ["voice.read", "tc.full"];
    const b = render(<CallReferralButton call={CALL} />);
    expect(b.container.innerHTML).toBe("");
    b.unmount();

    auth.permissions = ["voice.read", "voice.send_to_tc", "tc.full"];
    const c = render(<CallReferralButton call={{ ...CALL, odPatientId: null }} />);
    expect(c.container.innerHTML).toBe("");
    c.unmount();

    ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: false });
    const d = render(<CallReferralButton call={CALL} />);
    await waitFor(() => expect(ref.getReferralsStatus).toHaveBeenCalled());
    expect(d.container.innerHTML).toBe("");
  });

  it("lists the referrals already started from this call", async () => {
    ref.listReferrals.mockResolvedValue([referral({ status: "draft", practiceName: "River Endodontics", sourceKind: "call" })]);
    render(<CallReferralButton call={CALL} />);
    const row = await screen.findByTestId("call-referral-row");
    expect(row.textContent).toMatch(/River Endodontics.*Draft/);
  });
});

const SHOOT = process.env.TC_SHOTS === "1";
describe.skipIf(!SHOOT)("chairside referral screenshot dump", () => {
  it("11 — the chairside form", async () => {
    hyg.fetchVisitReferrals.mockResolvedValue([referral()]);
    render(
      <div className="p-6">
        <VisitReferral office="roland" aptNum={900001} />
      </div>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Start referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: /River Periodontics/ })).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText("Specialist"), { target: { value: ENTRY.entryId } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Deep pockets #30, perio evaluation" } });
    fireEvent.change(within(dialog).getByLabelText("Teeth"), { target: { value: "30" } });
    document.querySelectorAll("select").forEach((s) => {
      s.querySelectorAll("option").forEach((o) => {
        if (o.value === s.value) o.setAttribute("selected", "");
        else o.removeAttribute("selected");
      });
    });
    document.querySelectorAll("input").forEach((i) => i.setAttribute("value", i.value));
    const out = resolve(import.meta.dirname, ".shots");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-11-chairside-referral@1280x900.html"), document.body.innerHTML, "utf8");
  });
});
