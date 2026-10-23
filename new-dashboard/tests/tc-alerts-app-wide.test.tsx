/**
 * Pre-IA fix F4 (docs/reports/feature-tc-incoming-work-ia.md §4 D3, §7;
 * RATIFIED by Beau): the Checkout and sign-off watches run app-wide for
 * permitted users, not only on /tc routes — on the REAL DashboardLayout.
 *
 *   - front desk on Calls gets the "headed to checkout" alert;
 *   - a doctor on Home gets the sign-off alert;
 *   - the person's notification preference is still obeyed (silent = no toast);
 *   - nobody new is polled: no permission or no TC module ⇒ never asked;
 *   - no new alert types: the Texts badge stays TC-only.
 *
 * No PHI: patient names are synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const state = vi.hoisted(() => ({
  role: "office",
  permissions: [] as string[],
  modules: ["voice", "tc"] as string[],
  getUnseenTotal: vi.fn(),
  getCheckoutSummary: vi.fn(),
  getSignoffSummary: vi.fn(),
  getNotificationPrefs: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(state.toast, { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  Toaster: () => null,
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "Test User",
      email: "frontdesk@carein.ai",
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN Dental LLC", modules: state.modules },
      role: state.role,
      isSuperAdmin: false,
      permissions: state.permissions,
    })),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: { ...real.api, getHealth: vi.fn(() => new Promise(() => {})), getAdminHealth: vi.fn(() => new Promise(() => {})) },
  };
});

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  OfficeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useOffice: () => ({
    offices: [
      { officeId: "roland", officeName: "Roland" },
      { officeId: "valley", officeName: "Valley Fort Smith" },
    ],
    office: "roland",
    setOffice: () => {},
    selected: null,
    loading: false,
    error: null,
    reload: () => {},
  }),
}));

vi.mock("@/features/tc/messaging/messagingApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/features/tc/messaging/messagingApi")>();
  return { ...real, getUnseenTotal: state.getUnseenTotal };
});
vi.mock("@/features/tc/checkout/checkoutApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/features/tc/checkout/checkoutApi")>();
  return { ...real, getCheckoutSummary: state.getCheckoutSummary };
});
vi.mock("@/features/tc/referrals/referralsApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/features/tc/referrals/referralsApi")>();
  return { ...real, getSignoffSummary: state.getSignoffSummary };
});
vi.mock("@/features/tc/notifications/notificationsApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../client/src/features/tc/notifications/notificationsApi")>();
  return { ...real, getNotificationPrefs: state.getNotificationPrefs };
});

import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";
import RequireAuth from "@/components/RequireAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { ACTIONS } from "@/lib/permissions";

function renderShell(path: string) {
  const { hook } = memoryLocation({ path, static: true });
  return render(
    <WouterRouter hook={hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <RequireAuth>
              <ModuleProvider>
                <SlotMarkersProvider>
                  <DashboardLayout>
                    <div>page</div>
                  </DashboardLayout>
                </SlotMarkersProvider>
              </ModuleProvider>
            </RequireAuth>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

/** The polling hook re-runs its callback when the tab becomes visible: the next tick, on demand. */
async function nextTick() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const checkoutSummary = (newest: { handoffId: string; patientName: string; createdAt: string } | null, waiting = 0) => ({
  success: true,
  office: "roland",
  enabled: true,
  today: "2026-10-22",
  waiting,
  newest,
});

const signoffSummary = (newest: { referralId: string; patientName: string; at: string } | null, waiting = 0) => ({
  enabled: true,
  waiting,
  newest,
});

function prefs(event: "checkout_handoff" | "referral_signoff", level: "silent" | "banner" | "sound_banner") {
  return { success: true, office: "roland", events: [{ event, level, source: "user" }] };
}

