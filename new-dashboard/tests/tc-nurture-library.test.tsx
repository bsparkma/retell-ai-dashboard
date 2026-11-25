/**
 * EL-2: the patient email library inside nurture, on the dashboard.
 *
 *   - Start Nurture: an optional "Use the patient email library for…" section —
 *     procedure (this office's catalog, grouped by category) + tone (Warm /
 *     Direct / Educational, default Warm). A track starts from the library with
 *     exactly the chosen procedure and tone; a track the server says cannot
 *     start from the library is disabled WITH the server's reason; when no
 *     track can, the section is disabled and says why. The hand-written start
 *     is unchanged (three arguments, no library fields).
 *   - The campaign strip names a library enrollment's procedure and tone and
 *     counts against the server's stepCount.
 *   - The Nurture Outbox names the procedure + tone of a library draft and its
 *     stage label ("Why it matters"); a hand-written draft still shows its
 *     touch key.
 *
 * NO NETWORK: both APIs are mocked. Designated test-patient names only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { TcMessage } from "@shared/tc/messaging";
import type { NurtureCaseResponse, NurtureOutboxResponse, TcNurtureEnrollment } from "@shared/tc/nurture";

(globalThis as Record<string, unknown>).React = React;

const api = vi.hoisted(() => ({
  getNurtureOutbox: vi.fn(),
  skipNurtureDraft: vi.fn(),
  getCaseNurture: vi.fn(),
  startNurture: vi.fn(),
  pauseNurture: vi.fn(),
  resumeNurture: vi.fn(),
  stopNurture: vi.fn(),
  getEmailLibraryCatalog: vi.fn(),
}));
vi.mock("@/features/tc/nurture/campaignApi", () => ({
  getNurtureOutbox: api.getNurtureOutbox,
  skipNurtureDraft: api.skipNurtureDraft,
  getCaseNurture: api.getCaseNurture,
  startNurture: api.startNurture,
  pauseNurture: api.pauseNurture,
  resumeNurture: api.resumeNurture,
  stopNurture: api.stopNurture,
}));
vi.mock("@/features/tc/emailLibrary/emailLibraryApi", () => ({
  getEmailLibraryCatalog: api.getEmailLibraryCatalog,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NurtureOutbox } from "@/features/tc/nurture/NurtureOutbox";
import { NurtureCampaignBar } from "@/features/tc/nurture/NurtureCampaignBar";

const CASE_A = "11111111-1111-4111-8111-111111111111";
const ENR_A = "22222222-2222-4222-8222-222222222222";

/** The slice of the catalog these components read. */
const CATALOG = {
  success: true,
  office: "roland",
  libraryVersion: "1.3.0",
  clinicallyApproved: true,
  status: "",
  rulesOfUse: [],
  procedures: [
    { id: "crown", name: "Dental Crown", category: "Restorative", audience: "adult" },
    { id: "filling", name: "Tooth-Colored Filling", category: "Restorative", audience: "adult" },
    { id: "implant", name: "Dental Implant", category: "Implants", audience: "adult" },
  ],
  allProcedures: [
    { id: "crown", name: "Dental Crown", category: "Restorative", audience: "adult" },
    { id: "filling", name: "Tooth-Colored Filling", category: "Restorative", audience: "adult" },
    { id: "implant", name: "Dental Implant", category: "Implants", audience: "adult" },
    { id: "braces", name: "Braces", category: "Orthodontics", audience: "adult" },
  ],
  stages: [
    { id: "tp_recap", label: "Treatment recap", phase: "", use: "", inUse: true },
    { id: "why_it_matters", label: "Why it matters", phase: "", use: "", inUse: true },
  ],
  variants: { A: "Warm and personal", B: "Short and direct", C: "Educational" },
  sequences: [],
  questions: [],
  emailCount: 0,
};

const TRACKS: NurtureCaseResponse["tracks"] = [
  { trackKey: "no_show_recovery", label: "No-Show Recovery", goal: "Reschedule.", intensity: "standard", touchCount: 3, channels: ["sms", "email"], available: true, reason: null, libraryAvailable: true, libraryBlockedReason: null },
  { trackKey: "warm_followup", label: "Warm Follow-Up", goal: "Schedule.", intensity: "gentle", touchCount: 4, channels: ["email", "sms"], available: true, reason: null, libraryAvailable: true, libraryBlockedReason: null },
  { trackKey: "reactivation", label: "Reactivation Drip", goal: "Re-engage.", intensity: "gentle", touchCount: 4, channels: ["email"], available: true, reason: null, libraryAvailable: false, libraryBlockedReason: "This case has no email address. Library campaigns are email only." },
  { trackKey: "large_case", label: "Large Case / Financing", goal: "Convert.", intensity: "assertive", touchCount: 7, channels: ["email", "sms"], available: true, reason: null, libraryAvailable: true, libraryBlockedReason: null },
];

