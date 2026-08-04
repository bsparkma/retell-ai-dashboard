/**
 * TC routing regressions (jsdom via the .tsx glob).
 *
 * Guards the "Back to cases" 404: TcCaseView's back links target the Pipeline
 * ("/tc"), and a bare "/tc/cases" (no id) redirects to "/tc" instead of
 * falling through to NotFound. Uses the same provider/mock harness as
 * tests/module-home.test.tsx.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Classic-runtime JSX global for vitest (see tests/module-home.test.tsx).
(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

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
  };
});

// Never-settling promises: pages mount into loading states, no network.
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: new Proxy({}, { get: () => () => new Promise(() => {}) }),
  };
});

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

import { Router as AppRouter } from "@/App";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderAt(path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <ModuleProvider>
              <OfficeProvider>
                <SlotMarkersProvider>
                  <AppRouter />
                </SlotMarkersProvider>
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
});

afterEach(() => {
  cleanup();
});

describe("TC routing", () => {
  it("redirects a bare /tc/cases to the Pipeline instead of 404ing", async () => {
    const memory = renderAt("/tc/cases");
    await waitFor(() => {
      expect(memory.history.at(-1)).toBe("/tc");
    });
    expect(screen.queryByText(/Page Not Found/)).toBeNull();
  });

  it("still serves case detail at /tc/cases/:id", async () => {
    const memory = renderAt("/tc/cases/case-123");
    // No redirect: the detail route matches and stays put.
    await waitFor(() => {
      expect(memory.history.at(-1)).toBe("/tc/cases/case-123");
    });
    expect(screen.queryByText(/Page Not Found/)).toBeNull();
  });
});
