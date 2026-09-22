/**
 * The patient card on the call-detail page shows WHEN the call came in.
 *
 * Whoever is looking at this card is about to call someone back, and "which call
 * was this?" is the first thing they need. The stamp is rendered in the
 * PRACTICE'S zone, not the viewer's: a laptop whose clock zone drifted — or a
 * manager working from another state — would otherwise read a time back to a
 * patient that never happened. That is the same failure the voice agent hit when
 * it told a 7:57 AM caller the office had been closed "since after five".
 *
 * Both variants of the card carry it:
 *   - PatientFoundView   — a matched Open Dental patient
 *   - PatientNoMatchView — an unmatched caller
 *
 * Display only. Nothing here adds a field to the call record; `call_date` is
 * already a core field on the stored call.
 *
 * No PHI: every name and number below is synthetic, and the PatNum is the
 * documented Roland test fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

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

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice"] },
      role: "office",
      isSuperAdmin: false,
      permissions: ["voice.read", "voice.write", "voice.chart_write"],
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
  getUnifiedCall: vi.fn(),
  getOpenDentalPatient: vi.fn(),
  searchPatientByPhone: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { normalizeUnifiedCall, type BackendUnifiedCall, type OdPatient, type UnifiedCall } from "@/lib/api";
import CallDetail from "@/pages/CallDetail";

/**
 * 12:57 UTC on 2026-09-22 is 7:57 AM in Roland (CDT, UTC-5) — the morning call
 * the voice agent got wrong, reused here because it is a time whose office-local
 * value differs from both UTC and Pacific.
 */
const MORNING_UTC = "2026-09-22T12:57:00.000Z";
const MORNING_LOCAL = "Sep 22, 2026 · 7:57 AM";

const backendCall = (over: Partial<BackendUnifiedCall> = {}): BackendUnifiedCall => ({
  id: "c1",
  source: "mango",
  office_id: "roland",
  caller_name: "Synthetic Caller",
  caller_number: "+15550000000",
  called_number: "+15551111111",
  call_date: MORNING_UTC,
  duration_seconds: 214,
  summary: "Caller asked about a cleaning.",
  od_sync_status: "none",
  has_transcript: false,
  ...over,
} as unknown as BackendUnifiedCall);

const call = (over: Partial<BackendUnifiedCall> = {}): UnifiedCall =>
  normalizeUnifiedCall(backendCall(over));

/** A synthetic patient on the documented Roland fixture PatNum. */
const patient: OdPatient = {
  id: 12828,
  firstName: "MangoTest",
  lastName: "Test",
  preferredName: "",
  fullName: "Test, MangoTest",
  dateOfBirth: "1980-04-02",
  phone: "+15550000000",
  email: "",
  address: { street: "", city: "", state: "", zip: "" },
  insurance: { primary: "", secondary: "" },
  lastVisit: "2026-03-11",
  balance: 0,
  isActive: true,
};

async function renderDetail(c: UnifiedCall, matched: boolean) {
  apiMock.getUnifiedCall.mockResolvedValue(c);
  if (matched) {
    apiMock.getOpenDentalPatient.mockResolvedValue(patient);
    apiMock.searchPatientByPhone.mockResolvedValue(patient);
  } else {
    apiMock.getOpenDentalPatient.mockRejectedValue(new Error("no OD in tests"));
    apiMock.searchPatientByPhone.mockResolvedValue(null);
  }
  render(React.createElement(CallDetail));
  await waitFor(() => expect(screen.getByTestId("call-header-actions")).toBeTruthy());
}

/**
 * Assertions are scoped to the Patient Record card on purpose. The "Call Details"
 * card lower down the page renders its own unguarded `Date` row in the VIEWER's
 * zone, so a page-wide query would be answered by a different component.
 */
function patientCard(): HTMLElement {
  const title = screen.getByText("Patient Record");
  const card = title.closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error("Patient Record card not found");
  return card;
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

describe("the patient card shows when the call came in", () => {
  it("matched patient: the stamp renders in office time", async () => {
    await renderDetail(call({ od_sync_status: "matched", od_patient_id: 12828, od_patient_name: "Test, MangoTest" } as Partial<BackendUnifiedCall>), true);

    await waitFor(() => expect(screen.getByText("Test, MangoTest")).toBeTruthy());
    expect(within(patientCard()).getByText(MORNING_LOCAL)).toBeTruthy();
  });

  it("unmatched caller: the stamp renders there too", async () => {
    await renderDetail(call(), false);

    await waitFor(() => expect(screen.getByText("No matching Open Dental patient found")).toBeTruthy());
    expect(within(patientCard()).getByText(MORNING_LOCAL)).toBeTruthy();
  });

  it("office time, not UTC and not the viewer's zone", async () => {
    // 02:30 UTC on the 23rd is still the evening of the 22nd in Roland. Printing
    // the UTC day here would put the call on the wrong date in the chart note.
    await renderDetail(call({ call_date: "2026-09-23T02:30:00.000Z" }), false);

    await waitFor(() => expect(screen.getByText("No matching Open Dental patient found")).toBeTruthy());
    const card = within(patientCard());
    expect(card.getByText("Sep 22, 2026 · 9:30 PM")).toBeTruthy();
    expect(card.queryByText(/Sep 23, 2026/)).toBeNull();
  });

  it("an unparseable timestamp omits the line rather than printing Invalid Date", async () => {
    await renderDetail(call({ call_date: "not-a-date" }), false);

    await waitFor(() => expect(screen.getByText("No matching Open Dental patient found")).toBeTruthy());
    const card = within(patientCard());
    expect(card.queryByText(/Invalid Date/)).toBeNull();
    expect(card.queryByText(/NaN/)).toBeNull();
    // The caller block is still intact — only the stamp is gone.
    expect(card.getByText("Synthetic Caller")).toBeTruthy();
  });
});
