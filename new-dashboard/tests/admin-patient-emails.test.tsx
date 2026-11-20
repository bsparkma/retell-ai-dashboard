/**
 * EL-1: /admin/patient-emails, the TC patient email library's wording + preview.
 *
 *   - the draft banner shows while the server says the library is unapproved
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
  libraryVersion: "1.1.0",
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
    { id: "review_referral", label: "Review request", phase: "After", use: "", inUse: true },
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
    missing: [{ field: "schedule_link", stages: ["tp_recap"] }],
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
    bodyText: "Hi Jordan,\n\nYou can book online at {{schedule_link}}, or call us at {{office_phone}}.\n\nTC User",
    mergeFields: ["first_name", "office_phone", "schedule_link", "sender_name"],
    unresolved: ["office_phone", "schedule_link"],
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
  it("shows the draft banner, the grouped questionnaire and a highlighted preview", async () => {
    render(<AdminPatientEmails />);
    expect((await screen.findByTestId("patient-emails-draft-banner")).textContent).toContain(
      "Draft wording, pending doctor review. Nothing is sent from this page.",
    );
    expect(screen.getByTestId("patient-emails-section-Office basics")).toBeTruthy();
    expect(screen.getByTestId("patient-emails-section-Technology")).toBeTruthy();
    // show_if: the follow-up is hidden until its yes/no is on.
    expect(screen.queryByTestId("patient-emails-q-same_day_length")).toBeNull();
    fireEvent.click(within(screen.getByTestId("patient-emails-q-same_day_crowns")).getByRole("checkbox"));
    expect(screen.getByTestId("patient-emails-q-same_day_length")).toBeTruthy();

    expect(screen.getByTestId("patient-emails-missing-schedule_link").textContent).toContain("Treatment recap");
    await waitFor(() => expect(screen.getAllByTestId("patient-emails-unresolved-token").length).toBe(2), { timeout: 2000 });
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

  it("no banner once the server says the library is approved", async () => {
    apiMock.getEmailLibraryCatalog.mockResolvedValue({ ...CATALOG, clinicallyApproved: true });
    render(<AdminPatientEmails />);
    await screen.findByTestId("patient-emails-questionnaire");
    expect(screen.queryByTestId("patient-emails-draft-banner")).toBeNull();
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
