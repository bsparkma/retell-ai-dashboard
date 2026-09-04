/**
 * AN EMPTY DAY AND A FAILED ONE MUST NEVER LOOK THE SAME.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE TEST THAT MATTERS MOST ON THIS SCREEN
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygienist opens the day view to find out what is about to happen to her all
 * day. If a failure to reach Open Dental renders as "no appointments", she
 * stands down — or walks into a patient she had no warning about. It is the one
 * bug on this page that is dangerous rather than annoying, and it is the one
 * that arrives for free the moment somebody writes `catch { setDay([]) }`.
 *
 * So the four states are asserted to be four DIFFERENT things on screen, by
 * test id, and additionally by the words they use: the failure states say the
 * day did not load, and the empty state says the opposite in as many words.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AND WHY THE THIRD FLAG STATE IS ASSERTED HERE TOO
 * ═════════════════════════════════════════════════════════════════════════════
 * `null` means "we did not find out". Drawn like `false`, it tells somebody
 * about to put instruments in a mouth that a patient needs no premedication
 * when nobody asked. The card's unknown chip therefore carries its own
 * `data-testid`, and is asserted to be present and distinct.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every name below is synthetic and already in
 * the first-name-plus-initial form the committed screenshots use.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { HygAppointment, HygDayResponse } from "@shared/hyg/contract";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

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
    patientName: "Kiwi S.",
    start: "2026-09-08 08:00:00",
    lengthMin: 60,
    opNum: 2,
    opName: "Hygiene 1",
    isHygiene: true,
    opIsHygiene: true,
    provNum: 1,
    provHyg: 7,
    providerName: "HYG1",
    apptTypeLabel: "Prophy Adult",
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: false,
    flags: flags(),
    ...over,
  };
}

export const DAY: HygDayResponse = {
  success: true,
  office: "roland",
  officeName: "Roland Family Dental",
  date: "2026-09-08",
  operatories: [
    { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 },
    { opNum: 3, name: "Hygiene 2", abbrev: "HY2", isHygiene: true, itemOrder: 2 },
  ],
  appointments: [
    appt({ aptNum: 900001, patNum: 12827, patientName: "Kiwi S.", flags: flags({ premed: true }) }),
    appt({
      aptNum: 900002,
      patNum: 12828,
      patientName: "Papaya P.",
      opNum: 3,
      start: "2026-09-08 09:00:00",
      apptTypeLabel: "Perio Maint",
      confirmedStatus: "Unconfirmed",
      flags: flags({ premed: false, medicalAlerts: true }),
    }),
    appt({
      aptNum: 900003,
      patNum: 800003,
      // Every way a card can be missing something, on one card.
      patientName: null,
      lengthMin: null,
      apptTypeLabel: null,
      providerName: null,
      confirmedStatus: null,
      opNum: 3,
      start: "2026-09-08 11:00:00",
      flags: flags(),
    }),
  ],
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
  truncated: false,
  patientNamesTruncated: false,
  stats: {
    odListReads: 4,
    odPatientReads: 1,
    patientsRequested: 1,
    patientCacheHits: 0,
    patientCacheDeduped: 0,
    durationMs: 1200,
  },
};

export const EMPTY_DAY: HygDayResponse = { ...DAY, appointments: [] };

// ─── Mocks ───────────────────────────────────────────────────────────────────

const fixtures = vi.hoisted(() => ({
  /** Resolved value, or a thrown HygApiError. Set per test. */
  day: null as unknown,
  fail: null as unknown,
  /** Never resolves — the loading state. */
  hang: false,
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
    fetchDay: vi.fn(async () => {
      if (fixtures.hang) return new Promise(() => {}) as never;
      if (fixtures.fail) throw fixtures.fail;
      return fixtures.day as HygDayResponse;
    }),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import HygVisit from "@/pages/hyg/HygVisit";
import { HygApiError } from "@/features/hyg/api";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

export function renderAt(ui: React.ReactElement, path: string) {
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
  return memory;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.day = DAY;
  fixtures.fail = null;
  fixtures.hang = false;
});
afterEach(cleanup);

// ─── The four states ─────────────────────────────────────────────────────────

