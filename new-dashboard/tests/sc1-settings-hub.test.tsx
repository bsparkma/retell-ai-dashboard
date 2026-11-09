/**
 * SC-1 — settings consolidation, screens only.
 *
 * What this file defends:
 *   1. REDIRECTS. /tc/settings (and a section hash on it) lands on
 *      /admin/tc/settings, through the real App router.
 *   2. THE PERMISSION PIN. The moved page needs exactly what it needed before,
 *      `tc.full`, byte for byte, and for every role in the server's map
 *      "may open the new path" equals "could open the old path". Nobody gains
 *      access and nobody loses it.
 *   3. NAV. TC's sidebar no longer carries Settings; nothing else moved.
 *   4. THE HUB. /admin is the card map; the voice ops widgets are not on it.
 *   5. OPERATIONS. The Developer Console has an Operations tab, and it is what
 *      calls the /api/admin/* reads now.
 *
 * NO NETWORK. Every api.* call returns a promise that never settles; the proxy
 * records which methods were asked for, which is how (4) and (5) tell where
 * the ops widgets live. Synthetic people only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { readFileSync } from "node:fs";
import path from "node:path";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const ADMIN_PERMS = [
  "admin.all",
  "tc.full",
  "tc.hygiene",
  "tc.notification_defaults",
  "voice.chart_write",
  "voice.read",
  "voice.send_to_tc",
  "voice.sync",
  "voice.transcribe",
  "voice.write",
];

const authState = vi.hoisted(() => ({
  modules: ["voice", "tc"] as string[],
  role: "admin" as string,
  permissions: [] as string[],
  isSuperAdmin: false,
}));

/** Every api.* method name a page asked for during the test. */
const apiCalls = vi.hoisted(() => new Set<string>());

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Drew Example",
      email: "drew.example@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: authState.modules },
      role: authState.role,
      isSuperAdmin: authState.isSuperAdmin,
      permissions: authState.permissions,
      homeOffice: null,
    })),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          apiCalls.add(String(prop));
          return new Promise(() => {});
        },
      },
    ),
  };
});

vi.mock("@/features/tc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/api")>();
  const pending = () => new Promise(() => {});
  return Object.fromEntries(
    Object.entries(real).map(([key, value]) => [key, typeof value === "function" ? pending : value]),
  );
});

import { Router as AppRouter } from "@/App";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ROUTE_PERMISSIONS, canVisit, requiredActionFor } from "@/lib/permissions";
import {
  LEGACY_TC_SETTINGS_PATH,
  TC_SETTINGS_PATH,
  legacyTcSettingsRedirectTarget,
} from "@/features/tc/settings/paths";
import { HUB_CARDS } from "@/pages/admin/settingsHub";

function renderApp(path: string) {
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

/** role → the actions it holds, parsed from the SERVER's map. */
function serverRoleActions(): Record<string, string[]> {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "backend", "config", "permissions.js"),
    "utf8",
  );
  const body = src.slice(src.indexOf("const PERMISSIONS = Object.freeze({"), src.indexOf("/** Every role that appears"));
  const byRole: Record<string, string[]> = {};
  for (const m of body.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':\s*Object\.freeze\(\[([^\]]*)\]\)/gm)) {
    const action = m[1];
    for (const r of m[2].matchAll(/'([a-z_]+)'/g)) (byRole[r[1]] ??= []).push(action);
  }
  return byRole;
}

