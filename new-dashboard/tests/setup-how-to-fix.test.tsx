/**
 * Setup polish — /admin → Practice setup → "How to fix".
 *
 *   1  every step that is not done has a "How to fix" button; a done step has none
 *   2  it opens a panel with the step's CURRENT detail line from the API, 2–4
 *      plain steps from the one frontend map, and the step's existing Go link
 *   3  the panel stays open while the page behind it is used (not modal); Esc
 *      closes it; "Check again" re-reads and the detail line follows
 *   4  at 390px it is a bottom sheet; on a wide screen, a side panel
 *   5  P8 (hygiene note templates): no Go anywhere, and the panel explains the
 *      "(draft)" label, that the practice cannot change it here yet, and that
 *      the reviewed wording goes to CareIN support
 *   6  the map: an entry for every step the server can send, each 2–4 steps
 *
 * NO BACKEND: fetch is stubbed. Config only — no patient data in fixtures.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/lib/api", () => ({ handleUnauthorized: () => {}, api: {} }));

import PracticeSetupCard, { type PracticeSetupCardProps } from "@/pages/admin/PracticeSetupCard";
import { HOW_TO_FIX } from "@/pages/admin/setupHowToFix";

const PROPS: PracticeSetupCardProps = {
  homeOffice: "roland",
  permissions: ["admin.all", "tc.full", "hyg.read"],
  tenantModules: ["tc", "hyg"],
  isSuperAdmin: false,
};

const P1_MISSING = "Missing for the letterhead: address.";
const P1_DONE = "Display name, address and phone are all set for the letterhead.";

function answer({ p1Done = false } = {}) {
  return {
    success: true,
    office: "roland",
    officeName: "Roland",
    offices: [
      { officeId: "roland", officeName: "Roland" },
      { officeId: "valley", officeName: "Riley" },
    ],
    steps: [
      { id: "P1", title: "Office details", required: true, status: p1Done ? "done" : "needs_attention", detail: p1Done ? P1_DONE : P1_MISSING, link: "/admin/tc/settings#email_identity" },
      { id: "P2", title: "Team & roles", required: true, status: "done", detail: "Active across the practice: 1 admin, 1 TC.", link: "/admin/users" },
      { id: "P6", title: "Print templates", required: true, status: "needs_attention", detail: "School / work excuse: default wording, no logo.", link: "/admin/print-templates" },
      { id: "P8", title: "Hygiene note templates", required: true, status: "needs_attention", detail: '4 of 9 visit types are still marked "(draft)", awaiting the practice hygienist\'s approval.', link: "/hyg/day" },
    ],
    doneRequired: p1Done ? 2 : 1,
    totalRequired: 4,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let width = 1280;

function okJson(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

/** A matchMedia that answers min-width queries from `width`. */
function stubViewport(w: number) {
  width = w;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  });
}

