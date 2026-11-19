/**
 * /admin/office-settings — this practice's per-office switches (MT-2c, ruling A).
 *
 * The REAL api client runs against a stubbed fetch, so these pin the actual
 * URLs the page calls:
 *   - every request goes through the practice's door (/api/admin/office-settings),
 *     never the Developer Console's (/api/platform), and never names a tenant;
 *   - a flip PUTs to that door and shows what the server answered;
 *   - sections follow the practice's modules (no TC switches without TC);
 *   - the global settings (email / SMS sending, call retention) are not here;
 *   - nurture and opportunities are shown read-only, with no control;
 *   - the page sits under /admin's admin.all gate, and the hub links to it.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const authState = vi.hoisted(() => ({ modules: ["tc", "hyg"] as string[] }));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

vi.mock("@/contexts/AuthContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/AuthContext")>();
  return {
    ...real,
    useAuth: () => ({
      status: "authenticated",
      user: {
        email: "manager@example.test",
        name: "Manager",
        tenant: { slug: "carein", displayName: "CareIN Dental", modules: authState.modules },
        role: "admin",
        isSuperAdmin: false,
        permissions: ["admin.all", "tc.full"],
        homeOffice: null,
      },
    }),
  };
});

import AdminOfficeSettings from "@/pages/AdminOfficeSettings";
import { canVisit, requiredActionFor } from "@/lib/permissions";
import { HUB_CARDS } from "@/pages/admin/settingsHub";

const TC_PATHS = [
  "tc-checkout-offices",
  "tc-od-sync-offices",
  "tc-auto-checkout-offices",
  "tc-referrals-offices",
  "tc-referral-email-offices",
  "tc-referral-patient-email-offices",
];

function tcOffice(office: string, enabled: boolean, settingKey: string) {
  return {
    office,
    enabled,
    source: enabled ? "db" : "default",
    policyKnown: true,
    envValue: null,
    settingKey,
    envVar: `X_${office.toUpperCase()}`,
    updatedAt: null,
    updatedBy: null,
  };
}

function hygOffice(officeKey: string, enabled: boolean) {
  return {
    officeKey,
    officeName: officeKey === "roland" ? "Roland" : "Valley Fort Smith",
    enabled,
    source: "default",
    db: null,
    inRow: null,
    env: null,
    envVar: `HYG_OD_ENABLED_${officeKey.toUpperCase()}`,
    envRaw: null,
    envEffect: null,
    hardcoded: false,
    disagreesWithEnv: false,
    ready: false,
    blockedBy: null,
  };
}

/** Server state, per switch path: office -> enabled. */
let server: Record<string, Record<string, boolean>>;
/** Every request the page made: [method, pathname, body]. */
let calls: Array<[string, string, unknown]>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function answer(path: string): unknown {
  if (path === "hyg-offices") {
    return {
      success: true,
      offices: Object.entries(server[path]).map(([o, on]) => hygOffice(o, on)),
      setting: { policyKnown: true, hasRow: false, updatedAt: null, updatedBy: null, settingKey: "hyg_od_enabled" },
      controlPlaneError: null,
    };
  }
  return {
    success: true,
    offices: Object.entries(server[path]).map(([o, on]) => tcOffice(o, on, path)),
    settingKey: path,
    controlPlaneError: null,
  };
}

