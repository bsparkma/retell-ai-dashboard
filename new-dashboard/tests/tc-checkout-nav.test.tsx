/**
 * The TC nav's "Checkout" item and its waiting badge (queue item 50), on the
 * REAL DashboardLayout — the same harness as tc-texts-nav.test.tsx.
 *
 *   - Checkout ships dark: no office on ⇒ no nav item at all.
 *   - On ⇒ the item appears with the server's waiting count.
 *   - A role without tc.full is never asked.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  permissions: [] as string[],
  office: "roland",
  getUnseenTotal: vi.fn(),
  getCheckoutSummary: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "Test User",
      email: "tc@carein.ai",
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN Dental LLC", modules: ["voice", "tc"] },
      role: "tc",
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
    office: state.office,
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

import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";
import RequireAuth from "@/components/RequireAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { ACTIONS } from "@/lib/permissions";

beforeEach(() => {
  state.permissions = [...ACTIONS];
  state.office = "roland";
  state.getUnseenTotal.mockReset();
  state.getUnseenTotal.mockResolvedValue({ count: 0, capped: false });
  state.getCheckoutSummary.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

/** The nav link labels currently rendered in the sidebar. */
async function navLabels(): Promise<string[]> {
  const nav = await screen.findByRole("navigation");
  return Array.from(nav.querySelectorAll("a")).map((a) => (a.textContent ?? "").trim()).filter(Boolean);
}

const summary = (over: Record<string, unknown> = {}) => ({
  success: true,
  office: "roland",
  enabled: true,
  today: "2026-09-08",
  waiting: 0,
  newest: null,
  ...over,
});

describe("TC nav: Checkout + waiting badge", () => {
  it("switched off for the office: no Checkout item at all", async () => {
    state.getCheckoutSummary.mockResolvedValue(summary({ enabled: false, today: null }));
    renderShell("/tc");
    await waitFor(() => expect(state.getCheckoutSummary).toHaveBeenCalledWith("roland"));
    expect((await navLabels()).some((l) => l.startsWith("Checkout"))).toBe(false);
  });

  it("on: the item appears with the server's waiting count", async () => {
    state.getCheckoutSummary.mockResolvedValue(summary({ waiting: 3 }));
    renderShell("/tc");
    const badge = await screen.findByTestId("tc-checkout-waiting");
    expect(badge.textContent).toBe("3");
    expect(badge.closest("a")?.getAttribute("href")).toBe("/tc/checkout");
  });

  it("on with nobody waiting: the item, no badge", async () => {
    state.getCheckoutSummary.mockResolvedValue(summary({ waiting: 0 }));
    renderShell("/tc");
    await waitFor(async () => expect(await navLabels()).toContain("Checkout"));
    expect(screen.queryByTestId("tc-checkout-waiting")).toBeNull();
  });

  it("a role without tc.full is never asked", async () => {
    state.permissions = ["tc.hygiene"];
    renderShell("/tc/hygiene/inbox");
    await screen.findByRole("navigation");
    expect(state.getCheckoutSummary).not.toHaveBeenCalled();
  });
});
