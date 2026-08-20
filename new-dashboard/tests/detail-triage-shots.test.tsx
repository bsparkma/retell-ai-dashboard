/**
 * Screenshot DUMPS for triage on the call-detail page.
 *
 * Not an assertion suite — it renders the page into jsdom with SYNTHETIC fixture data
 * and writes the markup to `tests/.shots/*.html`. `scripts/shoot-detail-triage.mjs`
 * then wraps each dump in the app's real built CSS and photographs it with headless
 * Chrome.
 *
 * WHY DUMP RATHER THAN DRIVE THE LIVE APP: the alternative is a running backend, a
 * signed-in session, an entitled tenant and a real Open Dental — for a picture, with
 * REAL PATIENT DATA one wrong environment away from a file committed to this repo.
 * Every name and number below lives in this file and is invented, so a screenshot
 * physically cannot contain PHI.
 *
 * Skipped unless DETAIL_TRIAGE_SHOTS=1, so a normal `pnpm run test` neither writes
 * files nor pays for the render.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const OUT = resolve(import.meta.dirname, ".shots");

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

vi.mock("wouter", () => ({
  useLocation: () => ["/calls/c1", () => {}],
  useRoute: () => [true, { id: "c1" }],
  useParams: () => ({ id: "c1" }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const authState = vi.hoisted(() => ({
  role: "office" as string,
  permissions: ["voice.read", "voice.write", "voice.chart_write"] as string[],
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
      role: authState.role,
      isSuperAdmin: false,
      permissions: authState.permissions,
      homeOffice: null,
    },
  }),
}));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "__all__",
  useOffice: () => ({
    office: "valley",
    offices: [{ officeId: "valley", officeName: "Valley Family Dental", odConnected: true }],
    selected: { officeId: "valley", officeName: "Valley Family Dental", odConnected: true },
  }),
}));

vi.mock("@/hooks/useTranscribeCall", () => ({
  useTranscribeCall: () => ({
    isRunning: () => false,
    request: vi.fn(),
    pendingConfirm: null,
    pendingConfirmKind: null,
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
  }),
}));

const apiMock = vi.hoisted(() => ({
  getUnifiedCall: vi.fn(),
  triageCall: vi.fn(),
  getOpenDentalPatient: vi.fn(),
  searchPatientByPhone: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { normalizeUnifiedCall, type BackendUnifiedCall, type UnifiedCall } from "@/lib/api";
import CallDetail from "@/pages/CallDetail";

/** SYNTHETIC. "MangoTest" is the repo's documented staging fixture, not a person. */
const backendCall = (over: Partial<BackendUnifiedCall> = {}): BackendUnifiedCall => ({
  id: "c1",
  source: "mango",
  office_id: "valley",
  caller_name: "MangoTest Test",
  caller_number: "+15550000000",
  called_number: "+15551111111",
  call_date: "2026-08-18T15:00:00.000Z",
  duration_seconds: 214,
  summary: "Caller asked to move next week's cleaning to a morning slot and mentioned a "
    + "sore tooth on the upper right. Wants a call back before Friday.",
  outcome: "callback requested",
  sentiment: "neutral",
  od_sync_status: "matched",
  od_patient_id: 12828,
  od_patient_name: "Test, MangoTest",
  has_transcript: true,
  transcript: "Thanks for calling Valley Family Dental, this is the front desk.\n"
    + "Hi — I need to move my cleaning next week to a morning if you have one.\n"
    + "Of course. I can see your appointment. Is Tuesday at nine any good?\n"
    + "That works. One more thing, my upper right has been sore for a few days.\n"
    + "I will make a note and have someone call you back before Friday.",
  ...over,
} as unknown as BackendUnifiedCall);

const call = (over: Partial<BackendUnifiedCall> = {}): UnifiedCall =>
  normalizeUnifiedCall(backendCall(over));

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

async function renderDetail(c: UnifiedCall) {
  apiMock.getUnifiedCall.mockResolvedValue(c);
  apiMock.searchPatientByPhone.mockResolvedValue(null);
  apiMock.getOpenDentalPatient.mockRejectedValue(new Error("no OD in shots"));
  render(React.createElement(CallDetail));
  await waitFor(() => expect(screen.getByTestId("call-header-actions")).toBeTruthy());
}

beforeEach(() => {
  authState.role = "office";
  authState.permissions = ["voice.read", "voice.write", "voice.chart_write"];
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

const enabled = process.env.DETAIL_TRIAGE_SHOTS === "1";

describe.skipIf(!enabled)("call-detail triage screenshots", () => {
  it("01 — the header, with both triage actions at rest", async () => {
    await renderDetail(call());
    dump("01-header-idle");
  });

  it("02 — the Mark done popover, open on its five outcomes", async () => {
    await renderDetail(call());
    fireEvent.click(screen.getByTestId("triage-mark-done"));
    await screen.findByText("Left voicemail");
    dump("02-done-popover");
  });

  it("03 — after marking done: the pill, and Reopen in place of the actions", async () => {
    await renderDetail(call({
      triage_status: "done",
      triage_outcome: "scheduled",
      triage_by: { name: "Sarah Front", email: "sarah@carein.ai" },
      triage_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    }));
    dump("03-after-done");
  });

  it("04 — a read-only (tc) user: the state, and no controls", async () => {
    authState.role = "tc";
    authState.permissions = ["voice.read", "tc.full"];
    await renderDetail(call({
      triage_status: "needs_action",
      triage_by: { name: "Sarah Front", email: "sarah@carein.ai" },
      triage_at: new Date(Date.now() - 22 * 60_000).toISOString(),
    }));
    dump("04-read-only");
  });
});
