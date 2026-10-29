/**
 * fix/staff-settings-link — the Admin page is the hub for managing people, so
 * it links to Users and Practice staff (ruling: no new nav tabs in any module).
 *
 * Also dumps the page for the PR screenshot, the admin-staff-shots way:
 *
 *   pnpm exec vite build
 *   STAFF_SHOTS=1 pnpm exec vitest run tests/admin-hub-links.test.tsx
 *   node scripts/shoot-staff.mjs
 *
 * NO NETWORK, NO BACKEND. Health answers "healthy" with no services; every
 * other admin read is refused, which the page treats as "not loaded".
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

vi.mock("@/lib/api", () => {
  const refuse = () => Promise.reject(new Error("not in this test"));
  return {
    api: {
      getAdminHealth: () =>
        Promise.resolve({ status: "healthy", services: {}, timestamp: "2026-10-29T15:00:00.000Z" }),
      getAdminConfig: refuse,
      getAdminCosts: refuse,
      getAdminSyncHistory: refuse,
      getAdminQueues: refuse,
      getAdminErrors: refuse,
      getNotificationsConfig: refuse,
    },
  };
});

import Admin from "@/pages/Admin";

afterEach(() => cleanup());

function renderAdmin() {
  const { hook } = memoryLocation({ path: "/admin", static: true });
  return render(
    <WouterRouter hook={hook}>
      <Admin />
    </WouterRouter>,
  );
}

describe("Admin hub — people links", () => {
  it("links to Users and Practice staff above the tabs, whichever tab is open", async () => {
    renderAdmin();
    const users = await screen.findByTestId("admin-link-users");
    const staff = await screen.findByTestId("admin-link-staff");

    expect(users.getAttribute("href")).toBe("/admin/users");
    expect(staff.getAttribute("href")).toBe("/admin/staff");
    expect(staff.textContent).toContain("Practice staff");
    expect(staff.textContent).toContain("Hygienist names, licence numbers and sign-ins");
  });
});

const OUT = resolve(import.meta.dirname, ".shots");
const SHOTS = process.env.STAFF_SHOTS === "1";

describe.skipIf(!SHOTS)("admin hub shots", () => {
  it("staff-04-admin-hub", async () => {
    renderAdmin();
    await screen.findByTestId("admin-link-staff");
    // Wait for the load to settle so the shot is the page, not its spinner.
    await screen.findByText("Integrations");
    await new Promise((r) => setTimeout(r, 50));
    const file = resolve(OUT, "staff-04-admin-hub@1280x700.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, document.body.innerHTML, "utf8");
  });
});
