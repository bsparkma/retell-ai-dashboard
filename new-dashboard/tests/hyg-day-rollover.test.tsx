/**
 * "TODAY" IS A CENTRAL TIME QUESTION, AND THE IPAD IS NEVER CLOSED.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO FAILURES, ONE SYMPTOM
 * ═════════════════════════════════════════════════════════════════════════════
 * Both put the wrong day on screen under the right-looking heading, which is
 * the worst way for a date to be wrong — nothing about it looks broken.
 *
 *   1. THE ZONE. The day the page asks for must be the OFFICE's calendar date.
 *      Resolved from the device's clock instead, a tablet east of Central shows
 *      tomorrow's schedule in the evening and one west of it shows yesterday's
 *      after midnight. The whole suite below runs at 01:00 UTC — 8pm Central
 *      the day before — which is the window both CI and a hygienist working
 *      late actually land in.
 *
 *   2. THE MOUNT. The date is chosen once, when the page mounts. This module
 *      is built for an iPad propped at a chair and that device is not shut
 *      down at night, so a page opened on Monday is still showing Monday on
 *      Tuesday morning.
 *
 * The mocked day route ECHOES the date it was asked for, exactly as the real
 * one does — so what the heading says is genuinely what the page requested,
 * rather than a fixture asserting itself.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { HygDayResponse } from "@shared/hyg/contract";
import { formatDayHeading } from "@/features/hyg/day";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

/** 01:00 UTC on the 9th === 8pm Central on the 8th. */
const EVENING_CENTRAL = new Date("2026-09-09T01:00:00Z");
/** 05:00 UTC on the 9th === midnight Central, the instant the day rolls. */
const MIDNIGHT_CENTRAL = new Date("2026-09-09T05:00:00Z");

const fixtures = vi.hoisted(() => ({
  /** Every date the page has asked the server for, in order. */
  asked: [] as string[],
}));

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
    // ECHOES the requested date, like the real route. The heading therefore
    // reports what this page actually asked for.
    fetchDay: vi.fn(async (_office: string, date: string) => {
      fixtures.asked.push(date);
      return {
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
      } as HygDayResponse;
    }),
    fetchDayIdentities: vi.fn(async () => new Promise(() => {}) as never),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

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

/** The date the page most recently asked the server for. */
function lastAsked(): string | undefined {
  return fixtures.asked[fixtures.asked.length - 1];
}

/** Every DISTINCT date this page has asked for. Order-free, retry-proof. */
function askedDates(): string[] {
  return [...new Set(fixtures.asked)];
}

/**
 * The day heading, as one string.
 *
 * It is built from two adjacent text nodes — the date and the office name — so
 * a plain text query finds neither half. Reading the paragraph's textContent is
 * what a person looking at the screen actually does.
 */
async function heading(): Promise<string> {
  const el = await screen.findByTestId("hyg-day-heading");
  return el.textContent ?? "";
}

/**
 * Assert the heading is the heading for this date, without pinning a locale.
 *
 * `formatDayHeading` renders in the DEVICE's locale on purpose — "8 September"
 * here, "September 8" there — so a literal expectation would pass or fail on
 * where the suite ran, which is the exact class of bug this slice is about.
 * The claim being made here is WHICH DAY is on screen, not how it is spelled,
 * so the expectation is built with the same formatter the page uses.
 */
async function expectHeadingFor(isoDate: string) {
  expect(await heading()).toContain(formatDayHeading(isoDate));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.asked = [];
  // `shouldAdvanceTime` keeps promises and React's scheduler moving while the
  // clock is ours; without it the first `await` never settles.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(EVENING_CENTRAL);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("the day the page opens on", () => {
  it("is the OFFICE's day at 8pm Central, not UTC's tomorrow", async () => {
    renderDay();
    await waitFor(() => expect(fixtures.asked.length).toBeGreaterThan(0));

    // The bug: UTC has already rolled to the 9th, and asking for the 9th would
    // hand a hygienist tomorrow's schedule while she is still working today's.
    expect(lastAsked()).toBe("2026-09-08");
    await expectHeadingFor("2026-09-08");
  });
});

describe("the office day rolling over under an open page", () => {
  it("moves a page that was sitting on what USED to be today", async () => {
    renderDay();
    await waitFor(() => expect(lastAsked()).toBe("2026-09-08"));

    // The iPad sits on the counter through midnight. Nobody touches it, so no
    // visibility or focus event ever fires — only the interval can notice.
    vi.setSystemTime(MIDNIGHT_CENTRAL);
    await vi.advanceTimersByTimeAsync(61_000);

    await waitFor(() => expect(lastAsked()).toBe("2026-09-09"));
    await expectHeadingFor("2026-09-09");
  });

  it("NEVER moves a date the hygienist stepped to herself", async () => {
    renderDay();
    await waitFor(() => expect(lastAsked()).toBe("2026-09-08"));

    // She steps forward to look at tomorrow's book.
    (await screen.findByLabelText("Next day")).click();
    await waitFor(() => expect(lastAsked()).toBe("2026-09-09"));

    // Midnight passes. Her chosen day must not be snatched back — moving a
    // date somebody picked is a worse bug than the one this closes.
    vi.setSystemTime(MIDNIGHT_CENTRAL);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(lastAsked()).toBe("2026-09-09");
    // And nothing pulled her back to the 8th at any point after she stepped.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(lastAsked()).toBe("2026-09-09");
  });

  it("does nothing at all while the office day has not changed", async () => {
    renderDay();
    await waitFor(() => expect(lastAsked()).toBe("2026-09-08"));

    // Four hours of evening pass, right up to one minute before the Central
    // midnight. The page must not move off the 8th — asserted on the DATES it
    // asked for rather than on a call count, which the office context settling
    // can legitimately bump.
    // Note that advancing the timers advances the mocked clock too, so this
    // has to LAND before 05:00 UTC, not merely start before it.
    vi.setSystemTime(new Date("2026-09-09T02:00:00Z"));
    await vi.advanceTimersByTimeAsync(120 * 60_000);

    expect(askedDates()).toEqual(["2026-09-08"]);
  });
});
