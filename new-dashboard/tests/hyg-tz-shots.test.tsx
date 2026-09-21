/**
 * Screenshot DUMP for the timezone fix.
 *
 * Same shooter as the rest of the module — `scripts/shoot-hyg.mjs`, at the
 * iPad's 1180 width, light and dark — writing `tests/.shots/hyg-tz-*.html`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SLICE CHANGES NO LAYOUT, AND THE SHOT IS STILL THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing here is a redesign: not a colour, not a control, not a word of copy.
 * What changed is WHICH DAY the page opens on, and the only place a person can
 * see that is the heading. So the shot is taken with the clock frozen at
 * 01:00 UTC — 8pm Central on the 8th, inside the window the bug lived in — and
 * the heading has to read the 8th.
 *
 * A screenshot of a date is weak evidence on its own, which is why the mocked
 * day route ECHOES the date it was asked for, exactly as the real one does.
 * The heading is therefore the page's own request rendered back, not a fixture
 * asserting itself: if the client had asked UTC for the day, this picture
 * would say the 9th.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The schedule is empty on purpose — the
 * subject is the heading, and cards would only be something else to look at.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { HygDayResponse } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

/** 01:00 UTC on the 9th === 8pm Central on the 8th. */
const EVENING_CENTRAL = new Date("2026-09-09T01:00:00Z");

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    // ECHOES the requested date, like the real route.
    fetchDay: vi.fn(
      async (_office: string, date: string) =>
        ({
          success: true,
          office: "roland",
          officeName: "Roland Family Dental",
          date,
          operatories: [],
          appointments: [],
          warnings: [],
          flagSources: {},
          excludedByStatus: 0,
          scope: "hygiene",
          excludedByScope: 0,
          truncated: false,
          patientNamesTruncated: false,
          identitiesPending: 0,
          stats: {
            odListReads: 1,
            odPatientReads: 0,
            patientsRequested: 0,
            patientCacheHits: 0,
            patientCacheDeduped: 0,
            durationMs: 10,
          },
        }) as HygDayResponse,
    ),
    fetchDayIdentities: vi.fn(async () => new Promise(() => {}) as never),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function renderDay() {
  const memory = memoryLocation({ path: "/hyg/day", record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>
            <Route path="/hyg/day" component={HygDay} />
          </OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(EVENING_CENTRAL);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe.skipIf(!SHOOT)("timezone screenshot dumps", () => {
  it("01 — 8pm Central: the heading is the 8th, not UTC's 9th", async () => {
    renderDay();
    await screen.findByTestId("hyg-day-heading");
    dump("hyg-tz-01-evening-central@1180x820");
  });
});
