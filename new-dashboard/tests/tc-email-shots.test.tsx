/**
 * Screenshot DUMP for TC email over Azure Communication Services (queue item 40).
 *
 * Same recipe as tc-sms-shots.test.tsx (item 39): render into jsdom with
 * fixture data that lives in THIS file, write the markup to
 * tests/.shots/tcemail-*.html, then scripts/shoot-tc-email.mjs wraps it in the
 * app's real built CSS and photographs it into docs/screenshots/tc/.
 *
 *   tcemail-01-thread-and-picker  Email connected for Roland: a thread with a
 *                                 template draft (Preview / Send), a sent email
 *                                 ("delivery not tracked"), one still sending,
 *                                 one ACS refused; compose on Email with the
 *                                 template picker
 *   tcemail-02-preview            the Preview dialog: the server-rendered HTML
 *                                 (produced HERE by the same shared renderer)
 *                                 in EmailPreview's sandboxed frame
 *   tcemail-03-office-no-sender   Valley with no sending address: Send disabled,
 *                                 email's reason in words
 *   tcemail-04-followup-card      a nurture follow-up card with "Email template"
 *
 * Shots 01 and 02 are ILLUSTRATIVE: no email can reach these states until
 * Beau's preconditions (ACS resource, domain, identity role, app settings) are
 * done and the switch is turned on.
 *
 * NO NETWORK, NO BACKEND, NO PHI — synthetic names, example.test addresses,
 * the roland / valley test fixture PatNums. Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Router as WouterRouter } from "wouter";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase, TcEmailTemplate } from "../shared/tc/contract";
import type { ChannelReadiness, TcMessage } from "../shared/tc/messaging";
import { renderEmail as sharedRender } from "../shared/tc/emailRender";

const fx = vi.hoisted(() => ({
  messages: [] as unknown[],
  readiness: [] as unknown[],
  templates: [] as unknown[],
  rendered: null as unknown,
}));

vi.mock("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));
vi.mock("@/features/tc/messaging/messagingApi", () => ({
  listCaseMessages: vi.fn(async () => fx.messages),
  getChannelReadiness: vi.fn(async () => fx.readiness),
  createDraft: vi.fn(),
  editDraft: vi.fn(),
  sendMessage: vi.fn(),
  discardDraft: vi.fn(),
  recordOptOut: vi.fn(),
  markSeen: vi.fn(async () => 0),
  renderEmail: vi.fn(async () => fx.rendered),
}));
vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, listTemplates: vi.fn(async () => fx.templates) };
});

import { MessagesTab } from "../client/src/features/tc/caseview/MessagesTab";
import { FollowupActionCard } from "../client/src/features/tc/followups/FollowupActionCard";
import { TooltipProvider } from "../client/src/components/ui/tooltip";

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
afterEach(cleanup);

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), `<div style="padding:24px">${document.body.innerHTML}</div>`, "utf8");
}

const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const tcCase = {
  caseId: CASE_ID,
  officeId: "roland",
  patientName: "Test, MangoTest",
  phone: "479-555-0101",
  email: "patient.one@example.test",
  odPatientId: 12828,
} as TcCase;

function msg(over: Partial<TcMessage>): TcMessage {
  return {
    messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96401",
    officeId: "roland",
    caseId: CASE_ID,
    direction: "outbound",
    channel: "email",
    toAddress: "patient.one@example.test",
    fromAddress: "donotreply@roland.example.test",
    body: "",
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
    emailTemplated: false,
    ...over,
  };
}

function ready(email: Partial<ChannelReadiness>): ChannelReadiness[] {
  return [
    { channel: "sms", address: "+14795550101", adapterEnabled: true, adapterReason: null, consentState: "unknown", odTextConsent: "yes", quietHours: false, blockCode: null },
    { channel: "email", address: "patient.one@example.test", adapterEnabled: true, adapterReason: null, consentState: "unknown", odTextConsent: "not_checked", quietHours: false, blockCode: null, ...email },
  ];
}

const TEMPLATE_ID = "9c9619ff-8b86-4d01-b42d-00cf4fc96477";
const TEMPLATE_BLOCKS = [
  { id: "h1", type: "header", logoUrl: null, logoWidth: 140, headline: "Hi {{patient.firstName}}", subhead: "A note from {{practice.name}}", bgColor: "#f0fdfa", textColor: "#0f172a", align: "center" },
  { id: "t1", type: "text", html: "<p>Thank you for coming in to talk about your treatment.</p><p>If anything is on your mind, just reply to this email or give us a call. We are glad to help.</p>", bgColor: "#ffffff", textColor: "#0f172a", fontSize: 15 },
  { id: "b1", type: "button", label: "Call the office", href: "tel:+19185550100", bgColor: "#0ea5b8", textColor: "#ffffff", align: "center", fullWidth: false },
  { id: "s1", type: "signature", source: "tc", customText: "", showPhone: true, showEmail: true },
] as const;

const TEMPLATES: TcEmailTemplate[] = [
  { templateId: TEMPLATE_ID, legacyId: null, officeId: "roland", name: "Consult follow-up", category: "consult_followup", subject: "Following up, {{patient.firstName}}", preheader: "", blocks: TEMPLATE_BLOCKS as unknown as TcEmailTemplate["blocks"], isSeed: true },
  { templateId: "9c9619ff-8b86-4d01-b42d-00cf4fc96478", legacyId: null, officeId: "roland", name: "Financing options", category: "financing_followup", subject: "Payment options", preheader: "", blocks: TEMPLATE_BLOCKS as unknown as TcEmailTemplate["blocks"], isSeed: true },
];

const VALUES = {
  "patient.firstName": "MangoTest",
  "practice.name": "Roland",
  "practice.phone": "(918) 555-0100",
  "sender.name": "TC User",
  "sender.email": "front@roland.example.test",
};

const THREAD: TcMessage[] = [
  msg({ messageId: "1b9619ff-8b86-4d01-b42d-00cf4fc96401", status: "sent", provider: "acs", providerMessageId: "op-1", subject: "Following up from Roland", body: "Hi MangoTest,\n\nThis is Roland following up on the treatment plan we went over. If you have any questions, just reply to this email or give us a call.\n\nThank you,\nRoland", createdAt: "2026-10-05T15:00:00.000Z", sentAt: "2026-10-05T15:00:04.000Z" }),
  msg({ messageId: "2b9619ff-8b86-4d01-b42d-00cf4fc96402", status: "queued", provider: "acs", providerMessageId: "op-2", subject: "Payment options from Roland", body: "Hi MangoTest,\n\nWe have payment options that may help with your treatment.", createdAt: "2026-10-06T14:00:00.000Z", sentAt: "2026-10-06T14:00:07.000Z" }),
  msg({ messageId: "3b9619ff-8b86-4d01-b42d-00cf4fc96403", status: "failed", subject: "Checking in from Roland", body: "Hi MangoTest,\n\nJust checking in.", error: "The email service did not send it (EmailDroppedAllRecipientsSuppressed).", createdAt: "2026-10-07T14:00:00.000Z" }),
  msg({ messageId: "4b9619ff-8b86-4d01-b42d-00cf4fc96404", status: "draft", emailTemplated: true, templateId: TEMPLATE_ID, subject: "Following up, MangoTest", body: "Hi MangoTest\nA note from Roland\n\nThank you for coming in to talk about your treatment.\n\nIf anything is on your mind, just reply to this email or give us a call. We are glad to help.\n\nTC User", fromAddress: null, createdAt: "2026-10-08T15:00:00.000Z" }),
];

const SHOOT = process.env.TC_SHOTS === "1";

function renderTab(office: "roland" | "valley" = "roland") {
  render(
    <TooltipProvider>
      <div style={{ maxWidth: 1180 }}>
        <MessagesTab
          office={office}
          tcCase={{ ...tcCase, officeId: office, odPatientId: office === "valley" ? 7115 : 12828, patientName: office === "valley" ? "Stedi TestValley" : "Test, MangoTest" }}
        />
      </div>
    </TooltipProvider>,
  );
}

async function pickEmailAndTemplate() {
  fireEvent.click(await screen.findByRole("radio", { name: /Email/ }));
  const select = (await screen.findByTestId("template-picker")).querySelector("select") as HTMLSelectElement;
  await waitFor(() => {
    if (select.options.length < 2) throw new Error("templates not loaded");
  });
  fireEvent.change(select, { target: { value: TEMPLATE_ID } });
  // A DOM dump carries attributes, not the live selection: stamp it.
  select.options[select.selectedIndex].setAttribute("selected", "");
}

describe.skipIf(!SHOOT)("TC email screenshot dumps", () => {
  it("01 — the thread, honest states, and the template picker", async () => {
    fx.messages = THREAD;
    fx.readiness = ready({});
    fx.templates = TEMPLATES;
    renderTab();
    await screen.findByText(/EmailDroppedAllRecipientsSuppressed/);
    await pickEmailAndTemplate();
    dump("tcemail-01-thread-and-picker");
  });

  it("02 — the server-rendered preview in the sandboxed frame", async () => {
    fx.messages = THREAD;
    fx.readiness = ready({});
    fx.templates = TEMPLATES;
    fx.rendered = sharedRender({
      subject: "Following up, {{patient.firstName}}",
      preheader: "A note from {{practice.name}}",
      content: { kind: "blocks", blocks: TEMPLATE_BLOCKS },
      values: VALUES,
      footer: { practiceName: "Roland", practicePhone: "(918) 555-0100", unsubscribeUrl: null },
    });
    renderTab();
    await screen.findByText(/EmailDroppedAllRecipientsSuppressed/);
    fireEvent.click(screen.getByTestId("preview-draft"));
    await screen.findByTestId("email-preview-frame");
    dump("tcemail-02-preview");
  });

  it("03 — an office with no sending address", async () => {
    fx.messages = [msg({ officeId: "valley", status: "draft", subject: "Following up from Valley Fort Smith", body: "Hi there,\n\nThis is Valley Fort Smith following up on the treatment plan we went over." })];
    fx.readiness = ready({ adapterEnabled: false, adapterReason: "office_not_configured" });
    fx.templates = [];
    renderTab("valley");
    await screen.findByTestId("send-button");
    fireEvent.click(await screen.findByRole("radio", { name: /Email/ }));
    dump("tcemail-03-office-no-sender");
  });

  it("04 — the follow-up card's Email template action", async () => {
    render(
      <WouterRouter>
        <div style={{ maxWidth: 900 }}>
          <FollowupActionCard
            office="roland"
            today="2026-10-08"
            onCompleted={() => {}}
            onSkipped={() => {}}
            onRescheduled={() => {}}
            followup={{
              followupId: "7a9619ff-8b86-4d01-b42d-00cf4fc96499",
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
        </div>
      </WouterRouter>,
    );
    await screen.findByTestId("email-template");
    dump("tcemail-04-followup-card");
  });
});