beforeEach(() => {
  fetchMock = vi.fn(() => okJson(answer()));
  vi.stubGlobal("fetch", fetchMock);
  stubViewport(1280);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard() {
  const { hook } = memoryLocation({ path: "/admin", static: true });
  return render(
    <WouterRouter hook={hook}>
      <PracticeSetupCard {...PROPS} />
      <button type="button" data-testid="behind-the-panel">
        Something else on the page
      </button>
    </WouterRouter>,
  );
}

async function openHelp(id: string) {
  renderCard();
  fireEvent.click(await screen.findByTestId(`setup-howto-${id}`));
  return screen.findByTestId("setup-howto-panel");
}

describe("How to fix", () => {
  it("1: only a step that is not done offers it", async () => {
    renderCard();
    await screen.findByTestId("setup-progress-label");
    expect(screen.getByTestId("setup-howto-P1")).toBeTruthy();
    expect(screen.getByTestId("setup-howto-P6")).toBeTruthy();
    expect(screen.getByTestId("setup-howto-P8")).toBeTruthy();
    expect(screen.queryByTestId("setup-howto-P2")).toBeNull();
    expect(screen.queryByTestId("setup-howto-panel")).toBeNull();
  });

  it("2: the panel shows the API's detail line, the plain steps, and the step's Go", async () => {
    const panel = await openHelp("P1");
    expect(within(panel).getByText("How to fix: Office details")).toBeTruthy();
    expect(within(panel).getByTestId("setup-howto-detail").textContent).toBe(P1_MISSING);
    const steps = within(panel).getAllByRole("listitem").map((li) => li.textContent);
    expect(steps).toEqual([...(HOW_TO_FIX.P1?.steps ?? [])]);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.some((s) => s?.includes("practice address"))).toBe(true);
    expect(within(panel).getByTestId("setup-howto-go").getAttribute("href")).toBe("/admin/tc/settings#email_identity");
  });

  it("3: stays open while the page is used; Esc closes; Check again re-reads and the detail follows", async () => {
    const panel = await openHelp("P6");
    // Using the page behind it does not close it (not modal).
    const behind = screen.getByTestId("behind-the-panel");
    fireEvent.pointerDown(behind);
    fireEvent.mouseDown(behind);
    fireEvent.click(behind);
    fireEvent.focus(behind);
    expect(screen.getByTestId("setup-howto-panel")).toBe(panel);
    // The rest of the card stays usable: another step's button still works.
    fireEvent.click(screen.getByTestId("setup-howto-P1"));
    expect(within(await screen.findByTestId("setup-howto-panel")).getByTestId("setup-howto-detail").textContent).toBe(P1_MISSING);

    // Fixed elsewhere: Check again re-reads; a step that is now done closes its panel.
    fetchMock.mockImplementation(() => okJson(answer({ p1Done: true })));
    fireEvent.click(screen.getByTestId("setup-howto-recheck"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("setup-howto-panel")).toBeNull());
    expect(screen.getByTestId("setup-step-P1").getAttribute("data-status")).toBe("done");

    // Esc closes an open panel.
    fireEvent.click(screen.getByTestId("setup-howto-P6"));
    const again = await screen.findByTestId("setup-howto-panel");
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("setup-howto-panel")).toBeNull());
  });

  it("4: at 390px it is a bottom sheet that fits the screen; wide, a side panel", async () => {
    stubViewport(390);
    let panel = await openHelp("P1");
    expect(panel.getAttribute("data-side")).toBe("bottom");
    expect(panel.className).toContain("inset-x-0");
    expect(panel.className).toContain("bottom-0");
    expect(panel.className).toContain("max-h-[85vh]");
    expect(panel.className).toContain("overflow-y-auto");
    expect(within(panel).getByTestId("setup-howto-go")).toBeTruthy();
    expect(within(panel).getAllByRole("listitem").length).toBe(HOW_TO_FIX.P1?.steps.length);
    cleanup();

    stubViewport(1280);
    panel = await openHelp("P1");
    expect(panel.getAttribute("data-side")).toBe("right");
  });

  it("5: P8 has no Go (row or panel) and explains the draft label and who clears it", async () => {
    const panel = await openHelp("P8");
    expect(within(panel).queryByTestId("setup-howto-go")).toBeNull();
    expect(screen.queryByTestId("setup-go-P8")).toBeNull();
    for (const a of screen.queryAllByRole("link", { hidden: true })) expect(a.getAttribute("href")).not.toBe("/hyg/day");

    const text = within(panel).getByTestId("setup-howto-steps").textContent ?? "";
    expect(text).toContain("“(draft)” label means the note wording for that visit type is waiting for your practice's hygienist to approve it");
    expect(text).toContain("can't change that wording here yet");
    expect(text).toContain("send the reviewed wording to CareIN support");
    expect(text).toContain("clears the “(draft)” label");
    expect(within(panel).getByTestId("setup-howto-detail").textContent).toContain('still marked "(draft)"');
  });

  it("6: the map covers every step the server sends, each with 2–4 plain steps and no setting names", async () => {
    const ids = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];
    expect(Object.keys(HOW_TO_FIX).sort()).toEqual(ids);
    for (const id of ids) {
      const entry = HOW_TO_FIX[id];
      expect(entry, id).toBeTruthy();
      expect(entry?.steps.length, id).toBeGreaterThanOrEqual(2);
      expect(entry?.steps.length, id).toBeLessThanOrEqual(4);
      for (const s of entry?.steps ?? []) expect(s, id).not.toMatch(/[A-Z]{2,}_[A-Z_]+|platform_setting|tc_[a-z_]+/);
    }
    expect(HOW_TO_FIX.P8?.go).toBe(false);
    expect(ids.filter((id) => HOW_TO_FIX[id]?.go === false)).toEqual(["P8"]);
    await act(async () => undefined);
  });
});
