/**
 * The TC nav's "Texts" item and its unseen count (queue item 39), on the REAL
 * DashboardLayout against a faked /auth/me and a faked office roster.
 *
 *   - The count is the server's, summed over the offices in scope.
 *   - It is asked for on the probe's existing tick (no second interval), plus
 *     once when the TC nav appears — and never twice for one scope at mount.
 *   - Unknown (a failed fetch) shows no badge, never a made-up zero.
 *   - A role without tc.full gets neither the item nor the request.
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

describe("TC nav: Texts + unseen count", () => {
  it("shows the server's count on the Texts item, asked ONCE at mount for the office in scope", async () => {
    state.getUnseenTotal.mockResolvedValue({ count: 3, capped: false });
    renderShell("/tc");
    const badge = await screen.findByTestId("tc-texts-unseen");
    expect(badge.textContent).toBe("3");
    expect(badge.closest("a")?.getAttribute("href")).toBe("/tc/texts");
    expect(state.getUnseenTotal).toHaveBeenCalledTimes(1);
    expect(state.getUnseenTotal).toHaveBeenCalledWith(["roland"]);
  });

  it("All Offices sums every TC office in the roster; 99+ past the cap", async () => {
    state.office = "all";
    state.getUnseenTotal.mockResolvedValue({ count: 100, capped: true });
    renderShell("/tc");
    expect((await screen.findByTestId("tc-texts-unseen")).textContent).toBe("99+");
    expect(state.getUnseenTotal).toHaveBeenCalledWith(["roland", "valley"]);
  });

  it("a zero count shows no badge; a FAILED count shows no badge either", async () => {
    state.getUnseenTotal.mockResolvedValue({ count: 0, capped: false });
    renderShell("/tc");
    await screen.findByText("Texts");
    await waitFor(() => expect(state.getUnseenTotal).toHaveBeenCalled());
    expect(screen.queryByTestId("tc-texts-unseen")).toBeNull();
    cleanup();

    state.getUnseenTotal.mockReset().mockRejectedValue(new Error("403"));
    renderShell("/tc");
    await screen.findByText("Texts");
    await waitFor(() => expect(state.getUnseenTotal).toHaveBeenCalled());
    expect(screen.queryByTestId("tc-texts-unseen")).toBeNull();
  });

  it("off the TC nav, nothing is asked", async () => {
    renderShell("/dashboard");
    await screen.findByRole("navigation");
    expect(state.getUnseenTotal).not.toHaveBeenCalled();
  });

  it("a hygienist (no tc.full) gets neither the item nor the request", async () => {
    state.permissions = ["tc.hygiene"];
    renderShell("/tc/hygiene/inbox");
    await screen.findByText("TC Inbox");
    expect(screen.queryByText("Texts")).toBeNull();
    expect(state.getUnseenTotal).not.toHaveBeenCalled();
  });
});
