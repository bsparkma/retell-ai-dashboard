/**
 * TC text messaging on screen (queue item 39):
 *
 *   - The SMS channel is live only when the SERVER says so for this office
 *     (readiness.adapterEnabled), and when it is not, the server's reason is
 *     said in words (switched off / no number for this office).
 *   - Delivery is honest: "Sent" is not "Delivered", and only a carrier receipt
 *     is green. A failed text Twilio had accepted reads "Not delivered".
 *   - Opening a thread with inbound texts marks them seen; a thread with none
 *     does not call the server.
 *   - /tc/texts lists unseen replies on cases (with a link to the case) and the
 *     unmatched inbox, and "Mark as seen" clears the inbox.
 *   - The TC nav's "Texts" item carries the server's unseen count, rides the
 *     existing probe tick, and shows nothing when the count is unknown.
 *
 * NO NETWORK, NO PHI — synthetic names, roland fixture PatNum, 555-01xx numbers.
 */
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase } from "../shared/tc/contract";
import type { ChannelReadiness, TcMessage } from "../shared/tc/messaging";

const api = vi.hoisted(() => ({
  messages: [] as unknown[],
  readiness: [] as unknown[],
  unseenOnCases: [] as unknown[],
  inbox: [] as unknown[],
  listCaseMessages: vi.fn(),
  getChannelReadiness: vi.fn(),
  createDraft: vi.fn(),
  editDraft: vi.fn(),
  sendMessage: vi.fn(),
  discardDraft: vi.fn(),
  recordOptOut: vi.fn(),
  markSeen: vi.fn(),
  listUnseenOnCases: vi.fn(),
  listInbox: vi.fn(),
  getUnseenCount: vi.fn(),
  getUnseenTotal: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/features/tc/messaging/messagingApi", () => ({
  listCaseMessages: api.listCaseMessages,
  getChannelReadiness: api.getChannelReadiness,
  createDraft: api.createDraft,
  editDraft: api.editDraft,
  sendMessage: api.sendMessage,
  discardDraft: api.discardDraft,
  recordOptOut: api.recordOptOut,
  markSeen: api.markSeen,
  listUnseenOnCases: api.listUnseenOnCases,
  listInbox: api.listInbox,
  getUnseenCount: api.getUnseenCount,
  getUnseenTotal: api.getUnseenTotal,
}));

vi.mock("@/features/tc/components/TcShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/components/TcShell")>();
  return { ...actual, useTcOffice: () => "roland" };
});

import { MessagesTab } from "../client/src/features/tc/caseview/MessagesTab";
import TcTexts from "../client/src/pages/tc/TcTexts";
import { TooltipProvider } from "../client/src/components/ui/tooltip";
import { ADAPTER_REASON_COPY, statusLabel } from "../client/src/features/tc/messaging/copy";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function makeCase(): TcCase {
  return {
    caseId: CASE_ID,
    legacyId: null,
    officeId: "roland",
    patientName: "Test, MangoTest",
    patientAge: 40,
    phone: "479-555-0101",
    email: null,
    odPatientId: 12828,
    caseType: "Crown",
    category: "single_tooth",
    status: "presented",
    urgency: "medium",
    doctorName: "DOC1",
    diagnosingProvider: "DOC1",
    assignedTc: "",
    caseValueCents: 120000,
    readinessScore: 0,
    financingStatus: "",
    preferredFinancingProvider: null,
    decisionMakers: "",
    financialSituation: [],
    keyMotivators: [],
    contactPreference: null,
    bestTimeToReach: "",
    notes: "",
    referralSource: null,
    lostReason: null,
    diagnosedDate: null,
    statusChangedAt: "2026-10-01T14:00:00.000Z",
    nurtureCadence: "standard",
    inLongTailMode: false,
    nurtureEnrolledAt: null,
    nurturePhaseChangedAt: null,
    nurturePhase1DaysOverride: null,
    nurturePhase2DaysOverride: null,
    nurtureUnsubscribed: false,
    phases: [],
    objections: [],
    followups: [],
    events: [],
    hygieneIntake: null,
  };
}