beforeEach(() => {
  localStorage.clear();
  apiCalls.clear();
  window.location.hash = "";
  authState.modules = ["voice", "tc"];
  authState.role = "admin";
  authState.permissions = [...ADMIN_PERMS];
  authState.isSuperAdmin = false;
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

// ── 1. redirects ──────────────────────────────────────────────────────────────

describe("redirects", () => {
  it("carries a known section hash across, and drops anything else", () => {
    expect(legacyTcSettingsRedirectTarget("")).toBe("/admin/tc/settings");
    expect(legacyTcSettingsRedirectTarget("#pricing")).toBe("/admin/tc/settings#pricing");
    expect(legacyTcSettingsRedirectTarget("#email_identity")).toBe("/admin/tc/settings#email_identity");
    expect(legacyTcSettingsRedirectTarget("#not-a-section")).toBe("/admin/tc/settings");
    expect(legacyTcSettingsRedirectTarget("#<script>")).toBe("/admin/tc/settings");
  });

  it("/tc/settings redirects to /admin/tc/settings through the real router", async () => {
    const memory = renderApp(LEGACY_TC_SETTINGS_PATH);
    await waitFor(() => expect(memory.history.at(-1)).toBe(TC_SETTINGS_PATH));
  });

  it("/tc/settings#pricing redirects to /admin/tc/settings#pricing", async () => {
    window.location.hash = "#pricing";
    const memory = renderApp(LEGACY_TC_SETTINGS_PATH);
    await waitFor(() => expect(memory.history.at(-1)).toBe("/admin/tc/settings#pricing"));
  });

  it("a tc-role user follows the redirect and is not bounced home", async () => {
    authState.role = "tc";
    authState.permissions = serverRoleActions().tc;
    const memory = renderApp(LEGACY_TC_SETTINGS_PATH);
    await waitFor(() => expect(memory.history.at(-1)).toBe(TC_SETTINGS_PATH));
    await new Promise((r) => setTimeout(r, 30));
    expect(memory.history.at(-1)).toBe(TC_SETTINGS_PATH);
    expect(memory.history).not.toContain("/tc/dashboard");
  });
});

// ── 2. the permission pin ────────────────────────────────────────────────────

describe("the moved page's permission requirement is unchanged", () => {
  it("is tc.full, byte for byte, the same as the old path resolves to", () => {
    expect(ROUTE_PERMISSIONS["/admin/tc/settings"]).toBe("tc.full");
    expect(JSON.stringify(requiredActionFor(TC_SETTINGS_PATH))).toBe(
      JSON.stringify(requiredActionFor(LEGACY_TC_SETTINGS_PATH)),
    );
    expect(JSON.stringify(requiredActionFor(LEGACY_TC_SETTINGS_PATH))).toBe('"tc.full"');
  });

  it("for every role in the server's map, may-open-new equals could-open-old", () => {
    const byRole = serverRoleActions();
    const roles = Object.keys(byRole);
    // The seven tenant roles, so a parse failure cannot pass vacuously.
    expect(roles.sort()).toEqual(["admin", "doctor", "hygiene", "office", "rcm_biller", "reviewer", "tc"]);
    for (const role of roles) {
      expect(canVisit(byRole[role], TC_SETTINGS_PATH), role).toBe(canVisit(byRole[role], LEGACY_TC_SETTINGS_PATH));
    }
    // Spelled out: admin, office and tc keep it; nobody else gains it.
    expect(roles.filter((r) => canVisit(byRole[r], TC_SETTINGS_PATH)).sort()).toEqual(["admin", "office", "tc"]);
  });

  it("does not widen /admin: admin.all still gates the hub and its other pages", () => {
    expect(ROUTE_PERMISSIONS["/admin"]).toBe("admin.all");
    for (const p of ["/admin", "/admin/users", "/admin/print-templates"]) {
      expect(requiredActionFor(p)).toBe("admin.all");
      expect(canVisit(["tc.full"], p)).toBe(false);
    }
    // And TC settings is not behind admin.all.
    expect(canVisit(["admin.all"], TC_SETTINGS_PATH)).toBe(false);
  });

  it("a hygienist cannot reach the moved page by its new address either", async () => {
    authState.role = "hygiene";
    authState.permissions = serverRoleActions().hygiene;
    const memory = renderApp(TC_SETTINGS_PATH);
    await waitFor(() => expect(memory.history.at(-1)).toBe("/hyg/day"));
  });
});

// ── 3. nav ───────────────────────────────────────────────────────────────────

describe("nav", () => {
  it("the TC sidebar no longer links to Settings; the rest of Tools is still there", async () => {
    renderApp("/tc/dashboard");
    await waitFor(() => expect(document.querySelector('a[href="/tc/library"]')).not.toBeNull());
    expect(document.querySelector('a[href="/tc/settings"]')).toBeNull();
    expect(document.querySelector('a[href="/admin/tc/settings"]')).toBeNull();
  });

  it("the Voice sidebar still has Admin and Users, and nothing new", async () => {
    renderApp("/calls");
    await waitFor(() => expect(document.querySelector('nav a[href="/admin"], a[href="/admin"]')).not.toBeNull());
    expect(document.querySelector('a[href="/admin/users"]')).not.toBeNull();
    expect(document.querySelector('a[href="/admin/tc/settings"]')).toBeNull();
    expect(document.querySelector('a[href="/admin/print-templates"]')).toBeNull();
  });
});

// ── 4. the hub ───────────────────────────────────────────────────────────────

/** The hub card links, in page order, inside one section. */
function hrefsIn(testId: string): string[] {
  const el = screen.getByTestId(testId);
  return Array.from(el.querySelectorAll("a[data-testid^='admin-link-']")).map((a) => a.getAttribute("href") ?? "");
}

describe("/admin is the settings card map", () => {
  it("shows Practice settings and Module settings, in the ratified order", async () => {
    renderApp("/admin");
    await screen.findByTestId("admin-link-practice-info");
    expect(hrefsIn("admin-practice-settings")).toEqual([
      "/admin/tc/settings#practice",
      "/admin/tc/settings#providers",
      "/admin/tc/settings#referrals",
      "/admin/print-templates",
      "/admin/users",
    ]);
    expect(hrefsIn("admin-module-tc")).toEqual(["/admin/tc/settings"]);
    expect(hrefsIn("admin-module-voice")).toEqual(["/agents", "/scheduling"]);
    expect(screen.getByTestId("admin-voice-notifications")).toBeTruthy();
    // Practice staff was retired in #304; no card points at it.
    expect(document.querySelector('a[href="/admin/staff"]')).toBeNull();
  });

  it("no longer carries the voice ops widgets or calls their endpoints", async () => {
    renderApp("/admin");
    await screen.findByTestId("admin-link-users");
    for (const m of [
      "getAdminHealth",
      "getAdminConfig",
      "getAdminCosts",
      "getAdminSyncHistory",
      "getAdminQueues",
      "getAdminErrors",
      "triggerMangoSync",
      "startMangoScheduler",
      "stopMangoScheduler",
      "testConnection",
    ]) {
      expect(apiCalls.has(m), m).toBe(false);
    }
    // The practice-level toggles stayed, and load themselves.
    await waitFor(() => expect(apiCalls.has("getNotificationsConfig")).toBe(true));
    expect(screen.queryByText("Integrations")).toBeNull();
    expect(screen.queryByText("Processing Queues")).toBeNull();
  });

  it("a practice without TC gets no TC cards (rather than cards that 403)", async () => {
    authState.modules = ["voice"];
    renderApp("/admin");
    await screen.findByTestId("admin-link-users");
    expect(screen.queryByTestId("admin-link-practice-info")).toBeNull();
    expect(screen.queryByTestId("admin-module-tc")).toBeNull();
    expect(hrefsIn("admin-practice-settings")).toEqual(["/admin/print-templates", "/admin/users"]);
  });

  it("every card the registry can show resolves to a real route of this app", () => {
    const app = readFileSync(path.resolve(import.meta.dirname, "..", "client", "src", "App.tsx"), "utf8");
    for (const c of HUB_CARDS) {
      const route = c.href.split("#")[0];
      expect(app.includes(`<Route path="${route}"`), route).toBe(true);
    }
  });
});

// ── 5. operations ────────────────────────────────────────────────────────────

describe("Developer Console → Operations", () => {
  it("is a tab of its own, and opening it is what fetches the ops readouts", async () => {
    authState.isSuperAdmin = true;
    renderApp("/platform");
    const tab = await screen.findByTestId("tab-operations");
    expect(apiCalls.has("getAdminHealth")).toBe(false);
    // Radix tabs activate on mousedown.
    fireEvent.mouseDown(tab);
    expect(await screen.findByTestId("platform-operations")).toBeTruthy();
    await waitFor(() => {
      for (const m of ["getAdminHealth", "getAdminConfig", "getAdminCosts", "getAdminSyncHistory", "getAdminQueues", "getAdminErrors"]) {
        expect(apiCalls.has(m), m).toBe(true);
      }
    });
  });

  it("is not shown to a practice admin who is not a platform administrator", async () => {
    renderApp("/platform");
    expect(await screen.findByTestId("platform-access-required")).toBeTruthy();
    expect(screen.queryByTestId("tab-operations")).toBeNull();
    expect(apiCalls.has("getAdminHealth")).toBe(false);
  });
});
