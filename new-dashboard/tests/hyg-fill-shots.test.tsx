/**
 * Screenshot DUMP for progressive fill.
 *
 * Same shooter as the rest of the module — `scripts/shoot-hyg.mjs`, at the
 * iPad's 1180 width — writing `tests/.shots/hyg-fill-*.html`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE SHOTS, AND WHY THESE THREE
 * ─────────────────────────────────────────────────────────────────────────────
 *   hyg-fill-01-painting   the second the schedule lands. Every card in its
 *                          chair at its time, and four of them saying honestly
 *                          that they do not know who is in them YET. This is
 *                          the shot the whole slice is for: it used to be a
 *                          blank skeleton for forty seconds.
 *   hyg-fill-02-half       mid-fill. The first two names have arrived and the
 *                          rest are still coming — the state a hygienist
 *                          actually watches, and the one where "loading" and
 *                          "unavailable" must not look alike.
 *   hyg-fill-03-failed     the names did not load and THE SCHEDULE DID. Its
 *                          own banner, its own retry, Open Dental's own status
 *                          line under the sentence, and the cards settled to
 *                          "Name unavailable" rather than shimmering at
 *                          nothing.
 *
 * 03 is the one to review hardest. "Loading the schedule fails at times" was
 * the field report, and this is the screen that has to turn that sentence into
 * something somebody can act on without a log query.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name is synthetic.
 *
 * Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  HygAppointment,
  HygDayIdentitiesResponse,
  HygDayResponse,
} from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const fixtures = vi.hoisted(() => ({
  day: null as unknown,
  fills: [] as unknown[],
  fillFail: null as unknown,
  /**
   * From this batch onward the fill never answers. `0` hangs the first one.
   *
   * It is what holds a mid-fill shot STILL: without it the mock repeats its
   * last response, the loop sees no progress, and the page correctly settles
   * every remaining card to "Name unavailable" — the right behaviour, and the
   * wrong screen to photograph for "the names are still arriving".
   */
  hangFrom: Infinity as number,
  calls: 0,
}));

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchDay: vi.fn(async () => fixtures.day as HygDayResponse),
    fetchDayIdentities: vi.fn(async () => {
      const at = fixtures.calls;
      fixtures.calls += 1;
      if (at >= fixtures.hangFrom) return new Promise(() => {}) as never;
      if (fixtures.fillFail) throw fixtures.fillFail;
      return fixtures.fills[Math.min(at, fixtures.fills.length - 1)] as HygDayIdentitiesResponse;
    }),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import { HygApiError } from "@/features/hyg/api";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const OUT = resolve(import.meta.dirname, ".shots");

function flags(over: Partial<HygAppointment["flags"]> = {}): HygAppointment["flags"] {
  return {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
    ...over,
  };
}

function appt(over: Partial<HygAppointment> = {}): HygAppointment {
  return {
    aptNum: 900001,
    patNum: 12827,
    identity: "pending",
    patientName: null,
    start: "2026-09-08 08:00:00",
    lengthMin: 60,
    opNum: 2,
    opName: "Hygiene 1",
    isHygiene: true,
    opIsHygiene: true,
    provNum: 1,
    provHyg: 7,
    providerName: "Raegan",
    apptTypeLabel: "Prophy Adult",
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: false,
    flags: flags(),
    ...over,
  };
}

/** Four appointments, none of them named yet — the first paint. */
const UNNAMED: HygAppointment[] = [
  appt(),
  appt({
    aptNum: 900002,
    patNum: 12828,
    start: "2026-09-08 09:00:00",
    apptTypeLabel: "Perio maintenance",
  }),
  appt({
    aptNum: 900003,
    patNum: 990010,
    start: "2026-09-08 10:30:00",
    opNum: 3,
    opName: "Hygiene 2",
    providerName: "Casey",
    apptTypeLabel: "Prophy Child",
  }),
  appt({
    aptNum: 900004,
    patNum: 990011,
    start: "2026-09-08 13:00:00",
    opNum: 3,
    opName: "Hygiene 2",
    providerName: "Casey",
    confirmedStatus: "Unconfirmed",
  }),
];

function day(over: Partial<HygDayResponse> = {}): HygDayResponse {
  return {
    success: true,
    office: "roland",
    officeName: "Roland Family Dental",
    date: "2026-09-08",
    operatories: [
      { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 },
      { opNum: 3, name: "Hygiene 2", abbrev: "HY2", isHygiene: true, itemOrder: 2 },
    ],
    appointments: UNNAMED,
    warnings: [],
    flagSources: {
      premed: "od",
      medicalAlerts: "od",
      allergies: "not_read",
      lastPerioDate: "not_read",
      xraysDue: "not_read",
      examNeeded: "not_read",
      openTcCase: "not_read",
    },
    excludedByStatus: 0,
    scope: "hygiene",
    excludedByScope: 0,
    truncated: false,
    patientNamesTruncated: false,
    identitiesPending: 4,
    stats: {
      odListReads: 4,
      odPatientReads: 0,
      patientsRequested: 4,
      patientCacheHits: 0,
      patientCacheDeduped: 0,
      durationMs: 3100,
      phaseMs: { appointments: 1100, operatories: 1000, labels: 950, identities: 2 },
    },
    ...over,
  };
}

function fill(over: Partial<HygDayIdentitiesResponse> = {}): HygDayIdentitiesResponse {
  return {
    success: true,
    office: "roland",
    date: "2026-09-08",
    scope: "hygiene",
    patients: [],
    unavailable: [],
    pending: 0,
    stats: day().stats,
    ...over,
  };
}

function renderAt(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>{ui}</OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.day = day();
  fixtures.fills = [fill()];
  fixtures.fillFail = null;
  fixtures.hangFrom = Infinity;
  fixtures.calls = 0;
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("hyg fill screenshot dumps", () => {
  it("01 — the schedule, painted, waiting on every name", async () => {
    fixtures.hangFrom = 0;
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-list");
    await screen.findAllByTestId("hyg-name-pending");
    dump("hyg-fill-01-painting");
  });

  it("02 — half the names have arrived", async () => {
    fixtures.fills = [
      fill({
        patients: [
          { patNum: 12827, patientName: "Kiwi, Sam", premed: true, medicalAlerts: null },
          { patNum: 12828, patientName: "Papaya, Jo", premed: false, medicalAlerts: null },
        ],
        pending: 2,
      }),
    ];
    // The SECOND batch never answers, so the shot holds the mixed state: two
    // names in, two still shimmering. That is the screen a hygienist watches.
    fixtures.hangFrom = 1;
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByText("Kiwi, Sam");
    await screen.findAllByTestId("hyg-name-pending");
    dump("hyg-fill-02-half");
  });

  it("03 — the schedule loaded and the names did not", async () => {
    fixtures.fillFail = new HygApiError(
      "Could not read patient names from Open Dental",
      502,
      "OD_READ_FAILED",
      { phase: "identities", detail: "HTTP 504 after 30000ms" },
    );
    fixtures.day = day({
      warnings: [
        {
          resource: "operatories",
          message: "Chair names are unavailable.",
          detail: "HTTP 504",
        },
      ],
    });
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-fill-error");
    // Settled: no card is claiming a request is still on its way.
    await waitFor(() => {
      if (document.querySelector('[data-testid="hyg-name-pending"]')) {
        throw new Error("still shimmering");
      }
    });
    dump("hyg-fill-03-failed");
  });
});
