/**
 * Screenshot DUMPS for nurture campaigns v1 (queue item 47).
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-nurture-shots.test.tsx
 *   node scripts/shoot-tc-nurture.mjs
 *
 *   tcnurture-01-outbox        drafts grouped by campaign; texting not connected
 *                              (banner, no Approve on texts); an opted-out email
 *                              offering Skip only; "Approve all" counts the sendable
 *   tcnurture-02-outbox-off    switched off for the office: said in words
 *   tcnurture-03-picker        Start Nurture: four tracks, the office's dial, one
 *                              greyed with its reason
 *   tcnurture-04-chip          a running campaign on the case page
 *   tcnurture-05-stop          Stop asks why
 *
 * NO NETWORK, NO BACKEND, NO PHI. Designated test-patient names only.
 * Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
}));
vi.mock("@/features/tc/nurture/campaignApi", () => api);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NurtureOutbox } from "@/features/tc/nurture/NurtureOutbox";
import { NurtureCampaignBar } from "@/features/tc/nurture/NurtureCampaignBar";
import { TcPageHeader } from "@/features/tc/components/TcShell";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const CASE_A = "11111111-1111-4111-8111-111111111111";
const CASE_B = "66666666-6666-4666-8666-666666666666";
const ENR = "22222222-2222-4222-8222-222222222222";

let n = 0;
function msg(over: Partial<TcMessage>): TcMessage {
  n += 1;
  return {
    messageId: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
    officeId: "roland",
    caseId: CASE_A,
    direction: "outbound",
    channel: "sms",
    toAddress: "+19185550142",
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
    emailTemplated: false,
    ...over,
  };
}

const page = (ui: React.ReactElement, path = "/tc/texts") => {
  const { hook } = memoryLocation({ path });
  return render(
    <WouterRouter hook={hook}>
      <div className="mx-auto max-w-4xl p-6">{ui}</div>
    </WouterRouter>,
  );
};

const OUTBOX: NurtureOutboxResponse = {
  enabled: true,
  channels: [
    { channel: "sms", enabled: false, reason: "office_not_configured" },
    { channel: "email", enabled: true, reason: null },
  ],
  groups: [
    {
      trackKey: "no_show_recovery",
      label: "No-Show Recovery",
      drafts: [
        {
          message: msg({
            body: "Hi Stedi, we missed you at Roland Family Dental! Life happens — reply here or call (918) 555-0100 and we'll find a time that works better. Reply STOP to opt out.",
          }),
          enrollmentId: ENR,
          caseId: CASE_A,
          patientName: "Test 2, Stedi",
          touchKey: "ns1",
          consentBlockedHint: null,
        },
      ],
    },
    {
      trackKey: "warm_followup",
      label: "Warm Follow-Up",
      drafts: [
        {
          message: msg({
            caseId: CASE_B,
            channel: "email",
            toAddress: "mangotest@example.com",
            subject: "Your plan, in plain English",
            body: "Hi MangoTest, it was great seeing you. We know a treatment plan can feel like a lot to take in at the chair, so if anything we discussed deserves a second explanation — what it involves, why we recommended it, what happens if we wait — just reply or call (918) 555-0100. No pressure, just answers. — Roland Family Dental",
            emailTemplated: true,
          }),
          enrollmentId: ENR,
          caseId: CASE_B,
          patientName: "Test, MangoTest",
          touchKey: "wf2",
          consentBlockedHint: null,
        },
        {
          message: msg({
            channel: "email",
            toAddress: "stedi.test2@example.com",
            subject: "Let's make it fit your budget",
            body: "Hi Stedi, if cost is part of what's giving you pause, you're not alone — and we have options. Flexible payment plans, financing, and ways to phase treatment so it works for your budget. Five minutes with our team and you'll know exactly what's possible. — Roland Family Dental",
            emailTemplated: true,
          }),
          enrollmentId: ENR,
          caseId: CASE_A,
          patientName: "Test 2, Stedi",
          touchKey: "wf5",
          consentBlockedHint: "opted_out",
        },
      ],
    },
  ],
};

const TRACKS: NurtureCaseResponse["tracks"] = [
  { trackKey: "no_show_recovery", label: "No-Show Recovery", goal: "Reschedule. Warm, zero guilt.", intensity: "standard", touchCount: 3, channels: ["sms", "email"], available: true, reason: null },
  { trackKey: "warm_followup", label: "Warm Follow-Up", goal: "Schedule presented treatment while it's fresh.", intensity: "assertive", touchCount: 10, channels: ["sms", "email"], available: true, reason: null },
  { trackKey: "reactivation", label: "Reactivation Drip", goal: "Re-engage aging plans. Slow, benefit-led.", intensity: "gentle", touchCount: 4, channels: ["email"], available: false, reason: "no_address" },
  { trackKey: "large_case", label: "Large Case / Financing", goal: "Convert big presented cases. Fewer, higher-touch, value-first.", intensity: "standard", touchCount: 5, channels: ["email", "sms"], available: true, reason: null },
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
  nextTouchDueAt: "2026-10-21T05:00:00.000Z",
  lastTouchAt: "2026-10-17T10:00:00.000Z",
  nextTouchKey: "wf3",
  touchCount: 2,
  createdBy: "tc@carein.ai",
  createdAt: "2026-10-13T15:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
};

describe.skipIf(!process.env.TC_SHOTS)("nurture shots", () => {
  afterEach(() => cleanup());

  it("01 outbox", async () => {
    api.getNurtureOutbox.mockResolvedValue(OUTBOX);
    page(
      <>
        <TcPageHeader title="Texts" subtitle="Texts patients sent to this office, and nurture drafts waiting for approval." />
        <NurtureOutbox office="roland" />
      </>,
    );
    await screen.findAllByTestId("outbox-draft");
    dump("tcnurture-01-outbox@1280x1100");
    expect(screen.getAllByTestId("outbox-draft")).toHaveLength(3);
  });

  it("02 outbox off", async () => {
    api.getNurtureOutbox.mockResolvedValue({
      enabled: false,
      channels: [
        { channel: "sms", enabled: false, reason: "switched_off" },
        { channel: "email", enabled: false, reason: "switched_off" },
      ],
      groups: [],
    } satisfies NurtureOutboxResponse);
    page(<NurtureOutbox office="roland" />);
    await screen.findByTestId("nurture-off");
    dump("tcnurture-02-outbox-off");
  });

  it("03 picker", async () => {
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [], tracks: TRACKS } satisfies NurtureCaseResponse);
    page(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />, "/tc/cases/x");
    fireEvent.click(await screen.findByTestId("start-nurture"));
    await screen.findByTestId("track-reactivation");
    dump("tcnurture-03-picker");
  });

  it("04 chip", async () => {
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [RUNNING],
      tracks: TRACKS.map((t) => ({ ...t, available: false, reason: "already_enrolled" as const })),
    } satisfies NurtureCaseResponse);
    page(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />, "/tc/cases/x");
    await screen.findByTestId("nurture-chip");
    dump("tcnurture-04-chip");
  });

  it("05 stop", async () => {
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [{ ...RUNNING, status: "paused" }],
      tracks: TRACKS,
    } satisfies NurtureCaseResponse);
    page(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />, "/tc/cases/x");
    await screen.findByTestId("nurture-chip");
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await screen.findByText("Stop this campaign?");
    dump("tcnurture-05-stop");
  });
});
