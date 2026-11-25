/**
 * Screenshot DUMPS for EL-2 (the patient email library inside nurture).
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-nurture-library-shots.test.tsx
 *   node scripts/shoot-tc-nurture.mjs
 *
 *   tcnurture-06-library-picker    Start Nurture with "Use the patient email
 *                                  library for…" on: procedure (by category),
 *                                  tone, one track blocked with the server's reason
 *   tcnurture-07-library-blocked   no track can start from the library: the
 *                                  section is off and says why
 *   tcnurture-08-library-chip      a running library campaign: procedure + tone,
 *                                  N of the library sequence's M
 *   tcnurture-09-library-outbox    library drafts in the outbox: procedure + tone
 *                                  and the stage label; one hand-written draft beside them
 *
 * The draft bodies are the library's own composed text for the roland test
 * patient (renderLibraryEmail, default answers). NO NETWORK, NO BACKEND, NO PHI:
 * designated test-patient names only, 555-01xx numbers, a synthetic staff name.
 * Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
vi.mock("@/features/tc/emailLibrary/emailLibraryApi", () => ({ getEmailLibraryCatalog: api.getEmailLibraryCatalog }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NurtureOutbox } from "@/features/tc/nurture/NurtureOutbox";
import { NurtureCampaignBar } from "@/features/tc/nurture/NurtureCampaignBar";
import { TcPageHeader } from "@/features/tc/components/TcShell";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  // innerHTML carries attributes, not live state: write the checkbox and the
  // chosen procedure into attributes so the photo shows what is on screen.
  document.querySelectorAll("input[type=checkbox]").forEach((el) => {
    if ((el as HTMLInputElement).checked) el.setAttribute("checked", "");
  });
  document.querySelectorAll("select").forEach((sel) => {
    Array.from((sel as HTMLSelectElement).options).forEach((o) => {
      if (o.selected) o.setAttribute("selected", "");
      else o.removeAttribute("selected");
    });
  });
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const CASE_A = "11111111-1111-4111-8111-111111111111";
const ENR = "22222222-2222-4222-8222-222222222222";

const proc = (id: string, name: string, category: string) => ({ id, name, category, audience: "adult" });
const PROCEDURES = [
  proc("filling", "Tooth-Colored Filling", "Restorative"),
  proc("crown", "Dental Crown", "Restorative"),
  proc("root_canal", "Root Canal", "Endodontics"),
  proc("implant", "Dental Implant", "Implants"),
  proc("full_arch", "Full-Arch Implants", "Implants"),
  proc("deep_cleaning", "Deep Cleaning", "Periodontics"),
];
const CATALOG = {
  success: true,
  office: "roland",
  libraryVersion: "1.3.0",
  clinicallyApproved: true,
  status: "",
  rulesOfUse: [],
  procedures: PROCEDURES,
  allProcedures: PROCEDURES,
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
  { trackKey: "no_show_recovery", label: "No-Show Recovery", goal: "Reschedule. Warm, zero guilt.", intensity: "standard", touchCount: 3, channels: ["sms", "email"], available: true, reason: null, libraryAvailable: true, libraryBlockedReason: null },
  { trackKey: "warm_followup", label: "Warm Follow-Up", goal: "Schedule presented treatment while it's fresh.", intensity: "assertive", touchCount: 10, channels: ["sms", "email"], available: true, reason: null, libraryAvailable: true, libraryBlockedReason: null },
  { trackKey: "reactivation", label: "Reactivation Drip", goal: "Re-engage aging plans. Slow, benefit-led.", intensity: "gentle", touchCount: 4, channels: ["sms", "email"], available: true, reason: null, libraryAvailable: false, libraryBlockedReason: "This case has no email address. Library campaigns are email only." },
  { trackKey: "large_case", label: "Large Case / Financing", goal: "Convert big presented cases. Fewer, higher-touch, value-first.", intensity: "standard", touchCount: 5, channels: ["email", "sms"], available: true, reason: null, libraryAvailable: true, libraryBlockedReason: null },
];

const RUNNING: TcNurtureEnrollment = {
  enrollmentId: ENR,
  caseId: CASE_A,
  officeId: "roland",
  trackKey: "warm_followup",
  intensityAtEnroll: "standard",
  status: "active",
  stopReason: null,
  nextTouchIndex: 2,
  nextTouchDueAt: "2026-10-20T05:00:00.000Z",
  lastTouchAt: "2026-10-16T10:00:00.000Z",
  nextTouchKey: "check_in",
  touchCount: 2,
  createdBy: "tc@carein.ai",
  createdAt: "2026-10-13T15:00:00.000Z",
  updatedAt: "2026-10-16T10:00:00.000Z",
  libraryProcedureId: "crown",
  libraryVariant: "A",
  stepCount: 10,
};

let n = 0;
function msg(over: Partial<TcMessage>): TcMessage {
  n += 1;
  return {
    messageId: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
    officeId: "roland",
    caseId: CASE_A,
    direction: "outbound",
    channel: "email",
    toAddress: "stedi.test2@example.com",
    fromAddress: null,
    body: "",
    subject: null,
    templateId: null,
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
  };
}

const CROWN_RECAP =
  "Hi Stedi,\n\nThank you for coming in. We covered a lot at the visit, so here is the short version of what we discussed about your crown.\n\nA crown is a custom-made cover that fits over a tooth that is cracked, heavily filled, or worn down, and restores its full shape and strength. It holds the tooth together so you can chew with confidence, and it is shaded to blend in with the teeth around it.\n\nThe next step is simply picking a time that works for you. Reply to this email or call us at (918) 555-0100.\n\nTest Coordinator\nRoland Family Dental\n(918) 555-0100";
const IMPLANT_WHY =
  "Hi Stedi,\n\nThe short version on your dental implant:\n\n- What it is: A dental implant is a small titanium post that takes the place of a missing tooth root. Once it heals, a custom crown is attached on top.\n- Why it matters: It looks, feels, and works like a natural tooth.\n\nTo schedule, reply here or call (918) 555-0100.\n\nTest Coordinator\nRoland Family Dental\n(918) 555-0100";

const OUTBOX: NurtureOutboxResponse = {
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
        {
          message: msg({ subject: "Good seeing you, Stedi", body: CROWN_RECAP, templateId: "library.crown.tp_recap.A" }),
          enrollmentId: ENR,
          caseId: CASE_A,
          patientName: "Test 2, Stedi",
          touchKey: "tp_recap",
          consentBlockedHint: null,
        },
      ],
    },
    {
      trackKey: "large_case",
      label: "Large Case / Financing",
      drafts: [
        {
          message: msg({ subject: "The short version", body: IMPLANT_WHY, templateId: "library.implant.why_it_matters.B" }),
          enrollmentId: "44444444-4444-4444-8444-444444444444",
          caseId: CASE_A,
          patientName: "Test 2, Stedi",
          touchKey: "why_it_matters",
          consentBlockedHint: null,
        },
        {
          message: msg({
            channel: "sms",
            toAddress: "+19185550142",
            emailTemplated: false,
            templateId: "nurture.large_case.lc6",
            body: "Hi Stedi, Roland Family Dental here - happy to answer any questions about your treatment plan or go over payment options. Just reply. Reply STOP to opt out.",
          }),
          enrollmentId: "55555555-5555-4555-8555-555555555555",
          caseId: CASE_A,
          patientName: "Test 2, Stedi",
          touchKey: "lc6",
          consentBlockedHint: null,
        },
      ],
    },
  ],
};

const page = (ui: React.ReactElement, path = "/tc/texts") => {
  const { hook } = memoryLocation({ path });
  return render(
    <WouterRouter hook={hook}>
      <div className="mx-auto max-w-4xl p-6">{ui}</div>
    </WouterRouter>,
  );
};

describe.skipIf(!process.env.TC_SHOTS)("nurture library shots", () => {
  afterEach(() => cleanup());

  it("06 library picker", async () => {
    api.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [], tracks: TRACKS } satisfies NurtureCaseResponse);
    page(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />, "/tc/cases/x");
    fireEvent.click(await screen.findByTestId("start-nurture"));
    fireEvent.click(await screen.findByTestId("nurture-library-toggle"));
    const select = (await screen.findByTestId("nurture-library-procedure")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "crown" } });
    await screen.findByTestId("track-library-reason-reactivation").catch(() => null);
    dump("tcnurture-06-library-picker@1280x1100");
  });

  it("07 library blocked", async () => {
    api.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
    const reason = "Set the office's office phone in Practice info & email identity first.";
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [],
      tracks: TRACKS.map((t) => ({ ...t, libraryAvailable: false, libraryBlockedReason: reason })),
    } satisfies NurtureCaseResponse);
    page(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />, "/tc/cases/x");
    fireEvent.click(await screen.findByTestId("start-nurture"));
    await screen.findByTestId("nurture-library-unavailable");
    dump("tcnurture-07-library-blocked");
  });

  it("08 library chip", async () => {
    api.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [RUNNING],
      tracks: TRACKS.map((t) => ({ ...t, available: false, reason: "already_enrolled" as const })),
    } satisfies NurtureCaseResponse);
    page(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />, "/tc/cases/x");
    await waitFor(() => expect(screen.getByTestId("nurture-chip-pace").textContent).toContain("Dental Crown"));
    dump("tcnurture-08-library-chip");
  });

  it("09 library outbox", async () => {
    api.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
    api.getNurtureOutbox.mockResolvedValue(OUTBOX);
    page(
      <>
        <TcPageHeader title="Texts" subtitle="Texts patients sent to this office, and nurture drafts waiting for approval." />
        <NurtureOutbox office="roland" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId("draft-stage")[0].textContent).toContain("Treatment recap"));
    dump("tcnurture-09-library-outbox@1280x1100");
  });
});

// vitest's expect, used inside waitFor above.
import { expect } from "vitest";