describe("the day view's four states are four different screens", () => {
  it("renders the populated day", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");

    expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(3);
    expect(screen.queryByTestId("hyg-day-empty")).toBeNull();
    expect(screen.queryByTestId("hyg-day-error")).toBeNull();
    expect(screen.queryByTestId("hyg-day-not-ready")).toBeNull();
  });

  it("renders a loading skeleton that is neither empty nor an error", async () => {
    fixtures.hang = true;
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-loading");

    expect(screen.queryByTestId("hyg-day-empty")).toBeNull();
    expect(screen.queryByTestId("hyg-day-error")).toBeNull();
    expect(screen.queryByTestId("hyg-day-columns")).toBeNull();
  });

  it("renders an EMPTY day that says it loaded", async () => {
    fixtures.day = EMPTY_DAY;
    renderAt(<HygDay />, "/hyg/day");
    const empty = await screen.findByTestId("hyg-day-empty");

    // The positive claim is the whole point: this screen says the schedule
    // arrived and nobody is on it, rather than showing nothing and leaving the
    // reader to guess which of two very different things happened.
    expect(empty.textContent).toMatch(/nobody is booked/i);
    expect(empty.textContent).toMatch(/schedule loaded/i);
    expect(screen.queryByTestId("hyg-day-error")).toBeNull();
    expect(screen.queryByTestId("hyg-day-not-ready")).toBeNull();
    expect(screen.queryByTestId("hyg-appointment-card")).toBeNull();
  });

  it("renders an OPEN DENTAL FAILURE that is unmistakably not an empty day", async () => {
    fixtures.fail = new HygApiError(
      "Could not read the schedule from Open Dental",
      502,
      "OD_READ_FAILED",
    );
    renderAt(<HygDay />, "/hyg/day");
    const error = await screen.findByTestId("hyg-day-error");

    expect(error.textContent).toMatch(/did not load/i);
    // In as many words, on the screen, because this is the sentence that stops
    // somebody standing down on a day that has patients on it.
    expect(error.textContent).toMatch(/not an empty day/i);
    expect(screen.queryByTestId("hyg-day-empty")).toBeNull();
    // An outage is the one refusal where retrying is the right thing to offer.
    expect(screen.getByText(/try again/i)).toBeTruthy();
  });

  it("renders OFFICE NOT READY as a setting, with no retry", async () => {
    fixtures.fail = new HygApiError(
      "The hygiene module is not switched on for Riley Family Dental yet",
      409,
      "OFFICE_NOT_READY",
      { reason: "OFFICE_HYG_NOT_ENABLED" },
    );
    renderAt(<HygDay />, "/hyg/day");
    const notReady = await screen.findByTestId("hyg-day-not-ready");

    expect(notReady.textContent).toMatch(/not switched on/i);
    // NO retry button: pressing it can never help, and offering it invites
    // somebody to spend a minute finding that out.
    expect(screen.queryByText(/try again/i)).toBeNull();
    expect(notReady.textContent).toMatch(/retrying will not change this/i);
    expect(screen.queryByTestId("hyg-day-empty")).toBeNull();
    expect(screen.queryByTestId("hyg-day-error")).toBeNull();
  });

  it("distinguishes a missing credential from a switch that is simply off", async () => {
    fixtures.fail = new HygApiError(
      "Open Dental credentials are not configured for Riley Family Dental",
      503,
      "OFFICE_NOT_READY",
      { reason: "OFFICE_OD_KEY_MISSING" },
    );
    renderAt(<HygDay />, "/hyg/day");
    const notReady = await screen.findByTestId("hyg-day-not-ready");

    // The sentence that matters: it will NEVER borrow the other office's key,
    // because a PatNum means a different person in each practice's database.
    expect(notReady.textContent).toMatch(/no Open Dental credentials/i);
    expect(notReady.textContent).toMatch(/never borrow/i);
  });

  it("asks for an office rather than showing an empty day for none", async () => {
    localStorage.setItem("carein.office", "all");
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-pick-office");

    // "All offices" is not a hygiene day. An empty grid here would read as
    // "nobody is booked" for a day nobody has asked for yet.
    expect(screen.queryByTestId("hyg-day-empty")).toBeNull();
    expect(screen.queryByTestId("hyg-day-columns")).toBeNull();
  });
});

// ─── The card ────────────────────────────────────────────────────────────────

