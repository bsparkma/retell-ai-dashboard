/**
 * OB-1: the /admin hub's read-only "Practice setup" card.
 *
 *   progress   "X of Y required steps done" and a bar, from the server's counts
 *   steps      a Done / Needs attention badge, the detail line, and a "Go" link
 *              to the existing screen — only where the viewer could open it
 *   picker     defaults to the user's home office; changing it re-reads
 *   honesty    a failed or malformed read says it could not check — no bar,
 *              no Done badge, ever
 *   placement  FIRST on /admin, in its own section, so the hub's card lists
 *              are untouched
 *
 * NO BACKEND: fetch is stubbed. Config only — no patient data in fixtures.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("@/lib/api", () => {
  const refuse = () => Promise.reject(new Error("not in this test"));
  return {
    handleUnauthorized: () => {},
    api: {
      getAdminHealth: refuse,
      getNotificationsConfig: refuse,
    },
  };
});

import Admin from "@/pages/Admin";
import PracticeSetupCard, { linkOpens, type PracticeSetupCardProps } from "@/pages/admin/PracticeSetupCard";

const ADMIN_PROPS: PracticeSetupCardProps = {
  homeOffice: "valley",
  permissions: ["admin.all", "tc.full", "hyg.read"],
  tenantModules: ["tc", "hyg"],
  isSuperAdmin: false,
};

function answer(office: string) {
  return {
    success: true,
    office,
    officeName: office === "valley" ? "Riley" : "Roland",
    offices: [
      { officeId: "roland", officeName: "Roland" },
      { officeId: "valley", officeName: "Riley" },
    ],
    steps: [
      { id: "P1", title: "Office details", required: true, status: "done", detail: "Display name, address and phone are all set for the letterhead.", link: "/admin/tc/settings#email_identity" },
      { id: "P2", title: "Team & roles", required: true, status: "done", detail: "Active across the practice: 1 admin, 1 TC.", link: "/admin/users" },
      { id: "P3", title: "Hygienist roster", required: true, status: "needs_attention", detail: "2 active hygienists: 2 of 2 have a name and licence, 1 of 2 have a signature.", link: "/admin/users" },
      { id: "P6", title: "Print templates", required: true, status: "done", detail: "School / work excuse: wording saved.", link: "/admin/print-templates" },
      { id: "P7", title: "Referral templates", required: false, status: "needs_attention", detail: "Message to the specialist: not saved.", link: "/admin/tc/settings#referrals" },
      { id: "P9", title: "Features", required: false, status: "done", detail: "Checkout is on and Referrals is off for this office. CareIN support sets these.", link: "/platform" },
    ],
    doneRequired: 3,
    totalRequired: 4,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function okJson(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  fetchMock = vi.fn((input: string | URL) => {
    const url = new URL(String(input));
    return okJson(answer(url.searchParams.get("office") ?? ""));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(props: PracticeSetupCardProps = ADMIN_PROPS) {
  const { hook } = memoryLocation({ path: "/admin", static: true });
  return render(
    <WouterRouter hook={hook}>
      <PracticeSetupCard {...props} />
    </WouterRouter>,
  );
}

describe("Practice setup card", () => {
  it("shows progress, each step's badge and detail, and Go links to the existing screens", async () => {
    renderCard();
    expect(screen.getByTestId("setup-loading")).toBeTruthy();
    const label = await screen.findByTestId("setup-progress-label");
    expect(label.textContent).toBe("3 of 4 required steps done");
    expect(screen.getByRole("progressbar")).toBeTruthy();

    const p3 = screen.getByTestId("setup-step-P3");
    expect(p3.getAttribute("data-status")).toBe("needs_attention");
    expect(within(p3).getByTestId("setup-badge-P3").textContent).toBe("Needs attention");
    expect(p3.textContent).toContain("1 of 2 have a signature");
    expect(within(screen.getByTestId("setup-step-P1")).getByTestId("setup-badge-P1").textContent).toBe("Done");
    expect(screen.getByTestId("setup-step-P7").textContent).toContain("Optional");

    expect(screen.getByTestId("setup-go-P1").getAttribute("href")).toBe("/admin/tc/settings#email_identity");
    expect(screen.getByTestId("setup-go-P2").getAttribute("href")).toBe("/admin/users");
    expect(screen.getByTestId("setup-go-P6").getAttribute("href")).toBe("/admin/print-templates");
    expect(screen.getByTestId("setup-go-P7").getAttribute("href")).toBe("/admin/tc/settings#referrals");
    // The Developer Console is not this viewer's to open: no link, says who sets it.
    expect(screen.queryByTestId("setup-go-P9")).toBeNull();
    expect(screen.getByTestId("setup-step-P9").textContent).toContain("Set by CareIN support");
  });

  it("asks for the user's home office first, and re-reads when the office changes", async () => {
    renderCard();
    await screen.findByTestId("setup-progress-label");
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("office")).toBe("valley");
    const picker = screen.getByTestId("setup-office-picker") as HTMLSelectElement;
    expect(picker.value).toBe("valley");
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(["Roland", "Riley"]);

    fireEvent.change(picker, { target: { value: "roland" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("office")).toBe("roland");
  });

  it("a failed check says it could not check — no bar, no Done badge — and can retry", async () => {
    fetchMock.mockImplementationOnce(() =>
      okJson({ success: false, error: "Could not check the practice setup right now", code: "SETUP_STATUS_UNAVAILABLE" }, 503),
    );
    renderCard();
    const err = await screen.findByTestId("setup-error");
    expect(err.textContent).toContain("Could not check this office's setup");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByTestId("setup-progress-label")).toBeNull();

    fireEvent.click(within(err).getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("setup-progress-label")).toBeTruthy();
  });

  it("an unreachable server, or an answer of the wrong shape, is an error too", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("network down")));
    renderCard();
    expect((await screen.findByTestId("setup-error")).textContent).toContain("Could not reach the server");
    cleanup();

    fetchMock.mockImplementationOnce(() => okJson({ success: true, office: "valley", steps: [{ id: "P1", status: "green" }] }));
    renderCard();
    expect((await screen.findByTestId("setup-error")).textContent).toContain("does not understand");
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("Go appears only where the viewer could open the screen", () => {
    expect(linkOpens("/admin/users", ADMIN_PROPS)).toBe(true);
    expect(linkOpens("/platform", ADMIN_PROPS)).toBe(false);
    expect(linkOpens("/platform", { ...ADMIN_PROPS, isSuperAdmin: true })).toBe(true);
    // TC settings need the TC module AND tc.full; the hyg day view needs hyg.
    expect(linkOpens("/admin/tc/settings#referrals", { ...ADMIN_PROPS, tenantModules: ["hyg"] })).toBe(false);
    expect(linkOpens("/admin/tc/settings#referrals", { ...ADMIN_PROPS, permissions: ["admin.all"] })).toBe(false);
    expect(linkOpens("/hyg/day", { ...ADMIN_PROPS, tenantModules: ["tc"] })).toBe(false);
    expect(linkOpens("/hyg/day", ADMIN_PROPS)).toBe(true);
  });
});

describe("/admin placement", () => {
  it("renders the card FIRST, in its own section, leaving the Practice settings cards as they were", async () => {
    const { hook } = memoryLocation({ path: "/admin", static: true });
    render(
      <WouterRouter hook={hook}>
        <Admin />
      </WouterRouter>,
    );
    const setup = await screen.findByTestId("admin-practice-setup");
    const practice = screen.getByTestId("admin-practice-settings");
    expect(within(setup).getByTestId("practice-setup-card")).toBeTruthy();
    // Document order: setup precedes the Practice settings group.
    expect(setup.compareDocumentPosition(practice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The setup card's links are not hub cards.
    expect(setup.querySelector("a[data-testid^='admin-link-']")).toBeNull();
    await screen.findByTestId("setup-progress-label");
  });
});
