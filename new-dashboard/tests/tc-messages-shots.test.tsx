/**
 * Screenshot DUMP for the TC Messages tab (queue item 38).
 *
 * Same recipe as hyg-switch-shots.test.tsx: render into jsdom with fixture data
 * that lives in THIS file, write the markup to tests/.shots/tcmsg-*.html, then
 * scripts/shoot-tc-messages.mjs wraps it in the app's real built CSS and
 * photographs it into docs/screenshots/tc/ (TC's folder, beside hyg's).
 *
 *   tcmsg-01-thread        the thread: a seeded draft (Send disabled, reason
 *                          shown), a sent text, the patient's reply, a failed
 *                          email with the provider's error; badge "No OD text
 *                          consent on file"
 *   tcmsg-02-opted-out     an opted-out number: red badge, block sentence on
 *                          the draft, Record opt-out greyed
 *   tcmsg-03-quiet-hours   after 9 PM Central: the quiet-hours line
 *   tcmsg-04-followup-card the follow-up queue card with "Draft message"
 *
 * NO NETWORK, NO BACKEND, NO PHI — synthetic names, 555-01xx numbers, the
 * roland test fixture PatNum. Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Router as WouterRouter } from "wouter";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase } from "../shared/tc/contract";
import type { ChannelReadiness, TcMessage } from "../shared/tc/messaging";

const fx = vi.hoisted(() => ({ messages: [] as unknown[], readiness: [] as unknown[] }));

vi.mock("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));
vi.mock("@/features/tc/messaging/messagingApi", () => ({
  listCaseMessages: vi.fn(async () => fx.messages),
  getChannelReadiness: vi.fn(async () => fx.readiness),
  createDraft: vi.fn(),
  editDraft: vi.fn(),
  sendMessage: vi.fn(),
  discardDraft: vi.fn(),
  recordOptOut: vi.fn(),
}));

import { MessagesTab } from "../client/src/features/tc/caseview/MessagesTab";
import { FollowupActionCard } from "../client/src/features/tc/followups/FollowupActionCard";
import { TooltipProvider } from "../client/src/components/ui/tooltip";

beforeAll(() => {
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
  email: "patient@example.test",
  odPatientId: 12828,
} as TcCase;

function msg(over: Partial<TcMessage>): TcMessage {
  return {
    messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96401",
    officeId: "roland",
    caseId: CASE_ID,
    direction: "outbound",
    channel: "sms",
    toAddress: "+14795550101",
    fromAddress: null,
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
    ...over,
  };
}

function ready(sms: Partial<ChannelReadiness>): ChannelReadiness[] {
  return [
    { channel: "sms", address: "+14795550101", adapterEnabled: false, consentState: "unknown", odTextConsent: "unknown", quietHours: false, blockCode: null, ...sms },
    { channel: "email", address: "patient@example.test", adapterEnabled: false, consentState: "unknown", odTextConsent: "not_checked", quietHours: false, blockCode: null },
  ];
}

const THREAD: TcMessage[] = [
  msg({
    messageId: "1b9619ff-8b86-4d01-b42d-00cf4fc96401",
    status: "sent",
    body: "Hi MangoTest, this is Roland Family Dental following up on the treatment plan we went over. Do you have any questions we can help with? Reply here or give us a call. Reply STOP to opt out.",
    provider: "fake",
    providerMessageId: "PM1",
    createdAt: "2026-10-06T15:00:00.000Z",
    sentAt: "2026-10-06T15:02:00.000Z",
    sentBy: "tc@carein.ai",
  }),
  msg({
    messageId: "2b9619ff-8b86-4d01-b42d-00cf4fc96402",
    direction: "inbound",
    status: "received",
    toAddress: null,
    fromAddress: "+14795550101",
    body: "Thanks! Can I come in Tuesday afternoon to talk about payment options?",
    createdAt: "2026-10-06T16:10:00.000Z",
  }),
  msg({
    messageId: "3b9619ff-8b86-4d01-b42d-00cf4fc96403",
    channel: "email",
    toAddress: "patient@example.test",
    status: "failed",
    subject: "Payment options from Roland Family Dental",
    body: "Hi MangoTest,\n\nWe have payment options that may help with your treatment.",
    error: "Email sending is not connected yet.",
    createdAt: "2026-10-07T14:00:00.000Z",
  }),
  msg({
    messageId: "4b9619ff-8b86-4d01-b42d-00cf4fc96404",
    status: "draft",
    templateId: "followup.default",
    body: "Hi MangoTest, this is Roland Family Dental. Tuesday at 2:30 works — want us to hold it? Reply STOP to opt out.",
    createdAt: "2026-10-08T15:00:00.000Z",
  }),
];

const SHOOT = process.env.TC_SHOTS === "1";

function renderTab() {
  render(
    <TooltipProvider>
      <div style={{ maxWidth: 1180 }}>
        <MessagesTab office="roland" tcCase={tcCase} />
      </div>
    </TooltipProvider>,
  );
}

describe.skipIf(!SHOOT)("TC messages screenshot dumps", () => {
  it("01 — the thread", async () => {
    fx.messages = THREAD;
    fx.readiness = ready({});
    renderTab();
    await screen.findByTestId("messages-thread");
    dump("tcmsg-01-thread");
  });

  it("02 — opted out", async () => {
    fx.messages = [THREAD[3]];
    fx.readiness = ready({ consentState: "opted_out", odTextConsent: "not_checked", blockCode: "CONSENT_OPTED_OUT" });
    renderTab();
    await screen.findByTestId("send-block");
    dump("tcmsg-02-opted-out");
  });

  it("03 — quiet hours", async () => {
    fx.messages = [THREAD[3]];
    fx.readiness = ready({ odTextConsent: "yes", quietHours: true, blockCode: "QUIET_HOURS" });
    renderTab();
    await screen.findByTestId("quiet-hours");
    dump("tcmsg-03-quiet-hours");
  });

  it("04 — the follow-up card's Draft message action", () => {
    render(
      <WouterRouter>
        <div style={{ maxWidth: 820 }}>
          <FollowupActionCard
            office="roland"
            today="2026-10-08"
            onCompleted={() => {}}
            onSkipped={() => {}}
            onRescheduled={() => {}}
            followup={{
              followupId: "7a9619ff-8b86-4d01-b42d-00cf4fc96400",
              caseId: CASE_ID,
              officeId: "roland",
              kind: "followup",
              dueDate: "2026-10-08",
              channel: "text",
              status: "pending",
              talkingPoint: "Ask whether the payment plan options helped.",
              nurtureType: null,
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
    dump("tcmsg-04-followup-card");
  });
});
