/**
 * EL-1: /admin/patient-emails, the TC patient email library's wording + preview.
 *
 *   - the library status line (EL-2: the draft banner is retired) says whether the library is doctor-reviewed
 *   - the questionnaire is grouped by section; show_if hides a follow-up question
 *   - an edit previews with the UNSAVED answers (server-side compose, debounced)
 *   - Save sends the validated answers and says "Saved" only after the server's
 *     read-back, then shows exactly what was read back
 *   - a refused save says "Not saved", never "Saved"
 *   - a bad answer is named on its field; Save is off and no preview is asked for
 *   - non-admins (canEdit false) get the page read-only, with no Save button
 *   - unresolved merge fields are highlighted and listed
 *   - the route is tc.full (not /admin's admin.all); the hub card needs TC
 *
 * NO NETWORK: the page's API module is mocked. Sample data only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type {
  EmailLibraryCatalogResponse,
  EmailLibraryPreviewResponse,
  EmailLibraryProfileResponse,
} from "@shared/tc/emailLibrary";
import { TcApiError } from "@/features/tc/api";

const apiMock = vi.hoisted(() => ({
  getEmailLibraryCatalog: vi.fn(),
  getEmailLibraryProfile: vi.fn(),
  saveEmailLibraryProfile: vi.fn(),
  previewEmailLibrary: vi.fn(),
}));
vi.mock("@/features/tc/emailLibrary/emailLibraryApi", () => apiMock);
vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  useOffice: () => ({
    office: "roland",
    offices: [{ officeId: "roland", officeName: "Roland" }],
    loading: false,
    error: null,
  }),
}));

import AdminPatientEmails from "@/pages/AdminPatientEmails";
import { canVisit, requiredActionFor } from "@/lib/permissions";
import { HUB_CARDS, visibleHubCards } from "@/pages/admin/settingsHub";

const q = (over: Partial<EmailLibraryCatalogResponse["questions"][number]> & Pick<EmailLibraryCatalogResponse["questions"][number], "id" | "type" | "label" | "section">) => ({
  help: "",
  options: [],
  default: null,
  show_if: null,
  placeholder: "",
  ...over,
});

const CATALOG: EmailLibraryCatalogResponse = {
  success: true,
  office: "roland",
  libraryVersion: "1.2.0",
  clinicallyApproved: false,
  status: "DRAFT",
  rulesOfUse: [],
  procedures: [
    { id: "crown", name: "Crown", category: "Restorative", audience: "self" },
    { id: "filling", name: "Tooth-Colored Filling", category: "Restorative", audience: "self" },
  ],
  allProcedures: [
    { id: "crown", name: "Crown", category: "Restorative", audience: "self" },
    { id: "filling", name: "Tooth-Colored Filling", category: "Restorative", audience: "self" },
  ],
  stages: [
    { id: "tp_recap", label: "Treatment recap", phase: "Unscheduled", use: "", inUse: true },
    { id: "post_op_checkin", label: "Post-op check-in", phase: "After", use: "", inUse: true },
  ],
  variants: { A: "Warm and personal", B: "Short and direct", C: "Educational" },
  sequences: [],
  questions: [
    q({ id: "doctor_name", section: "Office basics", type: "text", label: "Doctor name as it should appear", placeholder: "Dr. Sample" }),
    q({ id: "schedule_link", section: "Office basics", type: "text", label: "Online scheduling link", placeholder: "https://" }),
    q({ id: "same_day_crowns", section: "Technology", type: "yesno", label: "Do you make crowns in the office the same day?" }),
    q({ id: "same_day_length", section: "Technology", type: "text", label: "How long is a typical same-day crown visit?", default: "about two hours", show_if: "same_day_crowns" }),
    q({
      id: "sedation",
      section: "Comfort",
      type: "multi",
      label: "Which relaxation options do you offer?",
      options: [
        { value: "nitrous", label: "Laughing gas", phrase: "laughing gas" },
        { value: "iv", label: "IV sedation", phrase: "IV sedation" },
      ],
    }),
  ],
  emailCount: 114,
};

function profile(over: Partial<EmailLibraryProfileResponse> = {}): EmailLibraryProfileResponse {
  return {
    success: true,
    office: "roland",
    saved: false,
    answers: {},
    libraryVersion: null,
    updatedBy: null,
    updatedAt: null,
    missing: [],
    blankOptional: ["schedule_link", "doctor_name"],
    canEdit: true,
    ...over,
  };
}

function preview(over: Partial<EmailLibraryPreviewResponse> = {}): EmailLibraryPreviewResponse {
  return {
    success: true,
    office: "roland",
    id: "crown.tp_recap.A",
    procedureId: "crown",
    procedureName: "Crown",
    stage: "tp_recap",
    stageLabel: "Treatment recap",
    variant: "A",
    tone: "Warm and personal",
    answersSource: "saved",
    subject: "Good seeing you, Jordan",
    preheader: "A quick recap of what we talked about.",
    bodyText: "Hi Jordan,\n\nReply to this email or call us at {{office_phone}}.\n\nTC User",
    mergeFields: ["first_name", "office_phone", "sender_name"],
    unresolved: ["office_phone"],
    wordCount: 20,
    clinicallyApproved: false,
    ...over,
  };
}

beforeEach(() => {
  apiMock.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
  apiMock.getEmailLibraryProfile.mockResolvedValue(profile());
  apiMock.previewEmailLibrary.mockResolvedValue(preview());
  apiMock.saveEmailLibraryProfile.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("/admin/patient-emails", () => {
  it("shows the library status, the grouped questionnaire and a highlighted preview", async () => {
    render(<AdminPatientEmails />);
    // EL-2: the amber draft banner is gone; an unapproved library says so in one line.
    expect(screen.queryByTestId("patient-emails-draft-banner")).toBeNull();
    expect((await screen.findByTestId("patient-emails-library-status")).textContent).toContain(
      "not doctor-reviewed: nurture campaigns cannot draft from it yet.",
    );
    expect(screen.getByTestId("patient-emails-section-Office basics")).toBeTruthy();
    expect(screen.getByTestId("patient-emails-section-Technology")).toBeTruthy();
    // show_if: the follow-up is hidden until its yes/no is on.
    expect(screen.queryByTestId("patient-emails-q-same_day_length")).toBeNull();
    fireEvent.click(within(screen.getByTestId("patient-emails-q-same_day_crowns")).getByRole("checkbox"));
    expect(screen.getByTestId("patient-emails-q-same_day_length")).toBeTruthy();

    await waitFor(() => expect(screen.getAllByTestId("patient-emails-unresolved-token").length).toBe(1), { timeout: 2000 });
    expect(screen.getByTestId("patient-emails-unresolved").textContent).toContain("{{office_phone}}");
  });

  it("an edit previews with the unsaved answers; Save says Saved only after the read-back", async () => {
    render(<AdminPatientEmails />);
    const input = await screen.findByLabelText("Doctor name as it should appear");
    await waitFor(() => expect(apiMock.previewEmailLibrary).toHaveBeenCalled(), { timeout: 2000 });
    expect(apiMock.previewEmailLibrary.mock.calls[0]?.[1]).toEqual({ procedure_id: "crown", stage: "tp_recap", variant: "A" });

    fireEvent.change(input, { target: { value: "  Dr. Sample " } });
    await waitFor(
      () =>
        expect(apiMock.previewEmailLibrary).toHaveBeenLastCalledWith("roland", {
          procedure_id: "crown",
          stage: "tp_recap",
          variant: "A",
          answers: { doctor_name: "Dr. Sample" },
        }),
      { timeout: 2000 },
    );

    let resolveSave: (v: EmailLibraryProfileResponse) => void = () => undefined;
    apiMock.saveEmailLibraryProfile.mockReturnValue(new Promise((r) => (resolveSave = r)));
    fireEvent.click(screen.getByTestId("patient-emails-save"));
    expect(apiMock.saveEmailLibraryProfile).toHaveBeenCalledWith("roland", { doctor_name: "Dr. Sample" });
    expect(screen.queryByTestId("patient-emails-saved")).toBeNull();

    resolveSave(
      profile({ saved: true, answers: { doctor_name: "Dr. Sample" }, updatedAt: "2026-11-19T15:00:00.000Z", updatedBy: "admin@example.test" }),
    );
    expect(await screen.findByTestId("patient-emails-saved")).toBeTruthy();
    expect((screen.getByLabelText("Doctor name as it should appear") as HTMLInputElement).value).toBe("Dr. Sample");
  });

  it("a refused save says Not saved, never Saved", async () => {
    render(<AdminPatientEmails />);
    fireEvent.change(await screen.findByLabelText("Online scheduling link"), { target: { value: "https://book.example.test" } });
    apiMock.saveEmailLibraryProfile.mockRejectedValue(new TcApiError("You do not have permission to do that", 403, "FORBIDDEN", null, []));
    fireEvent.click(screen.getByTestId("patient-emails-save"));
    expect((await screen.findByTestId("patient-emails-save-error")).textContent).toContain("Not saved");
    expect(screen.queryByTestId("patient-emails-saved")).toBeNull();
  });

  it("a bad answer is named on its field; Save is off and the preview is not asked for it", async () => {
    render(<AdminPatientEmails />);
    const input = await screen.findByLabelText("Doctor name as it should appear");
    await waitFor(() => expect(apiMock.previewEmailLibrary).toHaveBeenCalled(), { timeout: 2000 });
    const calls = apiMock.previewEmailLibrary.mock.calls.length;
    fireEvent.change(input, { target: { value: "Dr. {first_name}" } });
    expect((await screen.findByTestId("patient-emails-error-doctor_name")).textContent).toContain("{ } [ ] < >");
    expect((screen.getByTestId("patient-emails-save") as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByTestId("patient-emails-preview-error")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 600));
    expect(apiMock.previewEmailLibrary.mock.calls.length).toBe(calls);
  });

  it("a non-admin sees it read-only, with no Save button", async () => {
    apiMock.getEmailLibraryProfile.mockResolvedValue(profile({ canEdit: false }));
    render(<AdminPatientEmails />);
    expect(await screen.findByTestId("patient-emails-read-only")).toBeTruthy();
    expect(screen.queryByTestId("patient-emails-save")).toBeNull();
    expect((screen.getByLabelText("Doctor name as it should appear") as HTMLInputElement).disabled).toBe(true);
  });

  it("blank optional settings are neutral lines, and there is no Not-set box when nothing is missing", async () => {
    render(<AdminPatientEmails />);
    await screen.findByTestId("patient-emails-questionnaire");
    expect(screen.queryByTestId("patient-emails-missing")).toBeNull();
    expect(screen.getByTestId("patient-emails-blank-schedule_link").textContent).toBe(
      "No online scheduling link: emails ask patients to reply or call.",
    );
    expect(screen.getByTestId("patient-emails-blank-doctor_name").textContent).toBe('No doctor name: emails say "we".');
    // Neutral, not the amber warning box.
    expect(screen.getByTestId("patient-emails-blank-optional").className).not.toMatch(/amber/);
  });

  it("only the blank settings get a line; none when both are set", async () => {
    apiMock.getEmailLibraryProfile.mockResolvedValue(profile({ saved: true, answers: { doctor_name: "Dr. Sample" }, blankOptional: ["schedule_link"] }));
    render(<AdminPatientEmails />);
    await screen.findByTestId("patient-emails-blank-schedule_link");
    expect(screen.queryByTestId("patient-emails-blank-doctor_name")).toBeNull();
    cleanup();
    apiMock.getEmailLibraryProfile.mockResolvedValue(
      profile({ saved: true, answers: { doctor_name: "Dr. Sample", schedule_link: "https://book.example.test" }, blankOptional: [] }),
    );
    render(<AdminPatientEmails />);
    await screen.findByTestId("patient-emails-questionnaire");
    expect(screen.queryByTestId("patient-emails-blank-optional")).toBeNull();
  });

  it("the amber Not-set box shows only when the server lists a setting still printed as a token", async () => {
    apiMock.getEmailLibraryProfile.mockResolvedValue(profile({ missing: [{ field: "schedule_link", stages: ["tp_recap"] }] }));
    render(<AdminPatientEmails />);
    expect((await screen.findByTestId("patient-emails-missing-schedule_link")).textContent).toContain("Treatment recap");
  });

  it("no banner once the server says the library is approved; the status line says doctor-reviewed", async () => {
    apiMock.getEmailLibraryCatalog.mockResolvedValue({ ...CATALOG, clinicallyApproved: true });
    render(<AdminPatientEmails />);
    await screen.findByTestId("patient-emails-questionnaire");
    expect(screen.queryByTestId("patient-emails-draft-banner")).toBeNull();
    expect(screen.getByTestId("patient-emails-library-status").textContent).toBe(
      `Library v${CATALOG.libraryVersion}, doctor-reviewed.`,
    );
  });
});

describe("/admin/patient-emails gating and the hub card", () => {
  it("the page is tc.full, not /admin's admin.all", () => {
    expect(requiredActionFor("/admin/patient-emails")).toBe("tc.full");
    expect(canVisit(["tc.full"], "/admin/patient-emails")).toBe(true);
    expect(canVisit(["admin.all"], "/admin/patient-emails")).toBe(false);
    expect(canVisit(["admin.all", "tc.full"], "/admin/patient-emails")).toBe(true);
  });

  it("the hub card needs the TC module and the page's permission", () => {
    const card = HUB_CARDS.find((c) => c.id === "patient-emails");
    expect(card?.href).toBe("/admin/patient-emails");
    expect(card?.group).toBe("module");
    expect(visibleHubCards(["admin.all", "tc.full"], ["tc"]).some((c) => c.id === "patient-emails")).toBe(true);
    expect(visibleHubCards(["admin.all", "tc.full"], ["voice"]).some((c) => c.id === "patient-emails")).toBe(false);
  });
});

// ── EL-1c: library 1.3.0's six new questions ────────────────────────────────

const V13_QUESTIONS = [
  q({ id: "laser", section: "Technology", type: "yesno", label: "Do you use a dental laser?", help: "Soft-tissue or hard-tissue laser." }),
  q({ id: "surgical_guides", section: "Technology", type: "yesno", label: "Do you place implants with surgical guides?", show_if: "implant_surgery=in_house" }),
  q({
    id: "sedation_kids",
    section: "Comfort",
    type: "multi",
    label: "Which relaxation options do you offer children?",
    options: [
      { value: "nitrous", label: "Laughing gas", phrase: "laughing gas" },
      { value: "oral", label: "Oral sedation", phrase: "oral sedation" },
      { value: "iv", label: "IV sedation", phrase: "IV sedation" },
    ],
  }),
  q({
    id: "parent_in_room",
    section: "Comfort",
    type: "select",
    label: "Can a parent stay in the room?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "child_first", label: "Child first, then parent" },
      { value: "no", label: "No" },
    ],
  }),
  q({
    id: "new_patient_welcome",
    section: "Comfort",
    type: "multi",
    label: "What does a new patient's first visit include?",
    options: [
      { value: "xrays", label: "X-rays" },
      { value: "tour", label: "A tour" },
    ],
  }),
  q({
    id: "implant_surgery",
    section: "Services",
    type: "select",
    label: "Who places implants?",
    default: "in_house",
    options: [
      { value: "in_house", label: "We do" },
      { value: "specialist", label: "A specialist" },
    ],
  }),
  q({ id: "immediate_implants", section: "Services", type: "yesno", label: "Do you offer same-day implants?", show_if: "implant_surgery=in_house" }),
  q({
    id: "sleep_test",
    section: "Services",
    type: "select",
    label: "How do patients get a sleep test?",
    options: [
      { value: "home_test", label: "Home sleep test" },
      { value: "both", label: "Either" },
      { value: "refer", label: "We refer" },
    ],
  }),
];
const CATALOG_V13: EmailLibraryCatalogResponse = {
  ...CATALOG,
  libraryVersion: "1.3.0",
  questions: [...CATALOG.questions, ...V13_QUESTIONS],
};

describe("/admin/patient-emails, library 1.3.0", () => {
  it("renders the six new questions in their sections with the existing controls", async () => {
    apiMock.getEmailLibraryCatalog.mockResolvedValue(CATALOG_V13);
    render(<AdminPatientEmails />);
    const tech = await screen.findByTestId("patient-emails-section-Technology");
    const comfort = screen.getByTestId("patient-emails-section-Comfort");
    const services = screen.getByTestId("patient-emails-section-Services");
    expect(within(tech).getByTestId("patient-emails-q-surgical_guides").querySelector("input[type=checkbox]")).toBeTruthy();
    expect(within(comfort).getByTestId("patient-emails-opt-sedation_kids-oral")).toBeTruthy();
    expect(within(comfort).getByTestId("patient-emails-opt-new_patient_welcome-tour")).toBeTruthy();
    expect(within(comfort).getByTestId("patient-emails-q-parent_in_room").querySelector("select")).toBeTruthy();
    expect(within(services).getByTestId("patient-emails-q-immediate_implants").querySelector("input[type=checkbox]")).toBeTruthy();
    expect(within(services).getByTestId("patient-emails-q-sleep_test").querySelector("select")).toBeTruthy();
    expect(within(tech).getByTestId("patient-emails-q-laser").textContent).toContain("Soft-tissue or hard-tissue laser.");
  });

  it("show_if `implant_surgery=in_house` reads the library default, and hiding drops the stale answer from preview and save", async () => {
    apiMock.getEmailLibraryCatalog.mockResolvedValue(CATALOG_V13);
    apiMock.getEmailLibraryProfile.mockResolvedValue(
      profile({ saved: true, answers: { surgical_guides: true, immediate_implants: true }, libraryVersion: "1.3.0" }),
    );
    render(<AdminPatientEmails />);
    // Unanswered implant_surgery reads as its default (in_house): both follow-ups show.
    expect(await screen.findByTestId("patient-emails-q-surgical_guides")).toBeTruthy();
    expect(screen.getByTestId("patient-emails-q-immediate_implants")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Who places implants?"), { target: { value: "specialist" } });
    expect(screen.queryByTestId("patient-emails-q-surgical_guides")).toBeNull();
    expect(screen.queryByTestId("patient-emails-q-immediate_implants")).toBeNull();

    await waitFor(
      () =>
        expect(apiMock.previewEmailLibrary).toHaveBeenLastCalledWith("roland", {
          procedure_id: "crown",
          stage: "tp_recap",
          variant: "A",
          answers: { implant_surgery: "specialist" },
        }),
      { timeout: 2000 },
    );
    apiMock.saveEmailLibraryProfile.mockResolvedValue(
      profile({ saved: true, answers: { implant_surgery: "specialist" }, updatedAt: "2026-11-23T15:00:00.000Z", updatedBy: "admin@example.test" }),
    );
    fireEvent.click(screen.getByTestId("patient-emails-save"));
    expect(apiMock.saveEmailLibraryProfile).toHaveBeenCalledWith("roland", { implant_surgery: "specialist" });
    expect(await screen.findByTestId("patient-emails-saved")).toBeTruthy();

    // Back to in_house: the follow-ups return, unanswered.
    fireEvent.change(screen.getByLabelText("Who places implants?"), { target: { value: "in_house" } });
    const guides = within(screen.getByTestId("patient-emails-q-surgical_guides")).getByRole("checkbox") as HTMLInputElement;
    expect(guides.checked).toBe(false);
  });

  it("the new selects and multis send declared values", async () => {
    apiMock.getEmailLibraryCatalog.mockResolvedValue(CATALOG_V13);
    render(<AdminPatientEmails />);
    fireEvent.change(await screen.findByLabelText("Can a parent stay in the room?"), { target: { value: "child_first" } });
    fireEvent.change(screen.getByLabelText("How do patients get a sleep test?"), { target: { value: "home_test" } });
    fireEvent.click(screen.getByTestId("patient-emails-opt-sedation_kids-nitrous"));
    fireEvent.click(screen.getByTestId("patient-emails-opt-new_patient_welcome-tour"));
    fireEvent.click(screen.getByTestId("patient-emails-opt-new_patient_welcome-xrays"));
    apiMock.saveEmailLibraryProfile.mockResolvedValue(profile({ saved: true }));
    fireEvent.click(screen.getByTestId("patient-emails-save"));
    expect(apiMock.saveEmailLibraryProfile).toHaveBeenCalledWith("roland", {
      parent_in_room: "child_first",
      sleep_test: "home_test",
      sedation_kids: ["nitrous"],
      new_patient_welcome: ["xrays", "tour"],
    });
  });
});