describe("the appointment card", () => {
  it("draws an UNKNOWN flag differently from a clear one", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");

    // Every card in the fixture has unread flags, so every card has one.
    expect(screen.getAllByTestId("hyg-flag-unknown").length).toBeGreaterThan(0);
    // And the two cards with a true flag carry an alert chip.
    expect(screen.getAllByTestId("hyg-flag-alert")).toHaveLength(2);
  });

  it("says what it does not know instead of filling it in", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");

    // The third fixture card is missing a name, a length, a type and a provider.
    expect(screen.getByText(/name unavailable/i)).toBeTruthy();
    expect(screen.getByText(/length not recorded/i)).toBeTruthy();
    expect(screen.getByText(/visit type not recorded/i)).toBeTruthy();
    // And no card anywhere claims a default duration.
    expect(screen.queryByText("30 min")).toBeNull();
  });

  it("links every card to its visit", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");

    const links = screen
      .getAllByTestId("hyg-appointment-card")
      .map((el) => el.getAttribute("href"));
    expect(links).toEqual(["/hyg/visit/900001", "/hyg/visit/900002", "/hyg/visit/900003"]);
  });

  it("gives every card a tap target at least 88px tall", async () => {
    // Two Apple minimums stacked. This is used standing at a chair by somebody
    // who has just put down an instrument, not at a desk with a mouse.
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");
    for (const card of screen.getAllByTestId("hyg-appointment-card")) {
      expect(card.className).toMatch(/min-h-\[88px\]/);
    }
  });
});

// ─── Notices ─────────────────────────────────────────────────────────────────

describe("the day says what it could not read", () => {
  it("distinguishes a truncated SCHEDULE from truncated NAMES", async () => {
    fixtures.day = { ...DAY, truncated: true, patientNamesTruncated: true };
    renderAt(<HygDay />, "/hyg/day");
    const notices = await screen.findByTestId("hyg-day-notices");

    // "Appointments are missing" and "some cards have no name" are different
    // sentences with different consequences. One means do not trust the page.
    expect(notices.textContent).toMatch(/appointments are missing/i);
    expect(notices.textContent).toMatch(/every appointment is here/i);
  });

  it("renders the server's own warnings verbatim", async () => {
    fixtures.day = {
      ...DAY,
      warnings: [{ resource: "operatories", message: "Chair names are unavailable." }],
    };
    renderAt(<HygDay />, "/hyg/day");
    const notices = await screen.findByTestId("hyg-day-notices");
    expect(notices.textContent).toContain("Chair names are unavailable.");
  });

  it("shows nothing when the day is whole", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");
    // An empty notices strip on a good day is how the amber one keeps meaning
    // something on a bad one.
    expect(screen.queryByTestId("hyg-day-notices")).toBeNull();
  });
});

// ─── The slice-2 placeholder ─────────────────────────────────────────────────

describe("the visit placeholder", () => {
  it("is an honest dead end, not a 404 and not a blank", async () => {
    // Rendered under the REAL route pattern, not bare: the appointment number
    // comes from useParams, and a test that rendered the component directly
    // would pass with the route pattern misspelled in App.tsx.
    renderAt(<Route path="/hyg/visit/:aptNum" component={HygVisit} />, "/hyg/visit/900001");
    const page = await screen.findByTestId("hyg-visit-placeholder");

    expect(page.textContent).toMatch(/ships in Slice 2/i);
    expect(page.textContent).toContain("900001");
    expect(screen.getByText(/back to the day/i)).toBeTruthy();
  });

  it("shows NO patient details, because it has read no chart", async () => {
    renderAt(<Route path="/hyg/visit/:aptNum" component={HygVisit} />, "/hyg/visit/900001");
    const page = await screen.findByTestId("hyg-visit-placeholder");

    // The day view has the name in memory and passing it through would be
    // trivial. This page has made no request, checked no entitlement and
    // written no audit row — PHI on a screen with no trail behind it is the one
    // thing the platform's audit rule exists to prevent.
    expect(page.textContent).not.toMatch(/Kiwi|Papaya/);
    expect(page.textContent).toMatch(/read a chart/i);
  });
});

// ─── The refresh control ─────────────────────────────────────────────────────

describe("refresh", () => {
  it("re-asks the server rather than re-rendering what it has", async () => {
    const { fetchDay } = await import("@/features/hyg/api");
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-columns");
    const before = vi.mocked(fetchDay).mock.calls.length;

    screen.getByTestId("hyg-day-refresh").click();
    await waitFor(() => {
      expect(vi.mocked(fetchDay).mock.calls.length).toBeGreaterThan(before);
    });
  });
});
