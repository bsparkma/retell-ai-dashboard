/**
 * The Administration nav group (Admin + Users) and the Developer Console are
 * reachable from EVERY module's sidebar, not only Voice's.
 *
 * Before this, Admin and Users lived inside Voice's "Insights" group, so an
 * admin working in TC, Hygiene, or RCM had no nav path to the /admin settings
 * hub — and SC-1 removed TC's own Settings tab, so /admin is the only door.
 *
 * Renders the REAL shell against a faked /auth/me (same harness as
 * role-nav.test.tsx): the regression this guards is wiring, not a pure function.
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

const authState = vi.hoisted(() => ({
  role: "admin" as string | null,
  isSuperAdmin: false,
  permissions: [] as string[],
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "Test User",
      email: "nav-test@example.test",
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
import DashboardLayout from "@/components/DashboardLayout";
import { ACTIONS } from "@/lib/permissions";

const ADMIN_PERMS = [...ACTIONS];
// Everything a TC-module user could need EXCEPT admin.all.
const NO_ADMIN_PERMS = ACTIONS.filter((a) => a !== "admin.all");

beforeEach(() => {
  authState.role = "admin";
  authState.isSuperAdmin = false;
  authState.permissions = ADMIN_PERMS;
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

/** Group titles in sidebar order — each group is a `nav > div` whose first child is the title. */
async function groupTitles(): Promise<string[]> {
  const nav = await screen.findByRole("navigation");
  return Array.from(nav.children).map((g) => (g.firstElementChild?.textContent ?? "").trim());
}

/** The hrefs of the links inside one titled group, in order. */
async function hrefsInGroup(title: string): Promise<string[]> {
  const nav = await screen.findByRole("navigation");
  const group = Array.from(nav.children).find((g) => (g.firstElementChild?.textContent ?? "").trim() === title);
  if (!group) return [];
  return Array.from(group.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("Administration group in every module", () => {
  it("(a) renders for an admin.all user in the TC module's nav, after TC's own groups", async () => {
    renderShell("/tc/dashboard");

    await waitFor(async () => {
      expect(await groupTitles()).toEqual(["Casework", "Tools", "Administration"]);
    });
    expect(await hrefsInGroup("Administration")).toEqual(["/admin", "/admin/users"]);
    // SC-1: the TC Settings tab stays gone — /admin is the hub.
    expect(document.querySelector('a[href="/tc/settings"]')).toBeNull();
    expect(document.querySelector('a[href="/admin/tc/settings"]')).toBeNull();
  });

  it("also renders in the Voice nav, as its own group (no longer inside Insights)", async () => {
    renderShell("/dashboard");

    await waitFor(async () => {
      expect(await groupTitles()).toEqual(["Operations", "Insights", "Administration"]);
    });
    expect(await hrefsInGroup("Insights")).toEqual(["/analytics"]);
    expect(await hrefsInGroup("Administration")).toEqual(["/admin", "/admin/users"]);
  });

  it("(b) is absent for a user without admin.all — no group, no links", async () => {
    authState.role = "office";
    authState.permissions = NO_ADMIN_PERMS;
    renderShell("/tc/dashboard");

    await waitFor(async () => {
      expect(await groupTitles()).toContain("Casework");
    });
    expect(await groupTitles()).not.toContain("Administration");
    expect(document.querySelector('a[href="/admin"]')).toBeNull();
    expect(document.querySelector('a[href="/admin/users"]')).toBeNull();
  });

  it("(b) is absent for a hygienist on the TC Inbox", async () => {
    authState.role = "hygiene";
    authState.permissions = ["tc.hygiene"];
    renderShell("/tc/inbox");

    await waitFor(async () => {
      expect(await groupTitles()).toEqual(["Casework"]);
    });
  });
});

describe("Developer Console in every module", () => {
  it("(c) renders below Administration for the platform tier, in the TC nav", async () => {
    authState.isSuperAdmin = true;
    renderShell("/tc/dashboard");

    await waitFor(async () => {
      expect(await groupTitles()).toEqual(["Casework", "Tools", "Administration", "Platform"]);
    });
    expect(await hrefsInGroup("Platform")).toEqual(["/platform"]);
    expect(screen.getByText("Developer Console")).toBeTruthy();
  });

  it("(c) renders below Administration for the platform tier, in the Voice nav", async () => {
    authState.isSuperAdmin = true;
    renderShell("/dashboard");

    await waitFor(async () => {
      expect(await groupTitles()).toEqual(["Operations", "Insights", "Administration", "Platform"]);
    });
  });

  it("(c) is absent for a tenant admin who is not platform tier, even holding every action", async () => {
    authState.isSuperAdmin = false;
    authState.permissions = ADMIN_PERMS;
    renderShell("/tc/dashboard");

    await waitFor(async () => {
      expect(await groupTitles()).toContain("Administration");
    });
    expect(await groupTitles()).not.toContain("Platform");
    expect(screen.queryByText("Developer Console")).toBeNull();
    expect(document.querySelector('a[href="/platform"]')).toBeNull();
  });
});
