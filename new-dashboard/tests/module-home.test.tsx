/**
 * Module-home hub tests (jsdom via the .tsx glob).
 *
 * Two suites:
 *  - Home tile rendering, driven purely by the /auth/me modules array crossed
 *    with the client registry (1 module → 1 tile, unknown ids ignored,
 *    entitled-but-unregistered renders nothing, tile click remembers the
 *    module and navigates to its basePath).
 *  - App routing: "/" always redirects to /home (post-login lands on the SPA
 *    origin, so this IS the post-login → hub behavior), while deep links to
 *    module pages ("/tc", "/calls") never bounce through /home.
 *
 * Network-facing modules are mocked with never-settling promises so pages
 * mount into their loading states without touching the network.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Vitest compiles .tsx with esbuild's classic JSX transform (tsconfig has
// jsx: "preserve"), while the app's Vite build uses the automatic runtime —
// so component modules never import React. Provide the classic-runtime global
// so their JSX renders under vitest.
(globalThis as Record<string, unknown>).React = React;

// jsdom has no ResizeObserver; recharts (Dashboard page) needs one to mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

/** Per-test control of the modules list the fake /auth/me returns. */
const authState = vi.hoisted(() => ({ modules: ["voice", "tc"] as string[] }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Beau Sparkman",
      email: "beau@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: authState.modules },
      // Roles PR B: an admin, so the role-scoped nav/redirects behave as they
      // did before roles existed and these routing assertions stay about
      // ROUTING rather than about permissions.
      role: "admin" as const,
      isSuperAdmin: false,
      permissions: [
        "admin.all",
        "tc.full",
        "tc.hygiene",
        "voice.chart_write",
        "voice.read",
        "voice.send_to_tc",
        "voice.sync",
        "voice.transcribe",
        "voice.write",
      ],
    })),
  };
});

// Every api.* method returns a promise that never settles — pages render
// their loading states and no network or post-test setState ever happens.
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: new Proxy({}, { get: () => () => new Promise(() => {}) }),
  };
});

// Same treatment for the TC api module (function exports only).
vi.mock("@/features/tc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/api")>();
  const pending = () => new Promise(() => {});
  return Object.fromEntries(
    Object.entries(real).map(([key, value]) => [
      key,
      typeof value === "function" ? pending : value,
    ]),
  );
});

import Home from "@/pages/Home";
import { Router as AppRouter } from "@/App";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderWithProviders(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <ModuleProvider>
              <OfficeProvider>
                <SlotMarkersProvider>{ui}</SlotMarkersProvider>
              </OfficeProvider>
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
  authState.modules = ["voice", "tc"];
});

afterEach(() => {
  cleanup();
});

describe("Home module tiles", () => {
  it("renders one tile per entitled+registered module (2 modules → 2 tiles)", async () => {
    renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("module-tile-voice")).toBeTruthy();
    });
    expect(screen.getByTestId("module-tile-tc")).toBeTruthy();
    expect(screen.getByTestId("module-tiles").children).toHaveLength(2);
    expect(screen.getByText("Voice")).toBeTruthy();
    expect(screen.getByText("Treatment Coordinator")).toBeTruthy();
  });

  it("renders a single tile when only one module is entitled (no hiding at 1)", async () => {
    authState.modules = ["voice"];
    renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("module-tile-voice")).toBeTruthy();
    });
    expect(screen.queryByTestId("module-tile-tc")).toBeNull();
    expect(screen.getByTestId("module-tiles").children).toHaveLength(1);
  });

  it("ignores unknown module ids from /auth/me gracefully", async () => {
    authState.modules = ["voice", "hologram"];
    renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("module-tile-voice")).toBeTruthy();
    });
    expect(screen.getByTestId("module-tiles").children).toHaveLength(1);
  });

  it("renders no tile for an entitled module with no registry entry yet", async () => {
    authState.modules = ["rcm"];
    renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByText(/No modules are enabled/)).toBeTruthy();
    });
    expect(screen.queryByTestId("module-tiles")).toBeNull();
  });

  it("tile click remembers the module and navigates to its home route", async () => {
    const memory = renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("module-tile-tc")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("module-tile-tc"));
    expect(memory.history.at(-1)).toBe("/tc");
    expect(localStorage.getItem("carein.module")).toBe("tc");
  });
});

describe("App routing: hub-first landing", () => {
  it("redirects the root route to /home (post-login landing)", async () => {
    const memory = renderWithProviders(<AppRouter />, "/");
    await waitFor(() => {
      expect(memory.history.at(-1)).toBe("/home");
    });
    await waitFor(() => {
      expect(screen.getByText(/Choose where you want to work/)).toBeTruthy();
    });
  });

  it("leaves a /tc deep link alone (no bounce through /home)", async () => {
    const memory = renderWithProviders(<AppRouter />, "/tc");
    // Give effects a tick to fire any (wrong) redirect before asserting.
    await waitFor(() => {
      expect(memory.history.at(-1)).toBe("/tc");
    });
    expect(memory.history).not.toContain("/home");
  });

  it("leaves a Voice deep link alone (no bounce through /home)", async () => {
    const memory = renderWithProviders(<AppRouter />, "/calls");
    await waitFor(() => {
      expect(memory.history.at(-1)).toBe("/calls");
    });
    expect(memory.history).not.toContain("/home");
  });

  it("serves the Voice dashboard at /dashboard (module home route)", async () => {
    const memory = renderWithProviders(<AppRouter />, "/dashboard");
    await waitFor(() => {
      expect(memory.history.at(-1)).toBe("/dashboard");
    });
    expect(memory.history).not.toContain("/home");
  });
});
