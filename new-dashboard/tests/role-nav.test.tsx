/**
 * Role-scoped shell (Roles PR B): nav filtering, the access-request dead-end,
 * and the 401 sign-out.
 *
 * These render the REAL components against a faked /auth/me, because the bug
 * this guards against is a wiring one — a permission list that never reaches
 * the filter, or an access-request screen that still mounts pages underneath.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Classic JSX runtime global — see tests/module-home.test.tsx for why.
(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

/** Per-test control over what /auth/me returns. */
const authState = vi.hoisted(() => ({
  role: "admin" as string | null,
  isSuperAdmin: false,
  permissions: [] as string[],
  email: "boss@carein.ai",
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "Test User",
      email: authState.email,
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN Dental LLC", modules: ["voice", "tc"] },
      role: authState.role,
      isSuperAdmin: authState.isSuperAdmin,
      permissions: authState.permissions,
    })),
  };
});

// The layout polls admin health; never settle so nothing renders a network state.
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: { ...real.api, getAdminHealth: vi.fn(() => new Promise(() => {})) },
  };
});

import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";
import RequireAuth from "@/components/RequireAuth";
import DashboardLayout, { visibleNav } from "@/components/DashboardLayout";
import { ACTIONS } from "@/lib/permissions";

const PERMS: Record<string, string[]> = {
  admin: [...ACTIONS],
  office: ACTIONS.filter((a) => a !== "admin.all"),
  tc: ["voice.read", "tc.full", "tc.hygiene"],
  hygiene: ["tc.hygiene"],
};

beforeEach(() => {
  authState.role = "admin";
  authState.isSuperAdmin = false;
  authState.permissions = PERMS.admin;
  authState.email = "boss@carein.ai";
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
                <OfficeProvider>
                  <SlotMarkersProvider>
                    <DashboardLayout>
                      <div>page</div>
                    </DashboardLayout>
                  </SlotMarkersProvider>
                </OfficeProvider>
              </ModuleProvider>
            </RequireAuth>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

// --- visibleNav (pure) ------------------------------------------------------

describe("visibleNav", () => {
  const GROUPS = [
    {
      title: "Operations",
      items: [
        { path: "/dashboard", label: "Dashboard", icon: (() => null) as never },
        { path: "/calls", label: "Calls", icon: (() => null) as never },
      ],
    },
    {
      title: "Insights",
      items: [
        { path: "/analytics", label: "Analytics", icon: (() => null) as never },
        { path: "/admin", label: "Admin", icon: (() => null) as never },
        { path: "/admin/users", label: "Users", icon: (() => null) as never },
      ],
    },
  ];

  it("drops a group once every item in it is hidden", () => {
    const visible = visibleNav(GROUPS, PERMS.office);
    expect(visible.map((g) => g.title)).toEqual(["Operations", "Insights"]);
    // office keeps Analytics but loses both admin links.
    expect(visible[1].items.map((i) => i.label)).toEqual(["Analytics"]);

    // hygiene loses every voice item, so BOTH groups disappear entirely.
    expect(visibleNav(GROUPS, PERMS.hygiene)).toEqual([]);
  });

  it("hides everything while permissions are still unknown (fails closed)", () => {
    expect(visibleNav(GROUPS, undefined)).toEqual([]);
  });

  it("admin keeps every item", () => {
    const visible = visibleNav(GROUPS, PERMS.admin);
    expect(visible.flatMap((g) => g.items).map((i) => i.label)).toEqual([
      "Dashboard",
      "Calls",
      "Analytics",
      "Admin",
      "Users",
    ]);
  });
});

// --- rendered nav per role --------------------------------------------------

/** The nav link labels currently rendered in the sidebar. */
async function navLabels(): Promise<string[]> {
  const nav = await screen.findByRole("navigation");
  return Array.from(nav.querySelectorAll("a"))
    .map((a) => (a.textContent ?? "").trim())
    .filter(Boolean);
}

describe("sidebar nav per role", () => {
  it("HYGIENE sees exactly three items: TC Inbox, Intake, Submissions", async () => {
    authState.role = "hygiene";
    authState.permissions = PERMS.hygiene;
    renderShell("/tc/hygiene/inbox");

    await waitFor(async () => {
      expect(await navLabels()).toEqual(["TC Inbox", "Intake", "Submissions"]);
    });
  });

  it("office loses the Admin and Users links but keeps the rest", async () => {
    authState.role = "office";
    authState.permissions = PERMS.office;
    renderShell("/dashboard");

    await waitFor(async () => {
      const labels = await navLabels();
      expect(labels).toContain("Dashboard");
      expect(labels).toContain("Analytics");
      expect(labels).not.toContain("Admin");
      expect(labels).not.toContain("Users");
    });
  });

  it("admin keeps Admin and Users", async () => {
    renderShell("/dashboard");
    await waitFor(async () => {
      const labels = await navLabels();
      expect(labels).toContain("Admin");
      expect(labels).toContain("Users");
    });
  });

  it("a super_admin whose tenant role is hygiene still sees everything", async () => {
    authState.role = "hygiene";
    authState.isSuperAdmin = true;
    authState.permissions = [...ACTIONS]; // /auth/me grants a super_admin all actions
    renderShell("/dashboard");

    await waitFor(async () => {
      expect(await navLabels()).toContain("Admin");
    });
  });
});

describe("module switcher", () => {
  it("is hidden for a hygienist — TC is the only module they can open", async () => {
    authState.role = "hygiene";
    authState.permissions = PERMS.hygiene;
    renderShell("/tc/hygiene/inbox");

    await screen.findByRole("navigation");
    // Offering "Voice" would switch them to a sidebar with nothing in it and no
    // obvious way back.
    expect(screen.queryByText("Treatment Coordinator")).toBeNull();
    expect(screen.queryByText("Voice")).toBeNull();
  });

  it("is offered to an office user, who can open both", async () => {
    authState.role = "office";
    authState.permissions = PERMS.office;
    renderShell("/dashboard");

    await screen.findByRole("navigation");
    expect(screen.getByText("Voice")).toBeTruthy();
  });
});

// --- access-request dead-end ------------------------------------------------

describe("access-request screen", () => {
  it("renders for role:null and shows the address an admin needs", async () => {
    authState.role = null;
    authState.permissions = [];
    authState.email = "unseeded@carein.ai";
    renderShell("/dashboard");

    expect(await screen.findByText(/isn't set up yet/i)).toBeTruthy();
    expect(screen.getByTestId("access-request-email").textContent).toBe("unseeded@carein.ai");
  });

  it("mounts NO nav and NO page underneath it", async () => {
    authState.role = null;
    authState.permissions = [];
    renderShell("/dashboard");

    await screen.findByText(/isn't set up yet/i);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByText("page")).toBeNull();
  });

  it("does NOT swallow a super_admin who has no tenant role", async () => {
    authState.role = null;
    authState.isSuperAdmin = true;
    authState.permissions = [...ACTIONS];
    renderShell("/dashboard");

    // The platform tier must always be able to get in and fix the roster.
    await waitFor(() => expect(screen.getByText("page")).toBeTruthy());
    expect(screen.queryByText(/isn't set up yet/i)).toBeNull();
  });
});
