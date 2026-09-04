/**
 * The hygiene pilot switch, on screen.
 *
 * The page enforces nothing — every endpoint behind it is `requireSuperAdmin()`-
 * gated server-side and the backend walk lives in
 * `backend/routes/hygPilotSwitch.test.js`. What these tests defend is the ways
 * the SCREEN could lie about a switch that turns real patient data on:
 *
 *   1. Moving the toggle on click instead of on the server's readback, so a
 *      refused write looks like it took.
 *   2. Turning an office ON without naming the blast radius, or putting a
 *      confirmation in front of turning one OFF — the safe direction has to be
 *      the fast one.
 *   3. Showing a green toggle over an office that still cannot serve a day.
 *   4. Hiding what an app setting is doing. The override is one-directional —
 *      `=false` overrules this page, `=true` cannot turn anything on — so those
 *      two must not render as one vague "they disagree".
 *   5. Letting the per-office switch and the per-practice module entitlement
 *      read as the same thing.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Classic JSX runtime global — see tests/module-home.test.tsx for why.
(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const toasts = vi.hoisted(() => ({ errors: [] as string[], successes: [] as string[] }));
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toasts.errors.push(m),
    success: (m: string) => toasts.successes.push(m),
  },
}));

/** The fake control plane: what it holds, and every write it was asked for. */
const server = vi.hoisted(() => ({
  roland: false,
  valley: false,
  hasRow: false,
  policyKnown: true,
  /**
   * Simulates HYG_OD_ENABLED_ROLAND. `false` overrules the stored row and holds
   * the office off; `true` is accepted and can never enable anything.
   */
  rolandEnv: null as boolean | null,
  rolandEnvRaw: null as string | null,
  /** What the VOICE path refuses for roland, independent of the switch. */
  rolandBlocked: null as { code: string; message: string } | null,
  writes: [] as Array<{ office: string; enabled: boolean }>,
  writeError: null as { message: string; code: string } | null,
  controlPlaneError: null as string | null,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();

  const state = () => {
    // The backend's rule, modelled here so the fixtures cannot drift from it: a
    // disabling app setting narrows FIRST and answers; an enabling one is inert.
    const killed = server.rolandEnv === false;
    const rolandOn = !killed && server.roland;
    return {
      offices: [
        {
          officeKey: "roland",
          officeName: "Roland Family Dental",
          enabled: rolandOn,
          source: (killed ? "env" : server.hasRow ? "db" : "default") as
            | "db"
            | "env"
            | "default",
          db: server.hasRow ? server.roland : null,
          inRow: server.hasRow ? true : null,
          env: server.rolandEnv,
          envVar: "HYG_OD_ENABLED_ROLAND",
          envRaw: server.rolandEnvRaw,
          envEffect: (killed ? "disables" : server.rolandEnv === true ? "inert" : null) as
            | "disables"
            | "inert"
            | null,
          hardcoded: false,
          disagreesWithEnv:
            server.hasRow && server.rolandEnv !== null && server.rolandEnv !== server.roland,
          ready: rolandOn && server.rolandBlocked === null,
          blockedBy: server.rolandBlocked,
        },
        {
          officeKey: "valley",
          officeName: "Riley Family Dental",
          enabled: server.valley,
          source: (server.hasRow ? "db" : "default") as "db" | "env" | "default",
          db: server.hasRow ? server.valley : null,
          inRow: server.hasRow ? false : null,
          env: null,
          envVar: "HYG_OD_ENABLED_VALLEY",
          envRaw: null,
          envEffect: null,
          hardcoded: false,
          disagreesWithEnv: false,
          ready: server.valley,
          blockedBy: null,
        },
      ],
      setting: {
        policyKnown: server.policyKnown,
        hasRow: server.hasRow,
        updatedAt: server.hasRow ? "2026-09-04T12:00:00.000Z" : null,
        updatedBy: server.hasRow ? "admin@carein.ai" : null,
        settingKey: "hyg_od_enabled",
      },
      controlPlaneError: server.controlPlaneError,
    };
  };

  return {
    ...real,
    api: {
      ...real.api,
      getHygOffices: vi.fn(async () => state()),
      setHygOfficeEnabled: vi.fn(async (office: string, enabled: boolean) => {
        server.writes.push({ office, enabled });
        if (server.writeError) {
          throw new real.ApiError(server.writeError.message, 500, server.writeError.code);
        }
        // The server's READBACK. The panel renders this, never the value sent.
        if (office === "roland") server.roland = enabled;
        if (office === "valley") server.valley = enabled;
        server.hasRow = true;
        return state();
      }),
    },
  };
});

import HygienePanel, { sourceBlurb } from "@/pages/platform/HygienePanel";
import type { Practice } from "@/lib/api";

const PRACTICES: Practice[] = [
  {
    tenantId: "t1",
    slug: "carein",
    displayName: "CareIN Dental",
    status: "active",
    createdAt: "2026-01-05T00:00:00.000Z",
    userCount: 13,
    modules: [
      { module: "voice", label: "Voice", blurb: "Call worklist", enabled: true },
      { module: "hyg", label: "Hygiene", blurb: "Hygiene day view", enabled: true },
    ],
  },
  {
    tenantId: "t2",
    slug: "smith",
    displayName: "Smith Dental",
    status: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    userCount: 4,
    modules: [
      { module: "voice", label: "Voice", blurb: "Call worklist", enabled: true },
      { module: "hyg", label: "Hygiene", blurb: "Hygiene day view", enabled: false },
    ],
  },
];

beforeEach(() => {
  server.roland = false;
  server.valley = false;
  server.hasRow = false;
  server.policyKnown = true;
  server.rolandEnv = null;
  server.rolandEnvRaw = null;
  server.rolandBlocked = null;
  server.writes = [];
  server.writeError = null;
  server.controlPlaneError = null;
  toasts.errors = [];
  toasts.successes = [];
});

// This project does not enable testing-library auto-cleanup; without this every
// test after the first renders a SECOND panel and every query finds two.
afterEach(cleanup);

async function renderPanel() {
  render(<HygienePanel practices={PRACTICES} />);
  await screen.findByTestId("hygiene-panel");
}

describe("turning an office on", () => {
  it("confirms first, and names what starts happening to real patient data", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId("hyg-switch-roland"));

    // The click opens a dialog and writes NOTHING yet.
    const blast = await screen.findByTestId("hyg-confirm-blast-radius");
    expect(server.writes).toHaveLength(0);

    // Turning this on is what starts a practice's charts being read. The dialog
    // has to say so in those words, not "enable hygiene?".
    expect(blast.textContent).toContain("real patient data");
    expect(blast.textContent).toContain("Open Dental");
    expect(blast.textContent).toContain("morning warm");
    expect(blast.textContent).toContain("Roland Family Dental");
  });

  it("writes only after the confirmation, and renders the server's readback", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId("hyg-switch-roland"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-accept"));

    await waitFor(() => expect(server.writes).toEqual([{ office: "roland", enabled: true }]));
    await waitFor(() =>
      expect(screen.getByTestId("hyg-switch-roland").getAttribute("data-state")).toBe("checked"),
    );
    // The source badge moved to `db` because the DATABASE now answers — the
    // panel learned that from the readback, not from the click.
    expect(screen.getByTestId("hyg-source-roland").textContent).toBe("db");
    expect(screen.getByTestId("hyg-switch-valley").getAttribute("data-state")).toBe("unchecked");
  });

  it("leaves the toggle where the SERVER says when a write is refused", async () => {
    server.writeError = { message: "Could not save the hygiene switch", code: "HYG_SWITCH_WRITE_FAILED" };
    await renderPanel();

    fireEvent.click(screen.getByTestId("hyg-switch-roland"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-accept"));

    await waitFor(() => expect(toasts.errors.length).toBe(1));
    // A refused write must not look like it took.
    expect(screen.getByTestId("hyg-switch-roland").getAttribute("data-state")).toBe("unchecked");
  });
});

describe("turning an office off", () => {
  it("is immediate — no confirmation stands between a problem and the fix", async () => {
    // 9am, patient in the chair. A dialog here is a dialog somebody reads while
    // that patient waits.
    server.roland = true;
    server.hasRow = true;
    await renderPanel();

    fireEvent.click(screen.getByTestId("hyg-switch-roland"));

    await waitFor(() => expect(server.writes).toEqual([{ office: "roland", enabled: false }]));
    expect(screen.queryByTestId("hyg-confirm-blast-radius")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("hyg-switch-roland").getAttribute("data-state")).toBe("unchecked"),
    );
  });
});

