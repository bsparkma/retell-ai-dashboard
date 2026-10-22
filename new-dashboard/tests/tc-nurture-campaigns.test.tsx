/**
 * Nurture campaigns v1 (queue item 47) — the outbox and the case-page bar,
 * with the API faked.
 *
 *   - Feature off: said in words, no "all caught up", no zeros.
 *   - A channel not connected: a banner, and NO Approve on its drafts.
 *   - A draft flagged at draft time: the reason, Skip only.
 *   - Approve sends exactly that one draft through the ordinary Send.
 *   - The picker greys a track with its reason and starts the one clicked.
 *
 * Fixture names are the designated test patients only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { TcMessage } from "@shared/tc/messaging";
import type { NurtureCaseResponse, NurtureOutboxResponse } from "@shared/tc/nurture";

(globalThis as Record<string, unknown>).React = React;

const api = vi.hoisted(() => ({
  getNurtureOutbox: vi.fn(),
  skipNurtureDraft: vi.fn(),
  getCaseNurture: vi.fn(),
  startNurture: vi.fn(),
  pauseNurture: vi.fn(),
  resumeNurture: vi.fn(),
  stopNurture: vi.fn(),
  sendMessage: vi.fn(),
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
vi.mock("@/features/tc/messaging/messagingApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/features/tc/messaging/messagingApi")>();
  return { ...real, sendMessage: api.sendMessage };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NurtureOutbox } from "@/features/tc/nurture/NurtureOutbox";
import { NurtureCampaignBar } from "@/features/tc/nurture/NurtureCampaignBar";

const CASE_A = "11111111-1111-4111-8111-111111111111";
const ENR_A = "22222222-2222-4222-8222-222222222222";

function msg(over: Partial<TcMessage>): TcMessage {
  return {
    messageId: "33333333-3333-4333-8333-333333333333",
    officeId: "roland",
    caseId: CASE_A,
    direction: "outbound",
    channel: "sms",
    toAddress: "+19185550142",
    fromAddress: null,
    body: "Hi Stedi, we missed you at Roland Family Dental! Reply STOP to opt out.",
    subject: null,
    templateId: "nurture.no_show_recovery.ns1",
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

function wrap(ui: React.ReactElement) {
  const { hook } = memoryLocation({ path: "/tc/texts" });
  return render(<WouterRouter hook={hook}>{ui}</WouterRouter>);
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(() => cleanup());

describe("Nurture Outbox", () => {
  it("switched off with nothing waiting: says so, and does not pretend to be caught up", async () => {
    api.getNurtureOutbox.mockResolvedValue({
      enabled: false,
      channels: [
        { channel: "sms", enabled: false, reason: "switched_off" },
        { channel: "email", enabled: false, reason: "not_configured" },
      ],
      groups: [],
    } satisfies NurtureOutboxResponse);
    wrap(<NurtureOutbox office="roland" />);
    expect((await screen.findByTestId("nurture-off")).textContent).toMatch(/switched off for this office/);
    expect(screen.queryByTestId("nurture-outbox-empty")).toBeNull();
    expect(screen.queryByText(/\b0\b/)).toBeNull();
  });

  it("a disconnected channel gets a banner and no Approve; a flagged draft offers Skip only; Approve sends exactly that draft", async () => {
    const sms = msg({});
    const flagged = msg({ messageId: "44444444-4444-4444-8444-444444444444", channel: "email", subject: "Let's find you a new time", toAddress: "stedi.test2@example.com" });
    const email = msg({ messageId: "55555555-5555-4555-8555-555555555555", channel: "email", subject: "The door's still open", toAddress: "stedi.test2@example.com" });
    api.getNurtureOutbox.mockResolvedValue({
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
            { message: sms, enrollmentId: ENR_A, caseId: CASE_A, patientName: "Test 2, Stedi", touchKey: "ns1", consentBlockedHint: null },
            { message: flagged, enrollmentId: ENR_A, caseId: CASE_A, patientName: "Test 2, Stedi", touchKey: "ns2", consentBlockedHint: "opted_out" },
            { message: email, enrollmentId: ENR_A, caseId: CASE_A, patientName: "Test 2, Stedi", touchKey: "ns4", consentBlockedHint: null },
          ],
        },
      ],
    } satisfies NurtureOutboxResponse);
    api.sendMessage.mockResolvedValue({ ...email, status: "sent" });
    wrap(<NurtureOutbox office="roland" />);

    expect(await screen.findByTestId("channel-off-sms")).toBeTruthy();
    const rows = screen.getAllByTestId("outbox-draft");
    expect(rows).toHaveLength(3);
    // SMS (channel off): no Approve, the reason shown.
    expect(within(rows[0]).queryByTestId("approve")).toBeNull();
    expect(within(rows[0]).getByTestId("approve-blocked")).toBeTruthy();
    // Flagged: the hint, no Approve, Skip present.
    expect(within(rows[1]).getByTestId("consent-hint").textContent).toMatch(/Opted out/);
    expect(within(rows[1]).queryByTestId("approve")).toBeNull();
    expect(within(rows[1]).getByTestId("skip")).toBeTruthy();
    // "Approve all" counts only what can actually be sent.
    expect(screen.getByRole("button", { name: /Approve the 1 sendable/ })).toBeTruthy();

    fireEvent.click(within(rows[2]).getByTestId("approve"));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage).toHaveBeenCalledWith("roland", email.messageId);
  });

  it("Skip calls skip for that draft and never sends", async () => {
    const sms = msg({});
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
          drafts: [{ message: sms, enrollmentId: ENR_A, caseId: CASE_A, patientName: "Test 2, Stedi", touchKey: "wf1", consentBlockedHint: null }],
        },
      ],
    } satisfies NurtureOutboxResponse);
    api.skipNurtureDraft.mockResolvedValue({ ...sms, status: "skipped" });
    wrap(<NurtureOutbox office="roland" />);
    fireEvent.click(await screen.findByTestId("skip"));
    await waitFor(() => expect(api.skipNurtureDraft).toHaveBeenCalledWith("roland", sms.messageId));
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("Start Nurture picker", () => {
  const tracks: NurtureCaseResponse["tracks"] = [
    { trackKey: "no_show_recovery", label: "No-Show Recovery", goal: "Reschedule.", intensity: "standard", touchCount: 3, channels: ["sms", "email"], available: true, reason: null },
    { trackKey: "warm_followup", label: "Warm Follow-Up", goal: "Schedule.", intensity: "gentle", touchCount: 4, channels: ["email", "sms"], available: true, reason: null },
    { trackKey: "reactivation", label: "Reactivation Drip", goal: "Re-engage.", intensity: "gentle", touchCount: 4, channels: ["email"], available: false, reason: "no_address" },
    { trackKey: "large_case", label: "Large Case / Financing", goal: "Convert.", intensity: "assertive", touchCount: 7, channels: ["email", "sms"], available: true, reason: null },
  ];

  it("greys an unavailable track with its reason, shows the office's dial, and starts the one picked", async () => {
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [], tracks } satisfies NurtureCaseResponse);
    api.startNurture.mockResolvedValue({});
    const onCaseChanged = vi.fn();
    wrap(<NurtureCampaignBar office="valley" caseId={CASE_A} onCaseChanged={onCaseChanged} />);
    fireEvent.click(await screen.findByTestId("start-nurture"));
    const greyed = await screen.findByTestId("track-reactivation");
    expect((greyed as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("track-reason-reactivation").textContent).toMatch(/no phone or email/);
    expect(screen.getByTestId("track-large_case").textContent).toMatch(/Assertive · 7 touches/);
    fireEvent.click(screen.getByTestId("track-warm_followup"));
    await waitFor(() => expect(api.startNurture).toHaveBeenCalledWith("valley", CASE_A, "warm_followup"));
    await waitFor(() => expect(onCaseChanged).toHaveBeenCalled());
  });

  it("a running campaign shows the chip with Pause and Stop, never Start", async () => {
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      tracks: tracks.map((t) => ({ ...t, available: false, reason: "already_enrolled" as const })),
      enrollments: [
        {
          enrollmentId: ENR_A,
          caseId: CASE_A,
          officeId: "roland",
          trackKey: "no_show_recovery",
          intensityAtEnroll: "standard",
          status: "active",
          stopReason: null,
          nextTouchIndex: 1,
          nextTouchDueAt: "2026-10-17T05:00:00.000Z",
          lastTouchAt: "2026-10-14T10:00:00.000Z",
          nextTouchKey: "ns2",
          touchCount: 1,
          createdBy: "tc@carein.ai",
          createdAt: "2026-10-13T15:00:00.000Z",
          updatedAt: "2026-10-14T10:00:00.000Z",
        },
      ],
    } satisfies NurtureCaseResponse);
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    expect((await screen.findByTestId("nurture-chip")).textContent).toContain("No-Show Recovery");
    expect(screen.getByText(/1 of 3 drafted/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pause/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    expect(screen.queryByTestId("start-nurture")).toBeNull();
  });
});
