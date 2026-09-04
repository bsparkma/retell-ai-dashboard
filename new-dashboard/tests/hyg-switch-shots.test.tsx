/**
 * Screenshot DUMP for the hygiene pilot switch (Platform Console → Hygiene).
 *
 * Same shape and same reasons as `hyg-shots.test.tsx`: renders the panel into
 * jsdom with fixture data that lives in THIS file and writes the markup to
 * `tests/.shots/hygswitch-*.html`, which `scripts/shoot-hyg-switch.mjs` wraps in
 * the app's real built CSS and photographs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR SHOTS, AT 1280 × 900
 * ─────────────────────────────────────────────────────────────────────────────
 *   hygswitch-01-off        nobody has chosen; every office off, from the floor
 *   hygswitch-02-on         Roland switched on from this console
 *   hygswitch-03-confirm    the turn-on dialog, and what it says starts happening
 *   hygswitch-04-disagree   the database says on and the app setting says off
 *
 * 01 and 02 are the pair a reviewer compares: the source badge and the sentence
 * under each office have to make "off by default" and "turned off by somebody"
 * distinguishable at a glance, and a picture is the only way to check that.
 *
 * 04 is the incident shot. It is the state an operator is in at 2am when they
 * have set an env var and are watching nothing happen, and the panel's job is
 * to tell them why.
 *
 * A DESKTOP width on purpose — unlike the Day View, which is an iPad screen,
 * this console is used at a desk. Shooting it at 1180 would review a layout
 * nobody uses.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Practice names are not patient data.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

vi.mock("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));

const fixtures = vi.hoisted(() => ({
  roland: false,
  valley: false,
  hasRow: false,
  rolandEnv: null as boolean | null,
  rolandEnvRaw: null as string | null,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const state = () => ({
    offices: [
      {
        officeKey: "roland",
        officeName: "Roland Family Dental",
        enabled: fixtures.roland,
        source: (fixtures.hasRow ? "db" : fixtures.rolandEnv !== null ? "env" : "default") as
          | "db"
          | "env"
          | "default",
        db: fixtures.hasRow ? fixtures.roland : null,
        inRow: fixtures.hasRow ? true : null,
        env: fixtures.rolandEnv,
        envVar: "HYG_OD_ENABLED_ROLAND",
        envRaw: fixtures.rolandEnvRaw,
        hardcoded: false,
        disagreesWithEnv:
          fixtures.hasRow && fixtures.rolandEnv !== null && fixtures.rolandEnv !== fixtures.roland,
        ready: fixtures.roland,
        blockedBy: null,
      },
      {
        officeKey: "valley",
        officeName: "Riley Family Dental",
        enabled: fixtures.valley,
        source: (fixtures.hasRow ? "db" : "default") as "db" | "env" | "default",
        db: fixtures.hasRow ? fixtures.valley : null,
        inRow: fixtures.hasRow ? false : null,
        env: null,
        envVar: "HYG_OD_ENABLED_VALLEY",
        envRaw: null,
        hardcoded: false,
        disagreesWithEnv: false,
        ready: fixtures.valley,
        blockedBy: null,
      },
    ],
    setting: {
      policyKnown: true,
      hasRow: fixtures.hasRow,
      updatedAt: fixtures.hasRow ? "2026-09-04T12:00:00.000Z" : null,
      updatedBy: fixtures.hasRow ? "admin@carein.ai" : null,
      settingKey: "hyg_od_enabled",
    },
    controlPlaneError: null,
  });
  return {
    ...real,
    api: {
      ...real.api,
      getHygOffices: vi.fn(async () => state()),
      setHygOfficeEnabled: vi.fn(async () => state()),
    },
  };
});

import HygienePanel from "@/pages/platform/HygienePanel";
import type { Practice } from "@/lib/api";

const OUT = resolve(import.meta.dirname, ".shots");

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

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  fixtures.roland = false;
  fixtures.valley = false;
  fixtures.hasRow = false;
  fixtures.rolandEnv = null;
  fixtures.rolandEnvRaw = null;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("hygiene switch screenshot dumps", () => {
  it("01 — nobody has chosen, so every office is off", async () => {
    render(<HygienePanel practices={PRACTICES} />);
    await screen.findByTestId("hygiene-panel");
    dump("hygswitch-01-off");
  });

  it("02 — Roland switched on from this console", async () => {
    fixtures.roland = true;
    fixtures.hasRow = true;
    render(<HygienePanel practices={PRACTICES} />);
    await screen.findByTestId("hygiene-panel");
    dump("hygswitch-02-on");
  });

  it("03 — the turn-on confirmation, and its blast radius", async () => {
    render(<HygienePanel practices={PRACTICES} />);
    await screen.findByTestId("hygiene-panel");
    fireEvent.click(screen.getByTestId("hyg-switch-roland"));
    await screen.findByTestId("hyg-confirm-blast-radius");
    dump("hygswitch-03-confirm");
  });

  it("04 — the console and the app setting disagree", async () => {
    fixtures.roland = true;
    fixtures.hasRow = true;
    fixtures.rolandEnv = false;
    fixtures.rolandEnvRaw = "false";
    render(<HygienePanel practices={PRACTICES} />);
    await screen.findByTestId("hyg-env-disagrees-roland");
    dump("hygswitch-04-disagree");
  });
});
