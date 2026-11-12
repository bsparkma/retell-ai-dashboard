/**
 * Per-office referral note templates (Beau's ruling: both places, per-office
 * wording) — the dashboard side.
 *
 *   1. The shared rules: the closed menu, an unknown placeholder or a stray
 *      brace refused by name, the fill (an empty value is a visible gap).
 *   2. Settings → Referrals → "Referral templates": per kind, a live preview
 *      with sample values; an unknown placeholder disables Save and is named;
 *      Save sends the office + kind + text and shows the read-back; a
 *      non-admin sees the wording read-only.
 *   3. The referral form: "Notes for the specialist" starts from the
 *      template, filled from the form AS IT CHANGES (pick a specialist, type a
 *      reason) — until someone types in it, after which it is theirs. What is
 *      saved is exactly what is in the field. A referral that already has
 *      notes is never overwritten. No template, or a failed read: no prefill.
 *   4. Log correspondence: the note starts from the office's template, filled
 *      from the referral; it can be edited freely and what is logged is what
 *      is in the field.
 *
 * No PHI: the patient is the synthetic Roland fixture (12827).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralTemplates: vi.fn(),
    saveReferralTemplate: vi.fn(),
    logReferralCorrespondence: vi.fn(),
    uploadReferralAttachment: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { ReferralTemplatesCard } from "@/features/tc/settings/ReferralTemplatesCard";
import { ReferralDialog } from "@/features/tc/referrals/ReferralsPanel";
import { LogCorrespondence } from "@/features/tc/referrals/LogCorrespondence";
import {
  REFERRAL_TEMPLATE_BLANK,
  REFERRAL_TEMPLATE_PLACEHOLDERS,
  fillReferralTemplate,
  validateReferralTemplate,
  type ReferralTemplateState,
  type ReferralTemplatesResponse,
} from "@shared/tc/referralTemplates";
import type { TcReferral, TcReferralDirectoryEntry } from "@shared/tc/referrals";

const ENTRY_ID = "7a1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";

const MESSAGE = "Dear {specialist_name}, please evaluate {teeth} for {reason}. Thank you, {referring_provider}.";
const NOTE = "Spoke with {specialist_name} ({specialty}) about {reason}.";

function templates(over: Partial<Record<"specialist_message" | "correspondence_note", string>> = {}): ReferralTemplateState[] {
  return [
    { kind: "specialist_message", body: over.specialist_message ?? "", updatedBy: null, updatedAt: null },
    { kind: "correspondence_note", body: over.correspondence_note ?? "", updatedBy: null, updatedAt: null },
  ];
}

function response(t: ReferralTemplateState[], canEdit = true): ReferralTemplatesResponse {
  return { success: true, office: "roland", canEdit, templates: t };
}

const ENTRY: TcReferralDirectoryEntry = {
  entryId: ENTRY_ID,
  practiceName: "River Endodontics",
  specialistName: "Dr. Endo Example",
  specialty: "Endodontics",
  contactPerson: "",
  email: "referrals@endo.example",
  phone: "",
  fax: "",
  notes: "",
  preferredFormatNotes: "",
  active: true,
  createdBy: "tc@carein.ai",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
} as TcReferralDirectoryEntry;

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: RID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "case",
    sourceRef: "case-1",
    referringProvider: "Dr. Sample Provider",
    directoryEntryId: ENTRY_ID,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "cracked tooth",
    teeth: [30],
    urgency: "routine",
    narrative: "",
    status: "sent",
    statusChangedAt: "2026-11-02T10:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    specialistName: "Dr. Endo Example",
    ...over,
  } as TcReferral;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

// ── 1 ───────────────────────────────────────────────────────────────────────

describe("the shared rules", () => {
  it("accepts every menu name; refuses an unknown one by name, and a stray brace", () => {
    expect(validateReferralTemplate(REFERRAL_TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(" "))).toEqual([]);
    const unknown = validateReferralTemplate("Re {patient_name} and {dob}");
    expect(unknown.map((p) => p.code)).toEqual(["REFERRAL_TEMPLATE_UNKNOWN_PLACEHOLDER", "REFERRAL_TEMPLATE_UNKNOWN_PLACEHOLDER"]);
    expect(unknown[0].message).toMatch(/\{patient_name\}/);
    expect(validateReferralTemplate("Re {reason").map((p) => p.code)).toEqual(["REFERRAL_TEMPLATE_MALFORMED_PLACEHOLDER"]);
    expect(validateReferralTemplate("Re {}").map((p) => p.code)).toEqual(["REFERRAL_TEMPLATE_MALFORMED_PLACEHOLDER"]);
  });

  it("fills only menu names; an empty value is a visible gap", () => {
    expect(fillReferralTemplate("{specialist_name} / {reason}", { specialist_name: "Dr. A", reason: "  " })).toBe(
      `Dr. A / ${REFERRAL_TEMPLATE_BLANK}`,
    );
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────

describe("Settings: Referral templates", () => {
  it("shows both kinds with a live preview; Save sends the text and shows the read-back", async () => {
    ref.getReferralTemplates.mockResolvedValue(response(templates({ correspondence_note: NOTE })));
    ref.saveReferralTemplate.mockImplementation(async (_office: string, kind: string, body: string) => ({
      kind,
      body,
      updatedBy: "admin@carein.ai",
      updatedAt: "2026-11-11T12:00:00.000Z",
    }));
    render(<ReferralTemplatesCard office="roland" />);

    const message = await screen.findByTestId("tc-ref-template-specialist_message");
    const note = screen.getByTestId("tc-ref-template-correspondence_note");
    expect(ref.getReferralTemplates).toHaveBeenCalledWith("roland");
    expect((within(note).getByTestId("tc-ref-template-correspondence_note-input") as HTMLTextAreaElement).value).toBe(NOTE);
    expect(within(note).getByTestId("tc-ref-template-correspondence_note-preview").textContent).toBe(
      "Spoke with Dr. Sample Specialist (Endodontics) about Evaluate for root canal therapy.",
    );
    expect(within(message).getByTestId("tc-ref-template-specialist_message-preview").textContent).toMatch(/No prefill/);

    const save = within(message).getByTestId("tc-ref-template-specialist_message-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(message).getByTestId("tc-ref-template-specialist_message-input"), { target: { value: MESSAGE } });
    expect(within(message).getByTestId("tc-ref-template-specialist_message-preview").textContent).toBe(
      "Dear Dr. Sample Specialist, please evaluate #3, #14 for Evaluate for root canal therapy. Thank you, Dr. Sample Provider.",
    );
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(ref.saveReferralTemplate).toHaveBeenCalledWith("roland", "specialist_message", MESSAGE));
    await within(message).findByText(/Saved by admin@carein.ai/);
  });

  it("an unknown placeholder is named and Save stays off; the insert buttons add menu tokens", async () => {
    ref.getReferralTemplates.mockResolvedValue(response(templates()));
    render(<ReferralTemplatesCard office="roland" />);
    const message = await screen.findByTestId("tc-ref-template-specialist_message");
    const input = within(message).getByTestId("tc-ref-template-specialist_message-input") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "Re {patient_name}" } });
    expect(within(message).getByTestId("tc-ref-template-specialist_message-problem").textContent).toMatch(/\{patient_name\}/);
    expect((within(message).getByTestId("tc-ref-template-specialist_message-save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Re " } });
    input.setSelectionRange(3, 3);
    fireEvent.click(within(message).getByTestId("tc-ref-template-specialist_message-insert-reason"));
    expect(input.value).toBe("Re {reason}");
    expect(within(message).queryByTestId("tc-ref-template-specialist_message-problem")).toBeNull();
    expect(ref.saveReferralTemplate).not.toHaveBeenCalled();
  });

  it("a server refusal is shown and nothing claims to be saved", async () => {
    ref.getReferralTemplates.mockResolvedValue(response(templates()));
    ref.saveReferralTemplate.mockRejectedValue(new Error("{x} is not on the placeholder menu."));
    render(<ReferralTemplatesCard office="roland" />);
    const message = await screen.findByTestId("tc-ref-template-specialist_message");
    fireEvent.change(within(message).getByTestId("tc-ref-template-specialist_message-input"), { target: { value: "Hi" } });
    fireEvent.click(within(message).getByTestId("tc-ref-template-specialist_message-save"));
    await within(message).findByRole("alert");
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(within(message).getByText(/Not set for this office yet/)).toBeTruthy();
  });

  it("a non-admin sees the wording read-only, with no Save and no insert buttons", async () => {
    ref.getReferralTemplates.mockResolvedValue(response(templates({ specialist_message: MESSAGE }), false));
    render(<ReferralTemplatesCard office="valley" />);
    const message = await screen.findByTestId("tc-ref-template-specialist_message");
    expect(ref.getReferralTemplates).toHaveBeenCalledWith("valley");
    expect((within(message).getByTestId("tc-ref-template-specialist_message-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect(within(message).queryByTestId("tc-ref-template-specialist_message-save")).toBeNull();
    expect(within(message).queryByTestId("tc-ref-template-specialist_message-insert-reason")).toBeNull();
    expect(screen.getByText(/A practice admin can change them/)).toBeTruthy();
  });
});

// ── 3 ───────────────────────────────────────────────────────────────────────

function dialog(opts: { editing?: TcReferral | null; loadTemplates?: () => Promise<ReferralTemplateState[]> } = {}) {
  const onSave = vi.fn();
  render(
    <ReferralDialog
      open
      editing={opts.editing ?? null}
      onClose={vi.fn()}
      onSave={onSave}
      saving={false}
      loadDirectory={async () => [ENTRY]}
      loadTemplates={opts.loadTemplates}
    />,
  );
  return onSave;
}

const notes = () => screen.getByLabelText("Notes for the specialist") as HTMLTextAreaElement;

describe("the referral form: Notes for the specialist", () => {
  it("starts from the template and follows the form until someone types; what is saved is the field", async () => {
    const onSave = dialog({ loadTemplates: async () => templates({ specialist_message: MESSAGE }) });
    await screen.findByTestId("tc-referral-notes-prefilled");
    expect(notes().value).toBe(
      `Dear ${REFERRAL_TEMPLATE_BLANK}, please evaluate ${REFERRAL_TEMPLATE_BLANK} for ${REFERRAL_TEMPLATE_BLANK}. Thank you, ${REFERRAL_TEMPLATE_BLANK}.`,
    );

    // The form fills it in as it changes.
    await screen.findByRole("option", { name: /River Endodontics/ });
    fireEvent.change(screen.getByLabelText("Specialist"), { target: { value: ENTRY_ID } });
    fireEvent.change(screen.getByLabelText("Reason *"), { target: { value: "possible cracked tooth" } });
    fireEvent.change(screen.getByLabelText("Teeth"), { target: { value: "3, 14" } });
    await waitFor(() =>
      expect(notes().value).toBe(`Dear Dr. Endo Example, please evaluate #3, #14 for possible cracked tooth. Thank you, ${REFERRAL_TEMPLATE_BLANK}.`),
    );

    // Someone edits it: from now on it is theirs.
    fireEvent.change(notes(), { target: { value: "Dear Dr. Endo Example, my own words." } });
    expect(screen.queryByTestId("tc-referral-notes-prefilled")).toBeNull();
    fireEvent.change(screen.getByLabelText("Reason *"), { target: { value: "endo evaluation" } });
    expect(notes().value).toBe("Dear Dr. Endo Example, my own words.");

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].narrative).toBe("Dear Dr. Endo Example, my own words.");
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("patNum");
  });

  it("a prefill saved unedited is saved exactly as shown", async () => {
    const onSave = dialog({ loadTemplates: async () => templates({ specialist_message: "Please see {reason}." }) });
    fireEvent.change(screen.getByLabelText("Reason *"), { target: { value: "a cracked tooth" } });
    await waitFor(() => expect(notes().value).toBe("Please see a cracked tooth."));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onSave.mock.calls[0][0].narrative).toBe("Please see a cracked tooth.");
  });

  it("editing a referral that already has notes never overwrites them; empty notes take the prefill", async () => {
    dialog({
      editing: referral({ status: "draft", narrative: "Already written." }),
      loadTemplates: async () => templates({ specialist_message: MESSAGE }),
    });
    await screen.findByRole("option", { name: /River Endodontics/ });
    await new Promise((r) => setTimeout(r, 0));
    expect(notes().value).toBe("Already written.");
    expect(screen.queryByTestId("tc-referral-notes-prefilled")).toBeNull();
    cleanup();

    dialog({
      editing: referral({ status: "draft", narrative: "" }),
      loadTemplates: async () => templates({ specialist_message: "For {reason} on {teeth}." }),
    });
    await waitFor(() => expect(notes().value).toBe("For cracked tooth on #30."));
  });

  it("no template, a blank one, or a failed read: no prefill", async () => {
    dialog({ loadTemplates: async () => templates() });
    await screen.findByRole("option", { name: /River Endodontics/ });
    expect(notes().value).toBe("");
    cleanup();
    dialog({ loadTemplates: async () => Promise.reject(new Error("offline")) });
    await screen.findByRole("option", { name: /River Endodontics/ });
    expect(notes().value).toBe("");
    cleanup();
    dialog({});
    await screen.findByRole("option", { name: /River Endodontics/ });
    expect(notes().value).toBe("");
  });
});

// ── 4 ───────────────────────────────────────────────────────────────────────

describe("Log correspondence: the note", () => {
  function logForm(r = referral()) {
    const onLogged = vi.fn();
    render(<LogCorrespondence office="roland" referral={r} filesAttached={0} onLogged={onLogged} onFilesChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("tc-hub-correspondence-open"));
    return onLogged;
  }
  const noteField = () => screen.getByLabelText("What was said *") as HTMLTextAreaElement;

  it("starts from the office's template, filled from the referral, and is editable; what is logged is the field", async () => {
    ref.getReferralTemplates.mockResolvedValue(response(templates({ correspondence_note: NOTE })));
    ref.logReferralCorrespondence.mockImplementation(async () => referral());
    const onLogged = logForm();
    await waitFor(() => expect(noteField().value).toBe("Spoke with Dr. Endo Example (Endodontics) about cracked tooth."));
    expect(ref.getReferralTemplates).toHaveBeenCalledWith("roland");

    fireEvent.change(noteField(), { target: { value: "Spoke with Dr. Endo Example: booked Nov 20." } });
    fireEvent.click(screen.getByTestId("tc-hub-correspondence-save"));
    await waitFor(() => expect(ref.logReferralCorrespondence).toHaveBeenCalledTimes(1));
    expect(ref.logReferralCorrespondence.mock.calls[0]).toEqual([
      "roland",
      RID,
      { direction: "from", party: "specialist", channel: "phone", note: "Spoke with Dr. Endo Example: booked Nov 20." },
    ]);
    await waitFor(() => expect(onLogged).toHaveBeenCalled());
  });

  it("no template: the note starts empty, as before", async () => {
    ref.getReferralTemplates.mockResolvedValue(response(templates()));
    logForm();
    await waitFor(() => expect(ref.getReferralTemplates).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(noteField().value).toBe("");
  });

  it("a template that arrives after someone started typing never replaces their words", async () => {
    let release: (v: ReferralTemplatesResponse) => void = () => {};
    ref.getReferralTemplates.mockReturnValue(new Promise<ReferralTemplatesResponse>((r) => (release = r)));
    logForm();
    fireEvent.change(noteField(), { target: { value: "Typed first" } });
    release(response(templates({ correspondence_note: NOTE })));
    await new Promise((r) => setTimeout(r, 0));
    expect(noteField().value).toBe("Typed first");
  });
});
