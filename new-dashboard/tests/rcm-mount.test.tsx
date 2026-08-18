/**
 * RCM module mount — client side (Slice 3).
 *
 * What this pins:
 *  - the hub tile renders IFF 'rcm' is in the /auth/me modules array, and
 *    clicking it lands on /rcm;
 *  - /rcm renders the RCM sidebar nav, not Voice's (the route wins over the
 *    remembered module selection);
 *  - the landing page shows the summary numbers, including honest zeros;
 *  - a MODULE_NOT_ENTITLED response is reported as itself, not as a generic
 *    error — the tile is a convenience, the 403 is the truth.
 *  - the office scope resolver only ever yields concrete RCM office ids.
 *
 * UI hiding is convenience throughout. The backend requireModule('rcm') 403 is
 * the source of truth and is tested in backend/routes/rcm/rcmGuard.test.js.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Classic JSX runtime under vitest — same shim the other .tsx suites use.
(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const authState = vi.hoisted(() => ({
  modules: ["voice", "rcm"] as string[],
  permissions: [
    "admin.all",
    "rcm.read",
    "rcm.write",
    "tc.full",
    "tc.hygiene",
    "voice.chart_write",
    "voice.read",
    "voice.send_to_tc",
    "voice.sync",
    "voice.transcribe",
    "voice.write",
  ] as string[],
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Beau Sparkman",
      email: "beau@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: authState.modules },
      role: "admin" as const,
      isSuperAdmin: false,
      permissions: authState.permissions,
    })),
  };
});

// The office roster comes from lib/api; everything else on `api` hangs so pages
// mount into their loading states without touching the network.
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [
      { officeId: "roland", officeName: "Roland Family Dental" },
      { officeId: "valley", officeName: "Valley Family Dental" },
    ],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

const rcmState = vi.hoisted(() => ({
  summary: null as unknown,
  error: null as Error | null,
}));

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getRcmSummary: vi.fn(async (office: string) => {
      if (rcmState.error) throw rcmState.error;
      return {
        office,
        claims: {
          byStatus: { posted: 0, pending_review: 0, processing: 0, error: 0, matched: 0 },
          total: 0,
        },
        batches: {
          byStatus: { open: 0, ready: 0, posting: 0, balanced: 0, unbalanced: 0, posted: 0, error: 0 },
          total: 0,
        },
        queue: {
          byStatus: { approved: 0, posting: 0, posted: 0, failed: 0, partially_posted: 0 },
          total: 0,
          depth: 0,
        },
        ...((rcmState.summary as object) ?? {}),
      };
    }),
  };
});

import Home from "@/pages/Home";
import { Router as AppRouter } from "@/App";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MODULES } from "@/lib/modules";
import { ACTIONS, requiredActionFor } from "@/lib/permissions";
import { RcmApiError, isRcmOfficeId } from "@/features/rcm/api";
import { resolveRcmOfficeScope } from "@/features/rcm/officeScope";

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
  authState.modules = ["voice", "rcm"];
  rcmState.summary = null;
  rcmState.error = null;
});

afterEach(() => {
  cleanup();
});

describe("RCM registry + permissions", () => {
  it("registers rcm with the /rcm base path", () => {
    expect(MODULES.rcm).toBeTruthy();
    expect(MODULES.rcm?.basePath).toBe("/rcm");
  });

  it("declares the rcm actions and gates /rcm on rcm.read", () => {
    expect(ACTIONS).toContain("rcm.read");
    expect(ACTIONS).toContain("rcm.write");
    expect(requiredActionFor("/rcm")).toBe("rcm.read");
  });
});

describe("RCM hub tile", () => {
  it("renders the tile when the tenant is entitled to rcm", async () => {
    renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("module-tile-rcm")).toBeTruthy();
    });
    expect(screen.getByText("RCM")).toBeTruthy();
  });

  it("renders NO tile when the tenant is not entitled to rcm", async () => {
    authState.modules = ["voice", "tc"];
    renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("module-tile-voice")).toBeTruthy();
    });
    expect(screen.queryByTestId("module-tile-rcm")).toBeNull();
  });

  it("tile click remembers the module and navigates to /rcm", async () => {
    const memory = renderWithProviders(<Home />, "/home");
    await waitFor(() => {
      expect(screen.getByTestId("module-tile-rcm")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("module-tile-rcm"));
    expect(memory.history.at(-1)).toBe("/rcm");
    expect(localStorage.getItem("carein.module")).toBe("rcm");
  });
});

describe("RCM landing page", () => {
  it("renders a summary card per office with the server's numbers", async () => {
    renderWithProviders(<AppRouter />, "/rcm");
    await waitFor(() => {
      expect(screen.getByTestId("rcm-summary-roland")).toBeTruthy();
    });
    expect(screen.getByTestId("rcm-summary-valley")).toBeTruthy();
    // Zeros are a real answer for a freshly-entitled practice, and must render
    // as 0 rather than as the not-yet-measured em dash.
    await waitFor(() => {
      expect(screen.getByTestId("rcm-claims-total-roland").textContent).toBe("0");
    });
    expect(screen.getByTestId("rcm-queue-depth-roland").textContent).toBe("0");
  });

  it("renders non-zero counts as given", async () => {
    rcmState.summary = {
      claims: {
        byStatus: { posted: 7, pending_review: 3, processing: 0, error: 0, matched: 0 },
        total: 10,
      },
      queue: {
        byStatus: { approved: 4, posting: 0, posted: 9, failed: 1, partially_posted: 0 },
        total: 14,
        depth: 4,
      },
    };
    renderWithProviders(<AppRouter />, "/rcm");
    await waitFor(() => {
      expect(screen.getByTestId("rcm-claims-total-roland").textContent).toBe("10");
    });
    expect(screen.getByTestId("rcm-queue-depth-roland").textContent).toBe("4");
    expect(screen.getByTestId("rcm-pending-roland").textContent).toContain("3 claims pending review");
  });

  it("reports MODULE_NOT_ENTITLED as itself, not as a generic failure", async () => {
    rcmState.error = new RcmApiError("MODULE_NOT_ENTITLED", 403, "MODULE_NOT_ENTITLED");
    renderWithProviders(<AppRouter />, "/rcm");
    await waitFor(() => {
      expect(screen.getByTestId("rcm-summary-error-roland")).toBeTruthy();
    });
    expect(screen.getByTestId("rcm-summary-error-roland").textContent).toContain(
      "not set up for the RCM module",
    );
  });

  it("shows the RCM sidebar on /rcm even when Voice is the remembered module", async () => {
    localStorage.setItem("carein.module", "voice");
    renderWithProviders(<AppRouter />, "/rcm");
    // "Overview" is the RCM nav item; "Revenue Cycle" is deliberately not used
    // as the probe because the nav GROUP and the page heading share that text.
    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeTruthy();
    });
    // The Voice nav must not be showing — the ROUTE decides the sidebar.
    expect(screen.queryByText("Agent Builder")).toBeNull();
    expect(screen.queryByText("Callbacks")).toBeNull();
  });
});

describe("RCM office scope", () => {
  const roster = [
    { officeId: "roland" },
    { officeId: "valley" },
    // A roster office that is not an RCM office must be skipped, not queried
    // and 400'd by requireOffice.
    { officeId: "unknown" },
  ];

  it("fans out over every RCM office on the all-offices selection", () => {
    const scope = resolveRcmOfficeScope({ selection: "all", roster });
    expect(scope.offices).toEqual(["roland", "valley"]);
    expect(scope.isAllOffices).toBe(true);
  });

  it("narrows to exactly the selected office", () => {
    expect(resolveRcmOfficeScope({ selection: "valley", roster }).offices).toEqual(["valley"]);
  });

  it("yields nothing for a non-RCM selection rather than a bad request", () => {
    expect(resolveRcmOfficeScope({ selection: "unknown", roster }).offices).toEqual([]);
  });

  it("keeps a failed roster distinguishable from an empty one", () => {
    const failed = resolveRcmOfficeScope({ selection: "all", roster: [], error: "boom" });
    expect(failed.offices).toEqual([]);
    expect(failed.error).toBe("boom");

    const empty = resolveRcmOfficeScope({ selection: "all", roster: [] });
    expect(empty.offices).toEqual([]);
    expect(empty.error).toBeNull();
  });

  it("only recognizes the frozen office keys", () => {
    expect(isRcmOfficeId("roland")).toBe(true);
    expect(isRcmOfficeId("valley")).toBe(true);
    expect(isRcmOfficeId("all")).toBe(false);
    expect(isRcmOfficeId("ROLAND")).toBe(false);
  });
});