function msg(over: Partial<TcMessage>): TcMessage {
  return {
    messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96401",
    officeId: "roland",
    caseId: CASE_ID,
    direction: "outbound",
    channel: "sms",
    toAddress: "+14795550101",
    fromAddress: null,
    body: "Hi MangoTest, this is Roland following up on your recent visit.",
    subject: null,
    templateId: null,
    status: "draft",
    provider: null,
    providerMessageId: null,
    error: null,
    createdBy: "tc@carein.ai",
    sentBy: null,
    createdAt: "2026-10-08T15:00:00.000Z",
    sentAt: null,
    ...over,
  };
}

function ready(over: Partial<ChannelReadiness> = {}): ChannelReadiness[] {
  return [
    {
      channel: "sms",
      address: "+14795550101",
      adapterEnabled: true,
      adapterReason: null,
      consentState: "unknown",
      odTextConsent: "yes",
      quietHours: false,
      blockCode: null,
      ...over,
    },
    {
      channel: "email",
      address: null,
      adapterEnabled: false,
      adapterReason: "not_configured",
      consentState: "unknown",
      odTextConsent: "not_checked",
      quietHours: false,
      blockCode: null,
    },
  ];
}

beforeEach(() => {
  api.messages = [];
  api.readiness = ready();
  api.unseenOnCases = [];
  api.inbox = [];
  api.listCaseMessages.mockReset().mockImplementation(async () => api.messages);
  api.getChannelReadiness.mockReset().mockImplementation(async () => api.readiness);
  api.markSeen.mockReset().mockImplementation(async () => 1);
  api.listUnseenOnCases.mockReset().mockImplementation(async () => api.unseenOnCases);
  api.listInbox.mockReset().mockImplementation(async () => api.inbox);
  api.sendMessage.mockReset();
});
afterEach(cleanup);

function renderTab() {
  return render(
    <TooltipProvider>
      <MessagesTab office="roland" tcCase={makeCase()} />
    </TooltipProvider>,
  );
}

