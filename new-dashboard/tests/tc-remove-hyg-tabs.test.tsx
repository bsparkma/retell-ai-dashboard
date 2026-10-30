/**
 * CO-2 — the TC app's Hygiene tabs are gone (Beau, 2026-10-29: the hygiene app
 * replaces them; the TC Inbox stays).
 *
 *  - the old addresses redirect instead of 404ing: the handoff form to
 *    Checkout, Submissions and the old Inbox path to the TC Inbox, which now
 *    lives at /tc/inbox on the same tc.hygiene grant
 *  - no role's sidebar shows "Hygiene handoff" or "Submissions"; every role
 *    that could open the TC Inbox before still sees it
 *
 * Network-facing modules never settle, as in module-home: pages mount into
 * their loading states, and only ROUTING is under test.
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

const authState = vi.hoisted(() => ({ role: "admin" as string, permissions: [] as string[] }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(),
    logout: vi.fn(),
    fetchCurrentUser: vi.fn(async () => ({
      name: "Test User",
      email: "staff@carein.ai",
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: ["voice", "tc", "hyg"] },
      role: authState.role,
      isSuperAdmin: false,
      permissions: authState.permissions,
    })),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: new Proxy({}, { get: () => () => new Promise(() => {}) }) };
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
import { ACTIONS, canVisit, requiredActionFor } from "@/lib/permissions";

const PERMS: Record<string, string[]> = {
  admin: [...ACTIONS],
  office: ACTIONS.filter((a) => a !== "admin.all" && a !== "tc.referral_signoff"),
  tc: ["voice.read", "tc.full", "tc.hygiene"],
  hygiene: ["tc.hygiene", "hyg.read"],
  doctor: ["tc.referral_signoff"],
};

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

async function navLabels(): Promise<string[]> {
  const nav = await screen.findByRole("navigation");
  return Array.from(nav.querySelectorAll("a"))
    .map((a) => (a.textContent ?? "").trim())
    .filter(Boolean);
}

beforeEach(() => {
  localStorage.clear();
  authState.role = "admin";
  authState.permissions = PERMS.admin;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CO-2: the old Hygiene addresses redirect", () => {
  it.each([
    ["/tc/hygiene", "/tc/checkout"],
    ["/tc/hygiene/submissions", "/tc/inbox"],
    ["/tc/hygiene/inbox", "/tc/inbox"],
  ])("%s → %s", async (from, to) => {
    const memory = renderApp(from);
    await waitFor(() => expect(memory.history?.at(-1)).toBe(to));
    expect(screen.queryByRole("heading", { name: "404" })).toBeNull();
  });

  it("/tc/inbox is the TC Inbox itself — it stays put, lit in the nav, never the 404 page", async () => {
    const memory = renderApp("/tc/inbox");
    const nav = await screen.findByRole("navigation");
    await waitFor(() => expect(nav.querySelector('a[href="/tc/inbox"]')).not.toBeNull());
    expect(memory.history).toEqual(["/tc/inbox"]);
    expect(screen.queryByRole("heading", { name: "404" })).toBeNull();
  });

  it("a hygienist's old bookmarks: Submissions lands on the Inbox; the handoff form, via Checkout, lands home", async () => {
    authState.role = "hygiene";
    authState.permissions = PERMS.hygiene;
    const toInbox = renderApp("/tc/hygiene/submissions");
    await waitFor(() => expect(toInbox.history?.at(-1)).toBe("/tc/inbox"));
    cleanup();
    // Checkout is tc.full; the courtesy guard sends a hygienist to their home
    // (the hygiene app's day) rather than a page whose every request 403s.
    const viaCheckout = renderApp("/tc/hygiene");
    await waitFor(() => expect(viaCheckout.history?.at(-1)).toBe("/hyg/day"));
  });
});

describe("CO-2: the TC Inbox keeps its grant at its new address", () => {
  it("/tc/inbox needs tc.hygiene, exactly as /tc/hygiene/inbox did — so who can open it is unchanged", () => {
    expect(requiredActionFor("/tc/inbox")).toBe("tc.hygiene");
    for (const [role, perms] of Object.entries(PERMS)) {
      expect(canVisit(perms, "/tc/inbox"), role).toBe(canVisit(perms, "/tc/hygiene/inbox"));
    }
  });
});

describe("CO-2: no role's sidebar shows a removed tab", () => {
  it.each(Object.keys(PERMS))("%s", async (role) => {
    authState.role = role;
    authState.permissions = PERMS[role];
    renderApp("/tc/inbox");
    // Every role that may open the Inbox has it in the nav; wait for it. (A
    // doctor cannot, is sent to their home, and their one TC item, Referrals,
    // waits on a fetch this test never settles — so for them, the nav as drawn.)
    const mayOpen = canVisit(PERMS[role], "/tc/inbox");
    if (mayOpen) await waitFor(async () => expect(await navLabels()).toContain("TC Inbox"));
    else await screen.findByRole("navigation");
    const labels = await navLabels();
    expect(labels).not.toContain("Hygiene handoff");
    expect(labels).not.toContain("Submissions");
    const hrefs = Array.from((await screen.findByRole("navigation")).querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs.filter((h) => h?.startsWith("/tc/hygiene"))).toEqual([]);
  });
});
