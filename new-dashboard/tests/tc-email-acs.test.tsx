/**
 * TC email on screen (queue item 40):
 *
 *   - The email channel is live only when the SERVER says so for this office,
 *     and when it is not, the reason is in email's words.
 *   - Honest states: an email's "Sent" says delivery is not tracked (with a
 *     tooltip), "queued" says it was still sending when we last checked, and
 *     nothing email is ever green.
 *   - The template picker reuses the office's template LIBRARY: Preview asks
 *     the server to render (shown in EmailPreview's sandboxed frame), and
 *     "Draft from template" writes a draft (never a send).
 *   - A template draft's body is read-only when editing; Preview on any email
 *     draft renders exactly that draft.
 *   - The follow-up card's "Email template" action opens the picker for that
 *     follow-up without writing anything, and the draft then carries it.
 *   - EmailPreview's html mode is an iframe with sandbox="" (no scripts).
 *
 * NO NETWORK, NO PHI — synthetic names, the roland fixture PatNum, example.test.
 */
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase, TcEmailTemplate } from "../shared/tc/contract";
import type { ChannelReadiness, TcMessage } from "../shared/tc/messaging";
import { renderEmail as sharedRender } from "../shared/tc/emailRender";

const api = vi.hoisted(() => ({
  messages: [] as unknown[],
  readiness: [] as unknown[],
  templates: [] as unknown[],
  listCaseMessages: vi.fn(),
  getChannelReadiness: vi.fn(),
  createDraft: vi.fn(),
  editDraft: vi.fn(),
  sendMessage: vi.fn(),
  discardDraft: vi.fn(),
  recordOptOut: vi.fn(),
  markSeen: vi.fn(),
  renderEmail: vi.fn(),
  listTemplates: vi.fn(),
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
  renderEmail: api.renderEmail,
}));

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, listTemplates: api.listTemplates };
});

import { MessagesTab } from "../client/src/features/tc/caseview/MessagesTab";
import { FollowupActionCard } from "../client/src/features/tc/followups/FollowupActionCard";
import { EmailPreview } from "../client/src/features/tc/email/EmailPreview";
import { TooltipProvider } from "../client/src/components/ui/tooltip";
import { EMAIL_ADAPTER_REASON_COPY, statusLabel, statusTooltip } from "../client/src/features/tc/messaging/copy";

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
const FOLLOWUP_ID = "7a9619ff-8b86-4d01-b42d-00cf4fc96499";
const TEMPLATE_ID = "9c9619ff-8b86-4d01-b42d-00cf4fc96477";

function makeCase(): TcCase {
  return {
    caseId: CASE_ID,
    legacyId: null,
    officeId: "roland",
    patientName: "Test, MangoTest",
    patientAge: 40,
    phone: "479-555-0101",
    email: "patient.one@example.test",
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
    channel: "email",
    toAddress: "patient.one@example.test",
    fromAddress: null,
    body: "Hi MangoTest,\n\nThanks for coming in to Roland.",
    subject: "Following up, MangoTest",
    templateId: null,
    status: "draft",
    provider: null,
    providerMessageId: null,
    error: null,
    createdBy: "tc@carein.ai",
    sentBy: null,
    createdAt: "2026-10-08T15:00:00.000Z",
    sentAt: null,
    emailTemplated: false,
    ...over,
  };
}

function ready(email: Partial<ChannelReadiness> = {}): ChannelReadiness[] {
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
    },
    {
      channel: "email",
      address: "patient.one@example.test",
      adapterEnabled: true,
      adapterReason: null,
      consentState: "unknown",
      odTextConsent: "not_checked",
      quietHours: false,
      blockCode: null,
      ...email,
    },
  ];
}

const TEMPLATE: TcEmailTemplate = {
  templateId: TEMPLATE_ID,
  legacyId: null,
  officeId: "roland",
  name: "Consult follow-up",
  category: "consult_followup",
  subject: "Following up, {{patient.firstName}}",
  preheader: "",
  blocks: [{ id: "t1", type: "text", html: "<p>Thanks for coming in.</p>", bgColor: "#ffffff", textColor: "#0f172a", fontSize: 15 }],
  isSeed: false,
};

const RENDERED = sharedRender({
  subject: "Following up, MangoTest",
  content: { kind: "text", body: "Hi MangoTest,\n\nThanks for coming in to Roland." },
  values: {},
  footer: { practiceName: "Roland", unsubscribeUrl: null },
});

beforeEach(() => {
  api.messages = [];
  api.readiness = ready();
  api.templates = [TEMPLATE];
  api.listCaseMessages.mockReset().mockImplementation(async () => api.messages);
  api.getChannelReadiness.mockReset().mockImplementation(async () => api.readiness);
  api.listTemplates.mockReset().mockImplementation(async () => api.templates);
  api.renderEmail.mockReset().mockImplementation(async () => RENDERED);
  api.createDraft.mockReset().mockImplementation(async () => msg({ emailTemplated: true }));
  api.editDraft.mockReset();
  api.markSeen.mockReset().mockImplementation(async () => 0);
  api.sendMessage.mockReset();
});
afterEach(cleanup);

function renderTab(props: Partial<React.ComponentProps<typeof MessagesTab>> = {}) {
  return render(
    <TooltipProvider>
      <MessagesTab office="roland" tcCase={makeCase()} {...props} />
    </TooltipProvider>,
  );
}

async function chooseEmail() {
  const radio = await screen.findByRole("radio", { name: /Email/ });
  fireEvent.click(radio);
}

