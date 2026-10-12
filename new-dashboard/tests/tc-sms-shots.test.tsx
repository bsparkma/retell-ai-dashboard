/**
 * Screenshot DUMP for TC texting over Twilio (queue item 39).
 *
 * Same recipe as tc-messages-shots.test.tsx (item 38): render into jsdom with
 * fixture data that lives in THIS file, write the markup to
 * tests/.shots/tcsms-*.html, then scripts/shoot-tc-sms.mjs wraps it in the
 * app's real built CSS and photographs it into docs/screenshots/tc/.
 *
 *   tcsms-01-delivery-states   SMS connected for Roland: a thread showing every
 *                              delivery state honestly (queued, sent — not
 *                              confirmed, delivered, not delivered + the
 *                              carrier's reason) and the patient's reply
 *   tcsms-02-office-no-number  Valley with no texting number: Send disabled,
 *                              the reason in words, picker "No number for this office"
 *   tcsms-03-switched-off      the kill switch off: "switched off"
 *   tcsms-04-texts-page        /tc/texts: a reply matched to a case, and an
 *                              unmatched text
 *   tcsms-05-nav-count         the TC sidebar with the unseen count on Texts
 *
 * Shots 01 and 04 are ILLUSTRATIVE: no text can reach any of these states
 * until Beau's preconditions (BAA, A2P 10DLC, numbers, Key Vault) are done and
 * the switch is turned on.
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
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

import type { TcCase } from "../shared/tc/contract";
import type { ChannelReadiness, TcMessage } from "../shared/tc/messaging";

const fx = vi.hoisted(() => ({
  messages: [] as unknown[],
  readiness: [] as unknown[],
  unseen: [] as unknown[],
  inbox: [] as unknown[],
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
  listUnseenOnCases: vi.fn(async () => fx.unseen),
  listInbox: vi.fn(async () => fx.inbox),
  getUnseenCount: vi.fn(async () => ({ count: 2, capped: false })),
  getUnseenTotal: vi.fn(async () => ({ count: 2, capped: false })),
}));
vi.mock("@/features/tc/components/TcShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/components/TcShell")>();
  return { ...actual, useTcOffice: () => "roland" };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  const { ACTIONS } = await import("@/lib/permissions");
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "TC User",
      email: "tc@carein.ai",
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN Dental LLC", modules: ["voice", "tc"] },
      role: "tc",
      isSuperAdmin: false,
      permissions: [...ACTIONS],
    })),
  };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, getHealth: vi.fn(() => new Promise(() => {})) } };
});
vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  OfficeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useOffice: () => ({
    offices: [{ officeId: "roland", officeName: "Roland" }],
    office: "roland",
    setOffice: () => {},
    selected: null,
    loading: false,
    error: null,
    reload: () => {},
  }),
}));

import { MessagesTab } from "../client/src/features/tc/caseview/MessagesTab";
import TcTexts from "../client/src/pages/tc/TcTexts";
import { TooltipProvider } from "../client/src/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import RequireAuth from "@/components/RequireAuth";
import DashboardLayout from "@/components/DashboardLayout";

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
  email: null,
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
    fromAddress: "+14795550150",
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
    { channel: "sms", address: "+14795550101", adapterEnabled: true, adapterReason: null, consentState: "unknown", odTextConsent: "yes", quietHours: false, blockCode: null, ...sms },
    { channel: "email", address: null, adapterEnabled: false, adapterReason: "not_configured", consentState: "unknown", odTextConsent: "not_checked", quietHours: false, blockCode: null },
  ];
}

const FOLLOW_UP =
  "Hi MangoTest, this is Roland following up on the treatment plan we went over. Do you have any questions we can help with? Reply here or give us a call. Reply STOP to opt out.";

const DELIVERY_THREAD: TcMessage[] = [
  msg({ messageId: "1b9619ff-8b86-4d01-b42d-00cf4fc96401", status: "delivered", provider: "twilio", providerMessageId: "SM1", body: FOLLOW_UP, createdAt: "2026-10-05T15:00:00.000Z", sentAt: "2026-10-05T15:01:00.000Z" }),
  msg({ messageId: "2b9619ff-8b86-4d01-b42d-00cf4fc96402", direction: "inbound", status: "received", toAddress: "+14795550150", fromAddress: "+14795550101", body: "Thanks! Can I come in Tuesday afternoon to talk about payment options?", createdAt: "2026-10-05T16:10:00.000Z" }),
  msg({ messageId: "3b9619ff-8b86-4d01-b42d-00cf4fc96403", status: "sent", provider: "twilio", providerMessageId: "SM2", body: "Tuesday at 2:30 works. See you then! Reply STOP to opt out.", createdAt: "2026-10-06T14:00:00.000Z", sentAt: "2026-10-06T14:01:00.000Z" }),
  msg({ messageId: "4b9619ff-8b86-4d01-b42d-00cf4fc96404", status: "failed", provider: "twilio", providerMessageId: "SM3", body: "A reminder about your visit tomorrow at 2:30. Reply STOP to opt out.", error: "Not delivered (Twilio error 30003: the phone is unreachable or switched off).", createdAt: "2026-10-07T14:00:00.000Z", sentAt: "2026-10-07T14:00:30.000Z" }),
  msg({ messageId: "5b9619ff-8b86-4d01-b42d-00cf4fc96405", status: "queued", provider: "twilio", providerMessageId: "SM4", body: "Just checking that you got our reminder. Reply STOP to opt out.", createdAt: "2026-10-08T15:00:00.000Z", sentAt: "2026-10-08T15:00:10.000Z" }),
];

const DRAFT = msg({ messageId: "6b9619ff-8b86-4d01-b42d-00cf4fc96406", status: "draft", body: FOLLOW_UP, fromAddress: null });

const SHOOT = process.env.TC_SHOTS === "1";

function renderTab(office: "roland" | "valley" = "roland") {
  render(
    <TooltipProvider>
      <div style={{ maxWidth: 1180 }}>
        <MessagesTab office={office} tcCase={{ ...tcCase, officeId: office, odPatientId: office === "valley" ? 7115 : 12828 }} />
      </div>
    </TooltipProvider>,
  );
}

describe.skipIf(!SHOOT)("TC texting screenshot dumps", () => {
  it("01 — delivery states, honestly", async () => {
    fx.messages = DELIVERY_THREAD;
    fx.readiness = ready({});
    renderTab();
    await screen.findByTestId("messages-thread");
    dump("tcsms-01-delivery-states");
  });

  it("02 — an office with no texting number", async () => {
    fx.messages = [{ ...DRAFT, officeId: "valley" }];
    fx.readiness = ready({ adapterEnabled: false, adapterReason: "office_not_configured" });
    renderTab("valley");
    await screen.findAllByTestId("adapter-reason");
    dump("tcsms-02-office-no-number");
  });

  it("03 — the kill switch off", async () => {
    fx.messages = [DRAFT];
    fx.readiness = ready({ adapterEnabled: false, adapterReason: "switched_off" });
    renderTab();
    await screen.findAllByTestId("adapter-reason");
    dump("tcsms-03-switched-off");
  });

  it("04 — the Texts page", async () => {
    fx.unseen = [
      msg({ messageId: "7b9619ff-8b86-4d01-b42d-00cf4fc96407", direction: "inbound", status: "received", toAddress: "+14795550150", fromAddress: "+14795550101", body: "Is there anything open Thursday morning?", createdAt: "2026-10-08T14:20:00.000Z" }),
    ];
    fx.inbox = [
      msg({ messageId: "8b9619ff-8b86-4d01-b42d-00cf4fc96408", caseId: null, direction: "inbound", status: "received", toAddress: "+14795550150", fromAddress: "+14795550109", body: "Hi, who is this? I got a missed call from this number.", createdAt: "2026-10-08T13:05:00.000Z" }),
    ];
    const { hook } = memoryLocation({ path: "/tc/texts", static: true });
    render(
      <WouterRouter hook={hook}>
        <TooltipProvider>
          <div style={{ maxWidth: 1180 }}>
            <TcTexts />
          </div>
        </TooltipProvider>
      </WouterRouter>,
    );
    await screen.findByText("Is there anything open Thursday morning?");
    dump("tcsms-04-texts-page");
  });

  it("05 — the TC nav count", async () => {
    const { hook } = memoryLocation({ path: "/tc/texts", static: true });
    render(
      <WouterRouter hook={hook}>
        <ThemeProvider defaultTheme="light" switchable>
          <TooltipProvider>
            <AuthProvider>
              <RequireAuth>
                <ModuleProvider>
                  <SlotMarkersProvider>
                    <DashboardLayout>
                      <div style={{ padding: 24 }}>(page)</div>
                    </DashboardLayout>
                  </SlotMarkersProvider>
                </ModuleProvider>
              </RequireAuth>
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </WouterRouter>,
    );
    await screen.findByTestId("tc-texts-unseen");
    dump("tcsms-05-nav-count");
  });
});
