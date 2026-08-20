/**
 * The chart-write buttons on the call-detail page follow voice.chart_write.
 *
 * A `tc` user holds READ-ONLY voice (backend/config/permissions.js:
 * 'voice.read' includes tc, 'voice.chart_write' does not). The server has always
 * refused their sends with a 403 — but the page kept offering them, so the only
 * way to learn the role's shape was to click something and be told no.
 *
 * There are THREE affordances that start the same chart write, and hiding two of
 * them would have left the hole open:
 *   - "Send full transcript to chart"  (Transcript card)
 *   - "Send summary to chart"          (AI Analysis card)
 *   - "Send to chart"                  (Patient Record panel, review-then-send)
 *
 * What stays visible for everyone is the STATE: who the call was matched to, and
 * that the note has not been written yet. That is a fact worth knowing whether or
 * not you are the person who files it.
 *
 * UX only. `tests/role-permissions.test.ts` pins the action list against the
 * backend map; this file pins what the page does with it.
 *
 * No PHI: every name and number below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

vi.mock("wouter", () => ({
  useLocation: () => ["/calls/c1", () => {}],
  useRoute: () => [true, { id: "c1" }],
  useParams: () => ({ id: "c1" }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

/** The signed-in user. `permissions` is the whole point of this suite. */
const authState = vi.hoisted(() => ({
  role: "office" as string,
  permissions: [] as string[],
  isSuperAdmin: false,
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
      role: authState.role,
      isSuperAdmin: authState.isSuperAdmin,
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
  getOpenDentalPatient: vi.fn(),
  searchPatientByPhone: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { normalizeUnifiedCall, type BackendUnifiedCall, type UnifiedCall } from "@/lib/api";
import CallDetail from "@/pages/CallDetail";

/**
 * A matched-but-unsent call carrying both a summary and a transcript — the one
 * state in which all three affordances are offered at once.
 */
const backendCall = (over: Partial<BackendUnifiedCall> = {}): BackendUnifiedCall => ({
  id: "c1",
  source: "mango",
  office_id: "valley",
  caller_name: "Synthetic Caller",
  caller_number: "+15550000000",
  called_number: "+15551111111",
  call_date: "2026-08-18T15:00:00.000Z",
  duration_seconds: 214,
  summary: "Caller asked to move a cleaning to a morning slot.",
  od_sync_status: "matched",
  od_patient_id: 12828,
  od_patient_name: "Test, MangoTest",
  has_transcript: true,
  transcript: "Front desk speaking.\nI would like to move my cleaning.",
  ...over,
} as unknown as BackendUnifiedCall);

const call = (over: Partial<BackendUnifiedCall> = {}): UnifiedCall =>
  normalizeUnifiedCall(backendCall(over));

/** Every label on the page that starts a chart write. */
const CHART_ACTIONS = ["Send full transcript to chart", "Send summary to chart", "Send to chart"];

async function renderDetail(c: UnifiedCall = call()) {
  apiMock.getUnifiedCall.mockResolvedValue(c);
  apiMock.searchPatientByPhone.mockResolvedValue(null);
  apiMock.getOpenDentalPatient.mockRejectedValue(new Error("no OD in tests"));
  render(React.createElement(CallDetail));
  // Wait on the header action row rather than on anything role- or state-specific:
  // it renders for every role and for a sent call as well as an unsent one.
  await waitFor(() => expect(screen.getByTestId("call-header-actions")).toBeTruthy());
}

beforeEach(() => {
  authState.role = "office";
  authState.permissions = [];
  authState.isSuperAdmin = false;
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

describe("chart-write buttons follow voice.chart_write", () => {
  it("office: all three sends are offered", async () => {
    authState.role = "office";
    authState.permissions = ["voice.read", "voice.write", "voice.chart_write", "voice.send_to_tc"];
    await renderDetail();

    for (const label of CHART_ACTIONS) {
      expect(screen.getByText(label), `${label} should render for office`).toBeTruthy();
    }
  });

  it("admin: all three sends are offered", async () => {
    authState.role = "admin";
    authState.permissions = [
      "admin.all", "voice.read", "voice.write", "voice.chart_write", "voice.send_to_tc",
    ];
    await renderDetail();

    for (const label of CHART_ACTIONS) {
      expect(screen.getByText(label), `${label} should render for admin`).toBeTruthy();
    }
  });

  it("tc: NONE of them render — the server would only 403", async () => {
    authState.role = "tc";
    authState.permissions = ["voice.read", "tc.full", "tc.hygiene"];
    await renderDetail();

    for (const label of CHART_ACTIONS) {
      expect(screen.queryByText(label), `${label} must not render for tc`).toBeNull();
    }
  });

  it("tc still sees WHO the call was matched to, and that it is unsent", async () => {
    authState.role = "tc";
    authState.permissions = ["voice.read", "tc.full"];
    await renderDetail();

    // The match is a fact, not an action — losing it would make the page less
    // honest, not more secure.
    expect(screen.getByText(/Matched: Test, MangoTest/)).toBeTruthy();
    expect(screen.getByText(/Auto-matched/)).toBeTruthy();
    // And the rest of the page is intact.
    expect(screen.getByText("AI Analysis")).toBeTruthy();
    expect(screen.getByText("Transcript")).toBeTruthy();
  });

  it("a super_admin whose tenant role lacks the action still sends", async () => {
    authState.role = "tc";
    authState.permissions = [];
    authState.isSuperAdmin = true;
    await renderDetail();

    for (const label of CHART_ACTIONS) {
      expect(screen.getByText(label), `${label} should render for a super_admin`).toBeTruthy();
    }
  });

  it("an already-sent call offers nothing to anyone — that gate is unchanged", async () => {
    authState.role = "office";
    authState.permissions = ["voice.read", "voice.write", "voice.chart_write"];
    await renderDetail(call({ od_sync_status: "synced" }));

    for (const label of CHART_ACTIONS) {
      expect(screen.queryByText(label), `${label} must not render for a synced call`).toBeNull();
    }
    expect(screen.getByText(/Sent to chart/)).toBeTruthy();
  });
});
