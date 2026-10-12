/**
 * TC Messages tab (queue item 38): review-then-send on screen.
 *
 *   - Send on a draft is disabled, WITH the reason, while no provider is
 *     connected (true for both channels in this slice).
 *   - The consent badge says what the gate knows ("No OD text consent on file").
 *   - A consent block's sentence is shown on the draft; quiet hours too.
 *   - A failed message shows the provider's error.
 *   - Save draft never sends an address (the server assembles it).
 *   - The follow-up queue's "Draft message" deep link opens the Messages tab and
 *     seeds exactly ONE draft from that follow-up.
 *
 * NO NETWORK, NO PHI — synthetic names, the roland test fixture PatNum, and
 * 555-01xx numbers.
 */
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase } from "../shared/tc/contract";
import type { ChannelReadiness, TcMessage } from "../shared/tc/messaging";

const api = vi.hoisted(() => ({
  messages: [] as unknown[],
  readiness: [] as unknown[],
  listCaseMessages: vi.fn(),
  getChannelReadiness: vi.fn(),
  createDraft: vi.fn(),
  editDraft: vi.fn(),
  sendMessage: vi.fn(),
  discardDraft: vi.fn(),
  recordOptOut: vi.fn(),
  tcCase: null as unknown,
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
}));

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, getCase: vi.fn(async () => api.tcCase) };
});

vi.mock("@/features/tc/components/TcShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/components/TcShell")>();
  return { ...actual, useTcOffice: () => "roland" };
});

import { MessagesTab } from "../client/src/features/tc/caseview/MessagesTab";
import TcCaseView from "../client/src/pages/tc/TcCaseView";
import { FollowupActionCard } from "../client/src/features/tc/followups/FollowupActionCard";
import { ThemeProvider } from "../client/src/contexts/ThemeContext";
import { TooltipProvider } from "../client/src/components/ui/tooltip";
import { BLOCK_COPY } from "../client/src/features/tc/messaging/copy";

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
const FOLLOWUP_ID = "7a9619ff-8b86-4d01-b42d-00cf4fc96400";

function makeCase(): TcCase {
  return {
    caseId: CASE_ID,
    legacyId: null,
    officeId: "roland",
    patientName: "Test, MangoTest",
    patientAge: 40,
    phone: "479-555-0101",
    email: "patient@example.test",
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
    body: "Hi MangoTest, this is Roland Family Dental following up.",
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
      adapterEnabled: false,
      consentState: "unknown",
      odTextConsent: "unknown",
      quietHours: false,
      blockCode: null,
      ...over,
    },
    {
      channel: "email",
      address: "patient@example.test",
      adapterEnabled: false,
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
  api.listCaseMessages.mockReset().mockImplementation(async () => api.messages);
  api.getChannelReadiness.mockReset().mockImplementation(async () => api.readiness);
  api.createDraft.mockReset().mockImplementation(async () => msg({}));
  api.sendMessage.mockReset();
  api.discardDraft.mockReset();
  api.editDraft.mockReset();
  api.recordOptOut.mockReset();
  api.tcCase = makeCase();
});
afterEach(cleanup);

function renderTab(props: Partial<React.ComponentProps<typeof MessagesTab>> = {}) {
  return render(
    <TooltipProvider>
      <MessagesTab office="roland" tcCase={makeCase()} {...props} />
    </TooltipProvider>,
  );
}

