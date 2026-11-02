/**
 * CO-3: the /admin hub links to Settings → Print templates as a third card —
 * a card on the hub, never a nav tab (the "/admin is the hub" ruling).
 *
 * NO NETWORK, NO BACKEND. The admin page's own reads are answered as in
 * admin-hub-links.test.tsx.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("@/lib/api", () => {
  const refuse = () => Promise.reject(new Error("not in this test"));
  return {
    api: {
      getAdminHealth: () =>
        Promise.resolve({ status: "healthy", services: {}, timestamp: "2026-11-02T15:00:00.000Z" }),
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
import { ROUTE_PERMISSIONS, canVisit, requiredActionFor } from "@/lib/permissions";

afterEach(() => cleanup());

describe("Admin hub — print templates", () => {
  it("is the third card, linking to /admin/print-templates with its description", async () => {
    const { hook } = memoryLocation({ path: "/admin", static: true });
    render(
      <WouterRouter hook={hook}>
        <Admin />
      </WouterRouter>,
    );
    const link = await screen.findByTestId("admin-link-print-templates");
    expect(link.getAttribute("href")).toBe("/admin/print-templates");
    expect(link.textContent).toContain("Print templates");
    expect(link.textContent).toContain("School/work excuses and appointment cards");
    const cards = within(screen.getByTestId("admin-people-links")).getAllByRole("link");
    expect(cards.map((a) => a.getAttribute("href"))).toEqual(["/admin/users", "/admin/staff", "/admin/print-templates"]);
  });

  it("the page inherits /admin's admin.all gate", () => {
    expect(ROUTE_PERMISSIONS["/admin"]).toBe("admin.all");
    expect(requiredActionFor("/admin/print-templates")).toBe("admin.all");
    expect(canVisit(["tc.full"], "/admin/print-templates")).toBe(false);
    expect(canVisit(["admin.all"], "/admin/print-templates")).toBe(true);
  });
});