beforeEach(() => {
  state.role = "office";
  state.permissions = [...ACTIONS].filter((a) => a !== "tc.referral_signoff");
  state.modules = ["voice", "tc"];
  state.getUnseenTotal.mockReset();
  state.getUnseenTotal.mockResolvedValue({ count: 0, capped: false });
  state.getCheckoutSummary.mockReset();
  state.getCheckoutSummary.mockResolvedValue(checkoutSummary(null));
  state.getSignoffSummary.mockReset();
  state.getSignoffSummary.mockResolvedValue(signoffSummary(null));
  state.getNotificationPrefs.mockReset();
  state.getNotificationPrefs.mockResolvedValue(prefs("checkout_handoff", "banner"));
  state.toast.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("F4: checkout alerts reach front desk anywhere in the app", () => {
  it("on Calls, a new arrival toasts '<patient> is headed to checkout'", async () => {
    renderShell("/calls");
    await waitFor(() => expect(state.getCheckoutSummary).toHaveBeenCalledWith("roland"));
    // First answer only records the backlog; the next tick sees a newer arrival.
    state.getCheckoutSummary.mockResolvedValue(
      checkoutSummary({ handoffId: "h-1", patientName: "Pat Example", createdAt: "2026-10-22T15:00:00.000Z" }, 1),
    );
    await nextTick();
    await waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith("Pat Example is headed to checkout", expect.anything()),
    );
  });

  it("the checkout_handoff preference is still obeyed off TC: silent means no toast", async () => {
    state.getNotificationPrefs.mockResolvedValue(prefs("checkout_handoff", "silent"));
    renderShell("/home");
    await waitFor(() => expect(state.getCheckoutSummary).toHaveBeenCalled());
    state.getCheckoutSummary.mockResolvedValue(
      checkoutSummary({ handoffId: "h-2", patientName: "Pat Example", createdAt: "2026-10-22T15:05:00.000Z" }, 1),
    );
    await nextTick();
    await waitFor(() => expect(state.getCheckoutSummary.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(state.getNotificationPrefs.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("a voice-only practice is never asked, even for someone holding tc.full", async () => {
    state.modules = ["voice"];
    renderShell("/calls");
    await screen.findByRole("navigation");
    await nextTick();
    expect(state.getCheckoutSummary).not.toHaveBeenCalled();
    expect(state.getSignoffSummary).not.toHaveBeenCalled();
  });

  it("a hygienist (no tc.full, no sign-off) is never asked, on the hygiene day view", async () => {
    state.role = "hygiene";
    state.permissions = ["tc.hygiene", "hyg.read", "hyg.visit"];
    renderShell("/hyg/day");
    await screen.findByRole("navigation");
    await nextTick();
    expect(state.getCheckoutSummary).not.toHaveBeenCalled();
    expect(state.getSignoffSummary).not.toHaveBeenCalled();
  });

  it("no new alert types: the Texts badge is still asked for only on TC pages", async () => {
    renderShell("/calls");
    await waitFor(() => expect(state.getCheckoutSummary).toHaveBeenCalled());
    expect(state.getUnseenTotal).not.toHaveBeenCalled();
  });
});

describe("F4: the sign-off alert reaches the doctor anywhere in the app", () => {
  it("a doctor on Home is alerted when a referral reaches sign-off", async () => {
    state.role = "doctor";
    state.permissions = ["tc.referral_signoff"];
    renderShell("/home");
    await waitFor(() => expect(state.getSignoffSummary).toHaveBeenCalledWith("roland"));
    state.getSignoffSummary.mockResolvedValue(
      signoffSummary({ referralId: "r-1", patientName: "Pat Example", at: "2026-10-22T15:10:00.000Z" }, 1),
    );
    await nextTick();
    await waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith("Pat Example's referral is waiting for your sign-off", expect.anything()),
    );
    // A doctor holds no tc.full: the checkout watch never runs for them, and
    // their preference read is skipped (the built-in banner applies).
    expect(state.getCheckoutSummary).not.toHaveBeenCalled();
    expect(state.getNotificationPrefs).not.toHaveBeenCalled();
  });
});