describe("SMS channel readiness comes from the server, per office", () => {
  it("connected for this office → Send enabled, picker says Connected", async () => {
    api.messages = [msg({})];
    renderTab();
    const send = await screen.findByTestId("send-button");
    expect((send as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });

  it("this office has no number → the honest reason, Send disabled", async () => {
    api.messages = [msg({})];
    api.readiness = ready({ adapterEnabled: false, adapterReason: "office_not_configured" });
    renderTab();
    const send = await screen.findByTestId("send-button");
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(ADAPTER_REASON_COPY.office_not_configured).length).toBeGreaterThan(0);
    expect(screen.getByText("No number for this office")).toBeTruthy();
    fireEvent.click(send);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("kill switch off → 'switched off', not 'not connected'", async () => {
    api.messages = [msg({})];
    api.readiness = ready({ adapterEnabled: false, adapterReason: "switched_off" });
    renderTab();
    await screen.findByTestId("send-button");
    expect(screen.getAllByText(ADAPTER_REASON_COPY.switched_off).length).toBeGreaterThan(0);
    expect(screen.getByText("Switched off")).toBeTruthy();
  });
});

describe("delivery states are honest", () => {
  it("sent is NOT delivered; delivered is its own chip; a carrier failure reads 'Not delivered'", async () => {
    api.messages = [
      msg({ messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96410", status: "queued", provider: "twilio", providerMessageId: "SM1", sentAt: "2026-10-08T15:01:00.000Z" }),
      msg({ messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96411", status: "sent", provider: "twilio", providerMessageId: "SM2", sentAt: "2026-10-08T15:02:00.000Z" }),
      msg({ messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96412", status: "delivered", provider: "twilio", providerMessageId: "SM3", sentAt: "2026-10-08T15:03:00.000Z" }),
      msg({
        messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96413",
        status: "failed",
        provider: "twilio",
        providerMessageId: "SM4",
        error: "Not delivered (Twilio error 30006: the number is a landline or cannot receive texts).",
        sentAt: "2026-10-08T15:04:00.000Z",
      }),
    ];
    renderTab();
    await screen.findByText(/landline/);
    const chips = screen.getAllByTestId("message-status").map((n) => n.textContent);
    expect(chips).toEqual([
      "Queued — not delivered yet",
      "Sent — delivery not confirmed",
      "Delivered",
      "Not delivered",
    ]);
  });

  it("a failure before Twilio took it (no provider id) still reads 'Not sent'", () => {
    expect(statusLabel({ status: "failed", providerMessageId: null })).toBe("Not sent");
    expect(statusLabel({ status: "failed", providerMessageId: "SM9" })).toBe("Not delivered");
  });
});

describe("seen marker", () => {
  it("a thread with inbound texts marks the case seen", async () => {
    api.messages = [
      msg({ messageId: "9c9619ff-8b86-4d01-b42d-00cf4fc96402", direction: "inbound", status: "received", body: "Tuesday works", toAddress: null, fromAddress: "+14795550101" }),
    ];
    renderTab();
    await screen.findByText("Tuesday works");
    await waitFor(() => expect(api.markSeen).toHaveBeenCalledWith("roland", CASE_ID));
  });

  it("a thread with no inbound texts does not call the server", async () => {
    api.messages = [msg({})];
    renderTab();
    await screen.findByTestId("send-button");
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  it("a failing seen marker never takes the thread down", async () => {
    api.markSeen.mockImplementation(async () => {
      throw new Error("boom");
    });
    api.messages = [
      msg({ messageId: "9c9619ff-8b86-4d01-b42d-00cf4fc96402", direction: "inbound", status: "received", body: "Tuesday works", toAddress: null, fromAddress: "+14795550101" }),
    ];
    renderTab();
    expect(await screen.findByText("Tuesday works")).toBeTruthy();
    expect(screen.queryByTestId("messages-error")).toBeNull();
  });
});

function renderTexts() {
  const { hook } = memoryLocation({ path: "/tc/texts", static: true });
  return render(
    <WouterRouter hook={hook}>
      <TooltipProvider>
        <TcTexts />
      </TooltipProvider>
    </WouterRouter>,
  );
}

describe("/tc/texts", () => {
  it("lists unseen replies on cases (with the case link) and the unmatched inbox", async () => {
    api.unseenOnCases = [
      msg({ messageId: "9c9619ff-8b86-4d01-b42d-00cf4fc96420", direction: "inbound", status: "received", body: "Is Tuesday open?", toAddress: "+14795550150", fromAddress: "+14795550101" }),
    ];
    api.inbox = [
      msg({ messageId: "9c9619ff-8b86-4d01-b42d-00cf4fc96421", caseId: null, direction: "inbound", status: "received", body: "Who is this?", toAddress: "+14795550150", fromAddress: "+14795550109" }),
    ];
    renderTexts();
    expect(await screen.findByText("Is Tuesday open?")).toBeTruthy();
    expect(screen.getByText("Who is this?")).toBeTruthy();
    const link = screen.getByText("Open case").closest("a");
    expect(link?.getAttribute("href")).toBe(`/tc/cases/${CASE_ID}?tab=messages`);
    fireEvent.click(screen.getByText("Mark as seen"));
    await waitFor(() => expect(api.markSeen).toHaveBeenCalledWith("roland", null));
  });

  it("empty states say so", async () => {
    renderTexts();
    expect(await screen.findByTestId("texts-on-cases-empty")).toBeTruthy();
    expect(screen.getByTestId("texts-unlinked-empty")).toBeTruthy();
    expect(screen.queryByText("Mark as seen")).toBeNull();
  });
});