describe("email readiness comes from the server, per office", () => {
  it("connected → an email draft's Send is enabled", async () => {
    api.messages = [msg({})];
    renderTab();
    const send = await screen.findByTestId("send-button");
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it("no sending address for this office → email's own words, Send disabled", async () => {
    api.messages = [msg({})];
    api.readiness = ready({ adapterEnabled: false, adapterReason: "office_not_configured" });
    renderTab();
    const send = await screen.findByTestId("send-button");
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(EMAIL_ADAPTER_REASON_COPY.office_not_configured).length).toBeGreaterThan(0);
    expect(screen.getByText("No sending address for this office")).toBeTruthy();
    expect(screen.queryByText(/texting number/)).toBeNull();
  });
});

describe("email delivery states are honest", () => {
  it("sent says delivery is not tracked (tooltip explains); queued says still sending; nothing is green", async () => {
    api.messages = [
      msg({ messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96410", status: "sent", provider: "acs", providerMessageId: "op-1", sentAt: "2026-10-08T15:01:00.000Z" }),
      msg({ messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96411", status: "queued", provider: "acs", providerMessageId: "op-2", sentAt: "2026-10-08T15:02:00.000Z" }),
      msg({ messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96412", status: "failed", error: "The email service did not send it (EmailDroppedAllRecipientsSuppressed)." }),
    ];
    renderTab();
    await screen.findByText(/EmailDroppedAllRecipientsSuppressed/);
    const chips = screen.getAllByTestId("message-status");
    expect(chips.map((c) => c.textContent)).toEqual([
      "Sent — delivery not tracked",
      "Accepted — still sending when we last checked",
      "Not sent",
    ]);
    expect(chips[0].getAttribute("title")).toMatch(/never show Delivered/);
    for (const c of chips) expect(c.className).not.toMatch(/emerald/);
  });

  it("copy: an email never reads Delivered or Not delivered", () => {
    expect(statusLabel({ channel: "email", status: "failed", providerMessageId: "op-9" })).toBe("Not sent");
    expect(statusLabel({ channel: "sms", status: "failed", providerMessageId: "SM9" })).toBe("Not delivered");
    expect(statusTooltip({ channel: "email", status: "sent" })).toMatch(/not tracked/);
  });
});

describe("the template picker reuses the template library", () => {
  it("Preview renders on the server and shows it in the sandboxed frame; Draft writes a draft, never sends", async () => {
    renderTab();
    await chooseEmail();
    const picker = await screen.findByTestId("template-picker");
    const select = picker.querySelector("select") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: TEMPLATE_ID } });

    fireEvent.click(screen.getByTestId("preview-template"));
    await waitFor(() => expect(api.renderEmail).toHaveBeenCalledWith("roland", { caseId: CASE_ID, templateId: TEMPLATE_ID }));
    const frame = (await screen.findByTestId("email-preview-frame")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Thanks for coming in to Roland");

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("draft-from-template"));
    await waitFor(() =>
      expect(api.createDraft).toHaveBeenCalledWith("roland", { caseId: CASE_ID, channel: "email", emailTemplateId: TEMPLATE_ID }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("Preview on an email draft renders exactly that draft", async () => {
    api.messages = [msg({ emailTemplated: true, templateId: TEMPLATE_ID })];
    renderTab();
    expect(await screen.findByTestId("templated-note")).toBeTruthy();
    fireEvent.click(screen.getByTestId("preview-draft"));
    await waitFor(() => expect(api.renderEmail).toHaveBeenCalledWith("roland", { messageId: msg({}).messageId }));
    expect(await screen.findByTestId("email-preview-frame")).toBeTruthy();
  });

  it("editing a template draft: the body is read-only and says why", async () => {
    api.messages = [msg({ emailTemplated: true })];
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(screen.getByTestId("templated-edit-note")).toBeTruthy();
  });

  it("an empty library says so instead of an empty dropdown", async () => {
    api.templates = [];
    renderTab();
    await chooseEmail();
    expect(await screen.findByText(/No templates in this office's library yet/)).toBeTruthy();
  });
});

describe("the follow-up card's Email template action", () => {
  it("links to the case's Messages tab with the picker for that follow-up", () => {
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
            kind: "nurture",
            dueDate: "2026-10-08",
            channel: "email",
            status: "pending",
            talkingPoint: null,
            nurtureType: "check_in",
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
    expect(screen.getByTestId("email-template").getAttribute("href")).toBe(
      `/tc/cases/${CASE_ID}?tab=messages&draftFrom=${FOLLOWUP_ID}&channel=email&pickTemplate=1`,
    );
  });

  it("the pickTemplate seed writes NOTHING; the draft the TC then makes carries the follow-up", async () => {
    const consumed = vi.fn();
    renderTab({ seed: { followupId: FOLLOWUP_ID, channel: "email", pickTemplate: true }, onSeedConsumed: consumed });
    expect(await screen.findByTestId("template-for-followup")).toBeTruthy();
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(api.createDraft).not.toHaveBeenCalled();
    const select = (await screen.findByTestId("template-picker")).querySelector("select") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: TEMPLATE_ID } });
    fireEvent.click(screen.getByTestId("draft-from-template"));
    await waitFor(() =>
      expect(api.createDraft).toHaveBeenCalledWith("roland", {
        caseId: CASE_ID,
        channel: "email",
        emailTemplateId: TEMPLATE_ID,
        followupId: FOLLOWUP_ID,
      }),
    );
  });
});

describe("EmailPreview", () => {
  it("html mode is an isolated, script-less frame; blocks mode is unchanged", () => {
    const { unmount } = render(<EmailPreview subject="S" html={'<p>hi</p><script>alert(1)</script>'} />);
    const frame = screen.getByTestId("email-preview-frame");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    unmount();
    render(<EmailPreview subject="S" preheader="" blocks={[]} />);
    expect(screen.getByText("No blocks yet")).toBeTruthy();
  });
});