function wrap(ui: React.ReactElement) {
  const { hook } = memoryLocation({ path: "/tc/cases/x" });
  return render(<WouterRouter hook={hook}>{ui}</WouterRouter>);
}

beforeEach(() => {
  api.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Start Nurture: the patient email library section", () => {
  it("starts a track from the library with the chosen procedure and tone", async () => {
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [], tracks: TRACKS } satisfies NurtureCaseResponse);
    api.startNurture.mockResolvedValue({});
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId("start-nurture"));
    const section = await screen.findByTestId("nurture-library-section");
    expect(section.textContent).toContain("Use the patient email library for…");

    fireEvent.click(screen.getByTestId("nurture-library-toggle"));
    const select = (await screen.findByTestId("nurture-library-procedure")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    // Grouped by category, office-filtered (braces is switched off: not offered).
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => [
      g.label,
      Array.from(g.querySelectorAll("option")).map((o) => o.textContent),
    ]);
    expect(groups).toEqual([
      ["Restorative", ["Dental Crown", "Tooth-Colored Filling"]],
      ["Implants", ["Dental Implant"]],
    ]);
    // Tone defaults to Warm.
    expect(screen.getByTestId("nurture-library-tone-A").getAttribute("aria-checked")).toBe("true");

    // No procedure yet: a library track cannot be started.
    expect((screen.getByTestId("track-warm_followup") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "crown" } });
    fireEvent.click(screen.getByTestId("nurture-library-tone-B"));
    expect(screen.getByTestId("track-warm_followup").textContent).toContain("Library sequence · Email");

    fireEvent.click(screen.getByTestId("track-warm_followup"));
    await waitFor(() =>
      expect(api.startNurture).toHaveBeenCalledWith("roland", CASE_A, "warm_followup", { procedureId: "crown", variant: "B" }),
    );
  });

  it("a track the server says cannot start from the library is disabled with the server's reason", async () => {
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [], tracks: TRACKS } satisfies NurtureCaseResponse);
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId("start-nurture"));
    fireEvent.click(await screen.findByTestId("nurture-library-toggle"));
    fireEvent.change(await screen.findByTestId("nurture-library-procedure"), { target: { value: "implant" } });
    const reactivation = screen.getByTestId("track-reactivation") as HTMLButtonElement;
    expect(reactivation.disabled).toBe(true);
    expect(screen.getByTestId("track-library-reason-reactivation").textContent).toBe(
      "This case has no email address. Library campaigns are email only.",
    );
    expect((screen.getByTestId("track-large_case") as HTMLButtonElement).disabled).toBe(false);
  });

  it("with the library off, the hand-written start is unchanged (no library fields)", async () => {
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [], tracks: TRACKS } satisfies NurtureCaseResponse);
    api.startNurture.mockResolvedValue({});
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId("start-nurture"));
    // The reactivation track is reachable by its hand-written channels.
    expect((await screen.findByTestId("track-reactivation")).textContent).toMatch(/Gentle · 4 touches/);
    fireEvent.click(screen.getByTestId("track-reactivation"));
    await waitFor(() => expect(api.startNurture).toHaveBeenCalledWith("roland", CASE_A, "reactivation"));
    expect(api.startNurture.mock.calls[0]).toHaveLength(3);
  });

  it("when no track can start from the library, the section is disabled and says why", async () => {
    const reason = "Set the office's office phone in Practice info & email identity first.";
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [],
      tracks: TRACKS.map((t) => ({ ...t, libraryAvailable: false, libraryBlockedReason: reason })),
    } satisfies NurtureCaseResponse);
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId("start-nurture"));
    expect(((await screen.findByTestId("nurture-library-toggle")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("nurture-library-unavailable").textContent).toBe(reason);
  });
});