beforeEach(() => {
  authState.modules = ["tc", "hyg"];
  server = Object.fromEntries([...TC_PATHS, "hyg-offices"].map((p) => [p, { roland: true, valley: false }]));
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push([method, url.pathname + url.search, body]);
      const m = url.pathname.match(/\/api\/admin\/office-settings\/([a-z-]+)(?:\/([a-z]+))?$/);
      if (!m) return json({ success: false, error: "not stubbed" }, 404);
      const [, path, office] = m;
      if (path === "runbook-switches") {
        return json({
          success: true,
          offices: ["roland", "valley"],
          policyKnown: true,
          switches: [
            { office: "roland", settingKey: "tc_nurture_enabled", enabled: true, updatedAt: null, updatedBy: null },
            { office: "valley", settingKey: "tc_nurture_enabled", enabled: false, updatedAt: null, updatedBy: null },
            { office: "roland", settingKey: "tc_opportunities_sync", enabled: false, updatedAt: null, updatedBy: null },
            { office: "valley", settingKey: "tc_opportunities_sync", enabled: true, updatedAt: null, updatedBy: null },
          ],
        });
      }
      if (!server[path]) return json({ success: false, error: "not stubbed" }, 404);
      if (method === "PUT" && office) server[path][office] = Boolean((body as { enabled: boolean }).enabled);
      return json(answer(path));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const { hook } = memoryLocation({ path: "/admin/office-settings", static: true });
  return render(
    <WouterRouter hook={hook}>
      <AdminOfficeSettings />
    </WouterRouter>,
  );
}

describe("/admin/office-settings", () => {
  it("draws every per-office switch, through the practice's door only, never naming a tenant", async () => {
    renderPage();
    for (const prefix of [
      "tc-checkout",
      "tc-od-sync",
      "tc-auto-checkout",
      "tc-referrals",
      "tc-referral-email",
      "tc-referral-patient-email",
    ]) {
      expect(await screen.findByTestId(`${prefix}-office-roland`)).toBeTruthy();
    }
    expect(await screen.findByTestId("hyg-office-roland")).toBeTruthy();
    expect(await screen.findByTestId("runbook-switches")).toBeTruthy();

    await waitFor(() => expect(calls.length).toBe(8));
    expect(calls.map(([m, p]) => `${m} ${p}`).sort()).toEqual(
      [...TC_PATHS, "hyg-offices", "runbook-switches"].map((p) => `GET /api/admin/office-settings/${p}`).sort(),
    );
    for (const [, p] of calls) {
      expect(p).not.toMatch(/\/platform\//);
      expect(p).not.toMatch(/tenant/i);
    }
    // The every-practice entitlement list is the console's, not the practice's.
    expect(screen.queryByTestId("hyg-entitlements")).toBeNull();
  });

  it("a flip goes to the practice's door, and the switch shows what the server answered", async () => {
    renderPage();
    const sw = await screen.findByTestId("tc-checkout-switch-roland");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    // OFF is the fast path: no confirmation.
    fireEvent.click(sw);
    await waitFor(() =>
      expect(calls).toContainEqual(["PUT", "/api/admin/office-settings/tc-checkout-offices/roland", { enabled: false }]),
    );
    await waitFor(() => expect(screen.getByTestId("tc-checkout-switch-roland").getAttribute("aria-checked")).toBe("false"));
    expect(server["tc-checkout-offices"].roland).toBe(false);

    // ON asks first, then PUTs through the same door.
    fireEvent.click(await screen.findByTestId("tc-referrals-switch-valley"));
    fireEvent.click(await screen.findByTestId("tc-referrals-confirm-on"));
    await waitFor(() =>
      expect(calls).toContainEqual(["PUT", "/api/admin/office-settings/tc-referrals-offices/valley", { enabled: true }]),
    );
    expect(calls.some(([, p]) => p.includes("/platform/"))).toBe(false);
  });

  it("shows nurture and opportunities read-only, with no control to change them", async () => {
    renderPage();
    const section = await screen.findByTestId("runbook-switches");
    expect((await within(section).findByTestId("runbook-tc_nurture_enabled-roland")).textContent).toContain("on");
    expect(within(section).getByTestId("runbook-tc_nurture_enabled-valley").textContent).toContain("off");
    expect(within(section).getByTestId("runbook-tc_opportunities_sync-valley").textContent).toContain("on");
    expect(within(section).queryAllByRole("switch")).toHaveLength(0);
    expect(within(section).queryAllByRole("button")).toHaveLength(0);
  });

  it("does not show the global settings: email and SMS sending, call retention", async () => {
    renderPage();
    await screen.findByTestId("tc-checkout-office-roland");
    await waitFor(() => expect(calls.length).toBe(8));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/retention/i);
    expect(text).not.toMatch(/\bSMS\b/);
    expect(text).not.toMatch(/tc_email_enabled|tc_sms_enabled|call_retention_days/);
    expect(calls.some(([, p]) => /retention|email-enabled|sms/i.test(p))).toBe(false);
  });

  it("follows the practice's modules: TC without hygiene, and neither", async () => {
    authState.modules = ["tc"];
    renderPage();
    expect(await screen.findByTestId("tc-checkout-office-roland")).toBeTruthy();
    await waitFor(() => expect(calls.length).toBe(7));
    expect(calls.some(([, p]) => p.endsWith("/hyg-offices"))).toBe(false);
    expect(screen.queryByTestId("hygiene-panel")).toBeNull();
    cleanup();

    authState.modules = ["voice"];
    calls = [];
    renderPage();
    expect(await screen.findByTestId("admin-office-settings-empty")).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("links to the email identity's existing home instead of drawing a second copy", async () => {
    renderPage();
    const link = await screen.findByTestId("admin-office-settings-email-identity");
    expect(link.getAttribute("href")).toBe("/admin/tc/settings#practice");
  });
});

describe("the gate and the hub", () => {
  it("/admin/office-settings is admin.all, like the rest of /admin", () => {
    expect(requiredActionFor("/admin/office-settings")).toBe("admin.all");
    expect(canVisit(["admin.all"], "/admin/office-settings")).toBe(true);
    expect(canVisit(["tc.full"], "/admin/office-settings")).toBe(false);
  });

  it("the hub has an Office settings card under Practice settings", () => {
    const card = HUB_CARDS.find((c) => c.id === "office-settings");
    expect(card?.href).toBe("/admin/office-settings");
    expect(card?.group).toBe("practice");
  });
});