describe("Messages tab", () => {
  it("a draft's Send is disabled with the honest reason while no provider is connected", async () => {
    api.messages = [msg({})];
    renderTab();
    const send = await screen.findByTestId("send-button");
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Sending isn't connected yet/).length).toBeGreaterThan(0);
    expect(screen.getByText("Draft — not sent")).toBeTruthy();
    fireEvent.click(send);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("Send is enabled only when the channel is connected AND the gate would pass", async () => {
    api.messages = [msg({})];
    api.readiness = ready({ adapterEnabled: true });
    api.sendMessage.mockImplementation(async () => msg({ status: "sent", sentAt: "2026-10-08T15:01:00.000Z" }));
    renderTab();
    const send = await screen.findByTestId("send-button");
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith("roland", msg({}).messageId));
  });

  it("shows the consent badge for an unknown OD consent", async () => {
    renderTab();
    expect((await screen.findByTestId("consent-badge")).textContent).toContain("No OD text consent on file");
  });

  it("a block (opt-out) shows its sentence and keeps Send disabled even when connected", async () => {
    api.messages = [msg({})];
    api.readiness = ready({ adapterEnabled: true, consentState: "opted_out", odTextConsent: "not_checked", blockCode: "CONSENT_OPTED_OUT" });
    renderTab();
    expect((await screen.findByTestId("send-block")).textContent).toContain(BLOCK_COPY.CONSENT_OPTED_OUT);
    expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("consent-badge")).textContent).toContain("Opted out");
  });

  it("quiet hours are said out loud", async () => {
    api.readiness = ready({ quietHours: true, blockCode: "QUIET_HOURS" });
    renderTab();
    expect((await screen.findByTestId("quiet-hours")).textContent).toContain("9 PM and 8 AM Central");
  });

  it("a failed message shows the provider's error, and offers no Send", async () => {
    api.messages = [msg({ status: "failed", error: "Carrier rejected the number" })];
    renderTab();
    expect(await screen.findByText("Carrier rejected the number")).toBeTruthy();
    expect(screen.getByText("Not sent")).toBeTruthy();
    expect(screen.queryByTestId("send-button")).toBeNull();
  });

  it("inbound and outbound interleave in the thread", async () => {
    api.messages = [
      msg({ status: "sent", sentAt: "2026-10-08T15:01:00.000Z" }),
      msg({ messageId: "9c9619ff-8b86-4d01-b42d-00cf4fc96402", direction: "inbound", status: "received", body: "Tuesday works", toAddress: null, fromAddress: "+14795550101" }),
    ];
    renderTab();
    expect(await screen.findByText("Tuesday works")).toBeTruthy();
    expect(screen.getByText("From patient")).toBeTruthy();
    expect(screen.getByText("To patient")).toBeTruthy();
  });

  it("Save draft sends caseId + channel + text — never an address", async () => {
    renderTab();
    const box = await screen.findByLabelText("Message");
    fireEvent.change(box, { target: { value: "Hello there" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1));
    const [office, body] = api.createDraft.mock.calls[0];
    expect(office).toBe("roland");
    expect(body).toEqual({ caseId: CASE_ID, channel: "sms", body: "Hello there" });
  });

  it("a seed creates exactly ONE draft from the follow-up, then reports it consumed", async () => {
    const consumed = vi.fn();
    const seed = { followupId: FOLLOWUP_ID, channel: "email" as const };
    const { rerender } = renderTab({ seed, onSeedConsumed: consumed });
    await waitFor(() => expect(consumed).toHaveBeenCalledTimes(1));
    rerender(
      <TooltipProvider>
        <MessagesTab office="roland" tcCase={makeCase()} seed={seed} onSeedConsumed={consumed} />
      </TooltipProvider>,
    );
    expect(api.createDraft).toHaveBeenCalledTimes(1);
    expect(api.createDraft).toHaveBeenCalledWith("roland", { caseId: CASE_ID, channel: "email", followupId: FOLLOWUP_ID });
  });
});

describe("the deep link from the follow-up queue", () => {
  it("opens the Messages tab and seeds one draft", async () => {
    const memory = memoryLocation({
      path: `/tc/cases/${CASE_ID}?tab=messages&draftFrom=${FOLLOWUP_ID}&channel=sms`,
    });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <ThemeProvider defaultTheme="light" switchable>
          <TooltipProvider>
            <Route path="/tc/cases/:id" component={TcCaseView} />
          </TooltipProvider>
        </ThemeProvider>
      </WouterRouter>,
    );
    expect(await screen.findByRole("tab", { name: "Messages", selected: true })).toBeTruthy();
    await waitFor(() =>
      expect(api.createDraft).toHaveBeenCalledWith("roland", { caseId: CASE_ID, channel: "sms", followupId: FOLLOWUP_ID }),
    );
    expect(api.createDraft).toHaveBeenCalledTimes(1);
  });

  it("the follow-up card's Draft message link carries the case, the follow-up and the channel", () => {
    render(
      <WouterRouter>
        <FollowupActionCard
          office="roland"
          today="2026-10-08"
          onCompleted={() => {}}
          onSkipped={() => {}}
          onRescheduled={() => {}}
          followup={{
            followupId: FOLLOWUP_ID,
            caseId: CASE_ID,
            officeId: "roland",
            kind: "followup",
            dueDate: "2026-10-08",
            channel: "email",
            status: "pending",
            talkingPoint: null,
            nurtureType: null,
            patientName: "Test, MangoTest",
            casePhone: "479-555-0101",
            caseStatus: "presented",
            caseUrgency: "medium",
            caseValueCents: 120000,
            assignedTc: "",
          } as React.ComponentProps<typeof FollowupActionCard>["followup"]}
        />
      </WouterRouter>,
    );
    const link = screen.getByTestId("draft-message");
    expect(link.getAttribute("href")).toBe(
      `/tc/cases/${CASE_ID}?tab=messages&draftFrom=${FOLLOWUP_ID}&channel=email`,
    );
  });
});
