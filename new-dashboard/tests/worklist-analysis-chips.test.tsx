/**
 * The Insurance and New patient chips can actually match a call.
 *
 * THE PROBLEM: both chips were wired to fields that do not exist on a call record.
 * `insuranceMentioned` read `c.dental_insurance` — an analysis field name the agent
 * stopped emitting, and one that was never stored on a call at all — and `isNewPatient`
 * read `c.is_new_patient`, which is only ever set by a manual PATCH and never derived
 * from the analysis. Both were therefore always false, so filtering by either chip
 * returned nothing, for every call, always. Nothing errored; the list just came back
 * empty and looked like a quiet afternoon.
 *
 * They now read the stored `insurance_name` / `patient_status`, which the call record
 * carries since the analysis fields were persisted.
 *
 * These are the caller's own words, not verified coverage — the chip says the caller
 * named a carrier, nothing more.
 *
 * No PHI: every name and number below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

vi.mock("wouter", () => ({
  useLocation: () => ["/calls", () => {}],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice"] },
      role: "office",
      isSuperAdmin: false,
      permissions: ["voice.read", "voice.write"],
      homeOffice: null,
    },
  }),
}));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "__all__",
  useOffice: () => ({
    office: "roland",
    offices: [{ officeId: "roland", officeName: "Valley Family Dental at Roland", odConnected: true }],
    selected: { officeId: "roland", officeName: "Valley Family Dental at Roland", odConnected: true },
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
  getUnifiedCalls: vi.fn(),
  getSyncStatus: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { normalizeUnifiedCall, type BackendUnifiedCall, type UnifiedCall } from "@/lib/api";
import { CallWorklist } from "@/pages/calls/CallWorklist";

// ─────────────────────────────────────────────────────────────────────────────
// The mapping
// ─────────────────────────────────────────────────────────────────────────────

const backendCall = (over: Partial<BackendUnifiedCall> = {}): BackendUnifiedCall => ({
  id: "c1",
  source: "mango",
  office_id: "roland",
  caller_name: "Synthetic Caller",
  caller_number: "+15550000000",
  called_number: "+15551111111",
  call_date: "2026-09-22T12:57:00.000Z",
  duration_seconds: 90,
  summary: "Caller asked about a cleaning.",
  od_sync_status: "needs_review",
  has_transcript: true,
  ...over,
} as unknown as BackendUnifiedCall);

describe("the analysis fields reach the chip flags", () => {
  it("a named carrier sets insuranceMentioned", () => {
    expect(normalizeUnifiedCall(backendCall({ insurance_name: "Humana" })).insuranceMentioned).toBe(true);
  });

  it("no carrier leaves it false rather than undefined", () => {
    expect(normalizeUnifiedCall(backendCall()).insuranceMentioned).toBe(false);
  });

  it("patient_status 'new_patient' sets isNewPatient", () => {
    expect(normalizeUnifiedCall(backendCall({ patient_status: "new_patient" })).isNewPatient).toBe(true);
  });

  it("an existing patient is not a new one", () => {
    expect(normalizeUnifiedCall(backendCall({ patient_status: "existing_patient" })).isNewPatient).toBe(false);
  });

  it("a manually corrected is_new_patient still counts", () => {
    // The field a human can set by hand keeps working — the analysis is an additional
    // source for the flag, not a replacement for the correction.
    expect(normalizeUnifiedCall(backendCall({ is_new_patient: true })).isNewPatient).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The chips
// ─────────────────────────────────────────────────────────────────────────────

const call = (id: string, over: Partial<BackendUnifiedCall>): UnifiedCall =>
  normalizeUnifiedCall(backendCall({ id, ...over }));

async function renderWorklist(calls: UnifiedCall[]) {
  apiMock.getUnifiedCalls.mockResolvedValue({ calls, mangoWorklistMode: "all" });
  apiMock.getSyncStatus.mockResolvedValue({ lastSyncedAt: null, nextAutoSync: null, mangoMode: "api" });
  render(React.createElement(CallWorklist));
  fireEvent.click(screen.getByText("All calls"));
  await waitFor(() => expect(apiMock.getUnifiedCalls).toHaveBeenCalled());
}

/**
 * The chip BUTTON, not any text that happens to read the same. Chips render as
 * `<button aria-pressed>`, and "Insurance" also appears elsewhere on the page.
 */
function chip(label: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(label) });
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

describe("filtering by the chips returns the matching calls", () => {
  it("Insurance keeps the call whose caller named a carrier", async () => {
    await renderWorklist([
      call("with-ins", { caller_name: "Insured Caller", insurance_name: "Humana" }),
      call("no-ins", { caller_name: "Quiet Caller" }),
    ]);

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(2));
    fireEvent.click(chip("Insurance"));

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    expect(screen.getByText("Insured Caller")).toBeTruthy();
    expect(screen.queryByText("Quiet Caller")).toBeNull();
  });

  it("New patient keeps the call whose caller said they were new", async () => {
    await renderWorklist([
      call("is-new", { caller_name: "First Timer", patient_status: "new_patient" }),
      call("not-new", { caller_name: "Regular Caller", patient_status: "existing_patient" }),
    ]);

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(2));
    fireEvent.click(chip("New patient"));

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    expect(screen.getByText("First Timer")).toBeTruthy();
    expect(screen.queryByText("Regular Caller")).toBeNull();
  });

  it("the regression: a carrier-bearing call is no longer filtered away to nothing", async () => {
    // Before the fix this returned zero rows for every possible call, because the flag
    // was read off a field that never existed.
    await renderWorklist([call("ins-only", { caller_name: "Insured Caller", insurance_name: "Aetna" })]);

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    fireEvent.click(chip("Insurance"));

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
  });
});