const LIBRARY_RUNNING: TcNurtureEnrollment = {
  enrollmentId: ENR_A,
  caseId: CASE_A,
  officeId: "roland",
  trackKey: "warm_followup",
  intensityAtEnroll: "assertive",
  status: "active",
  stopReason: null,
  nextTouchIndex: 1,
  nextTouchDueAt: "2026-10-17T05:00:00.000Z",
  lastTouchAt: "2026-10-14T10:00:00.000Z",
  nextTouchKey: "why_it_matters",
  touchCount: 1,
  createdBy: "tc@carein.ai",
  createdAt: "2026-10-13T15:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  libraryProcedureId: "crown",
  libraryVariant: "A",
  stepCount: 10,
};

describe("the campaign strip on a library enrollment", () => {
  it("names the procedure and tone and counts against the library sequence, not the dial", async () => {
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [LIBRARY_RUNNING],
      tracks: TRACKS.map((t) => ({ ...t, available: false, reason: "already_enrolled" as const })),
    } satisfies NurtureCaseResponse);
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    expect((await screen.findByTestId("nurture-chip")).textContent).toBe("Warm Follow-Up");
    await waitFor(() =>
      expect(screen.getByTestId("nurture-chip-pace").textContent).toMatch(/^Library: Dental Crown · Warm · 1 of 10 drafted/),
    );
    expect(screen.getByTestId("nurture-chip-pace").textContent).not.toContain("Assertive");
  });
});

function msg(over: Partial<TcMessage>): TcMessage {
  return {
    messageId: "33333333-3333-4333-8333-333333333333",
    officeId: "roland",
    caseId: CASE_A,
    direction: "outbound",
    channel: "email",
    toAddress: "stedi.test2@example.com",
    fromAddress: null,
    body: "Hi Stedi,",
    subject: "Why it matters",
    templateId: "library.crown.why_it_matters.B",
    status: "draft",
    provider: null,
    providerMessageId: null,
    error: null,
    createdBy: "system:nurture",
    sentBy: null,
    createdAt: "2026-10-14T10:00:00.000Z",
    sentAt: null,
    emailTemplated: true,
    ...over,
  } as TcMessage;
}

describe("the Nurture Outbox on library drafts", () => {
  it("shows procedure + tone and the stage label on a library draft; a hand-written draft keeps its touch key", async () => {
    api.getNurtureOutbox.mockResolvedValue({
      enabled: true,
      channels: [
        { channel: "sms", enabled: true, reason: null },
        { channel: "email", enabled: true, reason: null },
      ],
      groups: [
        {
          trackKey: "warm_followup",
          label: "Warm Follow-Up",
          drafts: [
            { message: msg({}), enrollmentId: ENR_A, caseId: CASE_A, patientName: "Test 2, Stedi", touchKey: "why_it_matters", consentBlockedHint: null },
            {
              message: msg({ messageId: "44444444-4444-4444-8444-444444444444", channel: "sms", templateId: "nurture.warm_followup.wf3", subject: null }),
              enrollmentId: "55555555-5555-4555-8555-555555555555",
              caseId: CASE_A,
              patientName: "Test 2, Stedi",
              touchKey: "wf3",
              consentBlockedHint: null,
            },
          ],
        },
      ],
    } satisfies NurtureOutboxResponse);
    wrap(<NurtureOutbox office="roland" />);
    const rows = await screen.findAllByTestId("outbox-draft");
    expect(rows).toHaveLength(2);
    await waitFor(() => expect(within(rows[0]).getByTestId("draft-library").textContent).toBe("· Library: Dental Crown · Direct"));
    expect(within(rows[0]).getByTestId("draft-stage").textContent).toBe("· Why it matters");
    expect(within(rows[1]).queryByTestId("draft-library")).toBeNull();
    expect(rows[1].textContent).toContain("· wf3");
    expect(api.getEmailLibraryCatalog).toHaveBeenCalledWith("roland");
  });

  it("an outbox with no library draft never asks for the catalog", async () => {
    api.getNurtureOutbox.mockResolvedValue({
      enabled: true,
      channels: [{ channel: "sms", enabled: true, reason: null }],
      groups: [
        {
          trackKey: "no_show_recovery",
          label: "No-Show Recovery",
          drafts: [
            {
              message: msg({ channel: "sms", templateId: "nurture.no_show_recovery.ns1", subject: null }),
              enrollmentId: ENR_A,
              caseId: CASE_A,
              patientName: "Test 2, Stedi",
              touchKey: "ns1",
              consentBlockedHint: null,
            },
          ],
        },
      ],
    } satisfies NurtureOutboxResponse);
    wrap(<NurtureOutbox office="roland" />);
    await screen.findAllByTestId("outbox-draft");
    expect(api.getEmailLibraryCatalog).not.toHaveBeenCalled();
  });
});