describe("saying honestly why a switch reads the way it does", () => {
  it("names the layer that answered", async () => {
    await renderPanel();
    expect(screen.getByTestId("hyg-source-roland").textContent).toBe("default");
    expect(screen.getByTestId("hyg-blurb-roland").textContent).toContain("off by default");

    // Three different facts, three different sentences.
    const setting = { policyKnown: true, hasRow: true, updatedAt: "2026-09-04T12:00:00.000Z", updatedBy: "admin@carein.ai", settingKey: "hyg_od_enabled" };
    const base = {
      officeKey: "roland", officeName: "Roland Family Dental", envVar: "HYG_OD_ENABLED_ROLAND",
      envRaw: null, envEffect: null, hardcoded: false, disagreesWithEnv: false, ready: true,
      blockedBy: null, inRow: true,
    };
    expect(sourceBlurb({ ...base, enabled: true, source: "db", db: true, env: null }, setting)).toContain(
      "Turned on by admin@carein.ai",
    );
    expect(sourceBlurb({ ...base, enabled: false, source: "db", db: false, env: null }, setting)).toContain(
      "Turned off by admin@carein.ai",
    );
    // `env` can only ever be the answer by holding an office OFF.
    const byEnv = sourceBlurb(
      { ...base, enabled: false, source: "env", db: null, env: false, envEffect: "disables" },
      setting,
    );
    expect(byEnv).toContain("HYG_OD_ENABLED_ROLAND");
    expect(byEnv).toContain("off");

    // An office ABSENT from the stored row is off for the same reason and by
    // NOBODY'S decision. Putting a person's name and a date on that would be
    // the panel inventing a history, and it read exactly that way in the first
    // screenshot of this feature.
    const absent = sourceBlurb(
      { ...base, inRow: false, enabled: false, source: "db", db: false, env: null },
      setting,
    );
    expect(absent).toContain("does not name this office");
    expect(absent).not.toContain("admin@carein.ai");
  });

  it("says when an app setting is holding an office off, and that this page cannot lift it", async () => {
    // The console says on; break-glass says off. Break-glass wins, because it
    // only ever narrows — so the toggle here is not the fix and must not
    // pretend to be.
    server.hasRow = true;
    server.roland = true;
    server.rolandEnv = false;
    server.rolandEnvRaw = "false";
    await renderPanel();

    const note = screen.getByTestId("hyg-env-disables-roland");
    expect(note.textContent).toContain("HYG_OD_ENABLED_ROLAND");
    expect(note.textContent).toContain("whatever this console says");
    expect(note.textContent).toContain("this console says on");
    // The effective state is OFF, and the toggle shows the effective state.
    expect(screen.getByTestId("hyg-switch-roland").getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByTestId("hyg-source-roland").textContent).toBe("env");
    expect(screen.queryByTestId("hyg-env-disables-valley")).toBeNull();
  });

  it("says when an app setting meant to turn hygiene ON is doing nothing", async () => {
    // Somebody set it during an incident, expecting an effect. Silence here
    // leaves them watching the module stay dark with no explanation anywhere.
    server.rolandEnv = true;
    server.rolandEnvRaw = "true";
    await renderPanel();

    const note = screen.getByTestId("hyg-env-inert-roland");
    expect(note.textContent).toContain("HYG_OD_ENABLED_ROLAND");
    expect(note.textContent).toContain("doing");
    expect(note.textContent).toContain("only turn an office");
    // And it is NOT reported as the layer that answered.
    expect(screen.getByTestId("hyg-source-roland").textContent).toBe("default");
    expect(screen.getByTestId("hyg-switch-roland").getAttribute("data-state")).toBe("unchecked");
  });

  it("says when an env var is set to something that is not a boolean", async () => {
    server.rolandEnvRaw = "yes";
    server.rolandEnv = null;
    await renderPanel();

    const note = screen.getByTestId("hyg-env-unparseable-roland");
    expect(note.textContent).toContain("yes");
    expect(note.textContent).toContain("being ignored");
  });

  it("never shows a green toggle over an office that still cannot serve a day", async () => {
    server.hasRow = true;
    server.roland = true;
    server.rolandBlocked = {
      code: "OFFICE_OD_KEY_MISSING",
      message: "Open Dental credentials are not configured for Roland Family Dental",
    };
    await renderPanel();

    const blocked = screen.getByTestId("hyg-blocked-roland");
    expect(blocked.textContent).toContain("still cannot serve a day");
    expect(blocked.textContent).toContain("OFFICE_OD_KEY_MISSING");
  });

  it("says when the control plane has never been readable, and that everything is off", async () => {
    server.policyKnown = false;
    server.controlPlaneError = "control plane unreachable";
    await renderPanel();

    expect(screen.getByTestId("hyg-policy-unknown").textContent).toContain("every office is off");
    expect(screen.getByTestId("hygiene-panel").textContent).toContain("control plane unreachable");
  });
});

