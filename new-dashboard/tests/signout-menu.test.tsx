/**
 * Sign-out UI tests (jsdom via the .tsx glob).
 *
 * The SPA's two account menus — the sidebar footer user chip
 * (DashboardLayout) and the /home hub header practice-name area — each open
 * into a menu showing the signed-in email and a "Sign out" action that calls
 * lib/auth logout(). A third suite checks the real logout() POSTs
 * /auth/logout with credentials.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Classic-runtime JSX global for vitest (see tests/module-home.test.tsx).
(globalThis as Record<string, unknown>).React = React;

const logoutSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Beau Sparkman",
      email: "beau@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: ["voice", "tc"] },
    })),
    logout: logoutSpy,
  };
});

// Every api.* method returns a never-settling promise — components mount into
// loading states with no network and no post-test setState.
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: new Proxy({}, { get: () => () => new Promise(() => {}) }),
  };
});

import Home from "@/pages/Home";
import DashboardLayout from "@/components/DashboardLayout";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderWithProviders(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <ModuleProvider>
              <OfficeProvider>{ui}</OfficeProvider>
            </ModuleProvider>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

beforeEach(() => {
  localStorage.clear();
  logoutSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("/home header account menu", () => {
  it("opens on the practice-name chip, shows the signed-in email, and signs out", async () => {
    renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("home-user-chip")).toBeTruthy();
    });
    // Closed by default.
    expect(screen.queryByTestId("home-user-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("home-user-chip"));
    await waitFor(() => {
      expect(screen.getByTestId("home-user-email").textContent).toBe("beau@carein.ai");
    });

    fireEvent.click(screen.getByTestId("home-signout"));
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe("sidebar footer account menu", () => {
  it("opens on the user chip, shows the signed-in email, and signs out", async () => {
    renderWithProviders(
      <DashboardLayout>
        <div>page content</div>
      </DashboardLayout>,
      "/dashboard",
    );
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-user-chip")).toBeTruthy();
    });
    expect(screen.queryByTestId("sidebar-user-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-user-chip"));
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-user-email").textContent).toBe("beau@carein.ai");
    });

    fireEvent.click(screen.getByTestId("sidebar-signout"));
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe("logout()", () => {
  it("POSTs /auth/logout with credentials", async () => {
    // The module mock above replaces logout — reach past it for the real one.
    const real = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await real.logout();
    } catch {
      // jsdom can't navigate (window.location.href assignment) — irrelevant here.
    }
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/logout$/),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    fetchSpy.mockRestore();
  });
});
