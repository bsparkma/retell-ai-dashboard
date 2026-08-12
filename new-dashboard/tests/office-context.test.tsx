/**
 * OfficeContext + TcOfficeGate, in jsdom.
 *
 * WHY THIS FILE EXISTS. Every hygiene page rendered "No offices configured"
 * because `GET /api/unified-calls/offices` 403'd for the hygiene role: the
 * roster fetch failed, `offices` stayed empty, and the gate could not tell an
 * empty roster from a failed one. It read as a configuration problem for weeks
 * while it was an authorization bug.
 *
 * So the two states are pinned apart here:
 *   - loaded, genuinely empty  → "no offices set up" (a config answer)
 *   - the fetch FAILED         → "couldn't load offices" + Retry (an error)
 *
 * Also pinned: the home office is a DEFAULT, not a restriction. It seeds the
 * selection when nothing is stored, it never overrides a choice the user has
 * already made, and it never removes an office from the picker.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform, while the app's Vite
// build uses the automatic runtime — so component modules never import React.
(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => ({ getOffices: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

const authMock = vi.hoisted(() => ({ homeOffice: null as string | null }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Test User",
      email: "user@carein.ai",
      tenantId: "t",
      tenant: null,
      role: "hygiene",
      isSuperAdmin: false,
      permissions: ["tc.hygiene"],
      homeOffice: authMock.homeOffice,
    },
  }),
}));

import { ALL_OFFICES, OfficeProvider, useOffice } from "@/contexts/OfficeContext";
import { TcOfficeGate } from "@/features/tc/components/TcShell";
import type { OfficeConfig } from "@/lib/api";

const ROLAND: OfficeConfig = { officeId: "roland", officeName: "Roland", odConnected: true };
const VALLEY: OfficeConfig = { officeId: "valley", officeName: "Valley Fort Smith", odConnected: true };

/** Reads the context out into the DOM so assertions can see the selection. */
function OfficeProbe() {
  const { office, offices, error } = useOffice();
  return (
    <div>
      <span data-testid="selected">{office}</span>
      <span data-testid="count">{offices.length}</span>
      <span data-testid="error">{error ?? ""}</span>
    </div>
  );
}

function renderWithProvider(child: React.ReactNode) {
  return render(<OfficeProvider>{child}</OfficeProvider>);
}

beforeEach(() => {
  localStorage.clear();
  authMock.homeOffice = null;
  apiMock.getOffices.mockReset();
});

afterEach(cleanup);

describe("TcOfficeGate tells an empty roster apart from a failed one", () => {
  it("a roster that loaded and is genuinely empty reads as a config answer", async () => {
    apiMock.getOffices.mockResolvedValue([]);
    renderWithProvider(<TcOfficeGate />);

    await waitFor(() => expect(screen.getByText(/no offices set up/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("a roster fetch that FAILED reads as an error, with a retry", async () => {
    apiMock.getOffices.mockRejectedValue(new Error("Forbidden"));
    renderWithProvider(<TcOfficeGate />);

    await waitFor(() => expect(screen.getByText(/couldn.t load/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    // The failure must NOT be dressed up as "this practice has no offices".
    expect(screen.queryByText(/no offices set up/i)).toBeNull();
  });

  it("a loaded roster offers the offices to pick from", async () => {
    apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
    renderWithProvider(<TcOfficeGate />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Roland" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Valley Fort Smith" })).toBeTruthy();
  });
});

describe("home office is a default, never a restriction", () => {
  it("seeds the selection when the browser has no stored choice", async () => {
    authMock.homeOffice = "valley";
    apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
    renderWithProvider(<OfficeProbe />);

    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("valley"));
  });

  it("does NOT override an office the user already picked in this browser", async () => {
    localStorage.setItem("carein.office", "roland");
    authMock.homeOffice = "valley";
    apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
    renderWithProvider(<OfficeProbe />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByTestId("selected").textContent).toBe("roland");
  });

  it("falls back to all-offices when the user has no home office (temp accounts)", async () => {
    authMock.homeOffice = null;
    apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
    renderWithProvider(<OfficeProbe />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByTestId("selected").textContent).toBe(ALL_OFFICES);
  });

  it("ignores a home office the tenant's roster does not contain", async () => {
    // A stale value (an office that was renamed or removed) must not strand the
    // user on a selection no page can resolve.
    authMock.homeOffice = "gone";
    apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
    renderWithProvider(<OfficeProbe />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByTestId("selected").textContent).toBe(ALL_OFFICES);
  });

  it("still exposes every office — a home office narrows nothing", async () => {
    // Beau's explicit decision: staff float between locations, so the home
    // office seeds the selection and the picker keeps offering the other one.
    authMock.homeOffice = "roland";
    apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
    renderWithProvider(<OfficeProbe />);

    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("roland"));
    expect(screen.getByTestId("count").textContent).toBe("2");
  });
});