describe("the two axes", () => {
  it("shows the module entitlement beside the switch, and does not let it be flipped here", async () => {
    await renderPanel();

    // Entitlement is per PRACTICE; the switch is per OFFICE. Both are visible,
    // and only one of them is editable on this tab.
    expect(screen.getByTestId("hyg-entitlement-carein").textContent).toBe("entitled");
    expect(screen.getByTestId("hyg-entitlement-smith").textContent).toBe("not entitled");

    const panel = screen.getByTestId("hygiene-panel");
    expect(panel.textContent).toContain("Did the practice buy hygiene?");
    expect(panel.textContent).toContain("Is hygiene live at this office?");
    expect(panel.textContent).toContain("different question");
    // The only switches on the tab are the per-office ones.
    expect(screen.queryByTestId("module-switch-hyg")).toBeNull();
  });

  it("flipping one office leaves the other alone", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId("hyg-switch-valley"));
    fireEvent.click(await screen.findByTestId("hyg-confirm-accept"));

    await waitFor(() => expect(server.writes).toEqual([{ office: "valley", enabled: true }]));
    await waitFor(() =>
      expect(screen.getByTestId("hyg-switch-valley").getAttribute("data-state")).toBe("checked"),
    );
    expect(screen.getByTestId("hyg-switch-roland").getAttribute("data-state")).toBe("unchecked");
  });
});
