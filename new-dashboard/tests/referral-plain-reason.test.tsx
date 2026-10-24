/**
 * The reason in plain words, on the form both edit surfaces share (the hub,
 * staff; sign-off, the doctor): what the PATIENT's email says the visit is
 * for. Only what changed is sent; blank clears it (the email then keeps its
 * generic phrase); over the cap is refused before a request.
 *
 * No PHI: the patient is the synthetic Roland fixture.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

import { ReferralFieldsForm, changedFields } from "@/features/tc/referrals/ReferralFieldsForm";
import {
  TC_REFERRAL_PATIENT_REASON_MAX,
  TcReferral as TcReferralSchema,
  TcReferralDoctorEdit,
  TcReferralFieldsEdit,
  referralEditSummary,
  type TcReferral,
} from "@shared/tc/referrals";

afterEach(cleanup);

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return TcReferralSchema.parse({
    referralId: "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "case",
    sourceRef: "",
    referringProvider: "DOC1",
    directoryEntryId: null,
    practiceName: null,
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
  });
}

function form(r: TcReferral, onSave: (c: unknown) => void, withDoctorNote = false) {
  return render(
    <ReferralFieldsForm
      referral={r}
      entries={[]}
      withDoctorNote={withDoctorNote}
      saving={false}
      saveLabel="Save"
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
}

describe("the contract", () => {
  it("both edit schemas accept it; over the cap is refused; the history names it without its words", () => {
    expect(TcReferralFieldsEdit.safeParse({ patientReason: "a check of your gums" }).success).toBe(true);
    expect(TcReferralDoctorEdit.safeParse({ patientReason: null }).success).toBe(true);
    expect(TcReferralFieldsEdit.safeParse({ patientReason: "x".repeat(TC_REFERRAL_PATIENT_REASON_MAX + 1) }).success).toBe(false);
    expect(TC_REFERRAL_PATIENT_REASON_MAX).toBe(200);
    const before = { directoryEntryId: null, urgency: "soon" as const, reason: "r", teeth: [3], patientReason: null };
    expect(referralEditSummary(before, { patientReason: "a check of your gums" })).toEqual(["reason in plain words"]);
    expect(referralEditSummary({ ...before, patientReason: "same" }, { patientReason: "same" })).toEqual([]);
  });
});

describe("changedFields", () => {
  const base = { directoryEntryId: "", urgency: "soon" as const, reason: "Possible cracked tooth", teeth: [3] };
  it("sends it only when it changed; blank clears to null", () => {
    expect(changedFields(referral(), { ...base, patientReason: "" }, false)).toEqual({});
    expect(changedFields(referral(), { ...base, patientReason: " a check of your gums " }, false)).toEqual({
      patientReason: "a check of your gums",
    });
    expect(changedFields(referral({ patientReason: "old words" }), { ...base, patientReason: "  " }, false)).toEqual({
      patientReason: null,
    });
  });
});

describe("the form, on both surfaces", () => {
  it.each([
    ["the hub (staff)", false],
    ["sign-off (the doctor)", true],
  ])("%s: the field is there, says it is for the patient's email, and saves only it", (_name, doctor) => {
    const onSave = vi.fn();
    form(referral(), onSave, doctor);
    const input = screen.getByLabelText("Reason in plain words (for the patient's email)") as HTMLInputElement;
    expect(input.maxLength).toBe(TC_REFERRAL_PATIENT_REASON_MAX);
    expect(screen.getByText(/clinical reason above is never sent to the patient/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "an evaluation of a sore tooth" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ patientReason: "an evaluation of a sore tooth" });
  });

  it("opens on the saved words, and clearing them sends null", () => {
    const onSave = vi.fn();
    form(referral({ patientReason: "a check of your gums" }), onSave);
    const input = screen.getByLabelText("Reason in plain words (for the patient's email)") as HTMLInputElement;
    expect(input.value).toBe("a check of your gums");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ patientReason: null });
  });
});
