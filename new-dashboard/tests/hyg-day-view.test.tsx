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
    identity: "resolved",
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
      // ASKED, AND OPEN DENTAL WOULD NOT ANSWER. Distinct from "still
      // loading", which is what the fill tests below are about.
      identity: "unavailable",
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
  scope: "hygiene",
  excludedByScope: 0,
  truncated: false,
  patientNamesTruncated: false,
  identitiesPending: 0,
  stats: {
    odListReads: 4,
    odPatientReads: 1,
    patientsRequested: 1,
    patientCacheHits: 0,
    patientCacheDeduped: 0,
    durationMs: 1200,
    phaseMs: { appointments: 900, operatories: 100, labels: 150, identities: 50 },
  },
};

/** The same day as it arrives now: painted, and waiting on two names. */
export const UNNAMED_DAY: HygDayResponse = {
  ...DAY,
  appointments: [
    appt({ aptNum: 900001, patNum: 12827, identity: "pending", patientName: null }),
    appt({
      aptNum: 900002,
      patNum: 12828,
      identity: "pending",
      patientName: null,
      opNum: 3,
      start: "2026-09-08 09:00:00",
    }),
  ],
  identitiesPending: 2,
};

export const EMPTY_DAY: HygDayResponse = { ...DAY, appointments: [] };

// ─── Mocks ───────────────────────────────────────────────────────────────────

const fixtures = vi.hoisted(() => ({
  /** Resolved value, or a thrown HygApiError. Set per test. */
  day: null as unknown,
  fail: null as unknown,
  /** Never resolves — the loading state. */
  hang: false,
  /** Each fill response in turn. The last one repeats. */
  fills: [] as unknown[],
  /** Thrown by every fill. */
  fillFail: null as unknown,
  /** The fill never answers — the "still loading" state, held still. */
  fillHang: false,
  /** How many times the page asked for names. The loop's stop is asserted on it. */
  fillCalls: 0,
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
    fetchDayIdentities: vi.fn(async () => {
      const at = fixtures.fillCalls;
      fixtures.fillCalls += 1;
      if (fixtures.fillHang) return new Promise(() => {}) as never;
      if (fixtures.fillFail) throw fixtures.fillFail;
      const list = fixtures.fills;
      return (list[Math.min(at, list.length - 1)] ?? {
        success: true,
        office: "roland",
        date: "2026-09-08",
        scope: "hygiene",
        patients: [],
        unavailable: [],
        pending: 0,
        stats: DAY.stats,
      }) as HygDayIdentitiesResponse;
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
  fixtures.fills = [];
  fixtures.fillFail = null;
  fixtures.fillHang = false;
  fixtures.fillCalls = 0;
});
afterEach(cleanup);

// ─── The four states ─────────────────────────────────────────────────────────

describe("the day view's four states are four different screens", () => {
  it("renders the populated day", async () => {
    renderAt(<HygDay />, "/hyg/day");
    // THE LIST IS THE DEFAULT as of the hygiene lens: the paper routing slip is
    // a list and a hygienist reads her day forwards in time. The column grid is
    // one tap away, and its own test is below.
    await screen.findByTestId("hyg-day-list");

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
    expect(screen.queryByTestId("hyg-day-list")).toBeNull();
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
    expect(screen.queryByTestId("hyg-day-list")).toBeNull();
  });
});

// ─── The card ────────────────────────────────────────────────────────────────

describe("the appointment card", () => {
  it("draws an UNKNOWN flag differently from a clear one", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-list");

    // Every card in the fixture has unread flags, so every card has one.
    expect(screen.getAllByTestId("hyg-flag-unknown").length).toBeGreaterThan(0);
    // And the two cards with a true flag carry an alert chip.
    expect(screen.getAllByTestId("hyg-flag-alert")).toHaveLength(2);
  });

  it("says what it does not know instead of filling it in", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-list");

    // The third fixture card is missing a name, a length, a type and a provider.
    expect(screen.getByText(/name unavailable/i)).toBeTruthy();
    expect(screen.getByText(/length not recorded/i)).toBeTruthy();
    expect(screen.getByText(/visit type not recorded/i)).toBeTruthy();
    // And no card anywhere claims a default duration.
    expect(screen.queryByText("30 min")).toBeNull();
  });

  it("links every card to its visit, WITH the office and the date on it", async () => {
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-list");

    const links = screen
      .getAllByTestId("hyg-appointment-card")
      .map((el) => el.getAttribute("href"));
    // The office travels with the link because an AptNum means a DIFFERENT
    // appointment in each practice's Open Dental database, so a bare
    // /hyg/visit/900001 names nothing. The visit page refuses one that arrives
    // without an office rather than guessing which practice was meant.
    expect(links).toEqual([
      "/hyg/visit/900001?office=roland&date=2026-09-08",
      "/hyg/visit/900002?office=roland&date=2026-09-08",
      "/hyg/visit/900003?office=roland&date=2026-09-08",
    ]);
  });

  it("gives every card a tap target at least 88px tall", async () => {
    // Two Apple minimums stacked. This is used standing at a chair by somebody
    // who has just put down an instrument, not at a desk with a mouse.
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-list");
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
    await screen.findByTestId("hyg-day-list");
    // An empty notices strip on a good day is how the amber one keeps meaning
    // something on a bad one.
    expect(screen.queryByTestId("hyg-day-notices")).toBeNull();
  });
});

// ─── The slice-2 placeholder ─────────────────────────────────────────────────

describe("the visit route", () => {
  // Slice 1's placeholder is gone; the workspace it promised is in
  // tests/hyg-visit.test.tsx, which fetches, renders and mutates a real visit.
  // What is left here is the one property this FILE is about: the day view
  // hands the visit page everything it needs to identify what to open.
  it("refuses to guess an office rather than opening the wrong practice's visit", async () => {
    // Rendered under the REAL route pattern, not bare: the appointment number
    // comes from useParams, and a test that rendered the component directly
    // would pass with the route pattern misspelled in App.tsx.
    renderAt(<Route path="/hyg/visit/:aptNum" component={HygVisit} />, "/hyg/visit/900001");
    const page = await screen.findByTestId("hyg-visit-no-office");

    expect(page.textContent).toMatch(/which office/i);
    // And it shows no patient details while it does not know which database to
    // ask — PHI on a screen with no request and no audit row behind it is the
    // thing the platform's audit rule exists to prevent.
    expect(page.textContent).not.toMatch(/Kiwi|Papaya/);
    expect(screen.getByText(/back to the day/i)).toBeTruthy();
  });
});

// ─── The refresh control ─────────────────────────────────────────────────────

describe("refresh", () => {
  it("re-asks the server rather than re-rendering what it has", async () => {
    const { fetchDay } = await import("@/features/hyg/api");
    renderAt(<HygDay />, "/hyg/day");
    await screen.findByTestId("hyg-day-list");
    const before = vi.mocked(fetchDay).mock.calls.length;

    screen.getByTestId("hyg-day-refresh").click();
    await waitFor(() => {
      expect(vi.mocked(fetchDay).mock.calls.length).toBeGreaterThan(before);
    });
  });
});

// ─── Progressive fill ────────────────────────────────────────────────────────

/** One fill response. */
function fill(over: Partial<HygDayIdentitiesResponse> = {}): HygDayIdentitiesResponse {
  return {
    success: true,
    office: "roland",
    date: "2026-09-08",
    scope: "hygiene",
    patients: [],
    unavailable: [],
    pending: 0,
    stats: DAY.stats,
    ...over,
  };
}

describe("the schedule paints first and the names arrive after", () => {
  it("shows every card, with 'Loading name' where a name is still coming", async () => {
    // THE POINT OF THE SLICE. Times and chairs are on screen in list-read
    // time; the identities cost one Open Dental request each and no longer
    // hold the schedule up.
    fixtures.day = UNNAMED_DAY;
    // The fill never answers, so the page is held in the state under test: a
    // request IS on its way, which is exactly what the shimmer claims.
    fixtures.fillHang = true;
    renderAt(<HygDay />, "/hyg/day");

    await screen.findByTestId("hyg-day-list");
    expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(2);
    // The pending state has its OWN words. "Name unavailable" would tell a
    // hygienist to stop waiting for something that is on its way.
    const pending = await screen.findAllByTestId("hyg-name-pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(screen.queryByTestId("hyg-day-loading")).toBeNull();
    expect(screen.queryByTestId("hyg-day-empty")).toBeNull();
  });

  it("merges each batch onto the cards already on screen", async () => {
    fixtures.day = UNNAMED_DAY;
    fixtures.fills = [
      fill({
        patients: [{ patNum: 12827, patientName: "Kiwi S.", premed: true, medicalAlerts: null }],
        pending: 1,
      }),
      fill({
        patients: [
          { patNum: 12828, patientName: "Papaya P.", premed: false, medicalAlerts: true },
        ],
        pending: 0,
      }),
    ];
    renderAt(<HygDay />, "/hyg/day");

    expect(await screen.findByText("Kiwi S.")).toBeTruthy();
    expect(await screen.findByText("Papaya P.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("hyg-name-pending")).toBeNull());
    // Two batches, and then it stopped: pending reached zero.
    expect(fixtures.fillCalls).toBe(2);
  });

  it("A PATIENT WHO NEVER RESOLVES LEAVES AN HONEST CARD, NOT A SPINNER", async () => {
    // The loop runs while `pending` FALLS. A server that keeps answering "one
    // still pending" without ever naming them would otherwise be an infinite
    // request loop and a card that shimmers forever — which is the same lie as
    // an empty day, wearing a different hat.
    fixtures.day = UNNAMED_DAY;
    fixtures.fills = [
      fill({
        patients: [{ patNum: 12827, patientName: "Kiwi S.", premed: null, medicalAlerts: null }],
        unavailable: [12828],
        pending: 0,
      }),
    ];
    renderAt(<HygDay />, "/hyg/day");

    expect(await screen.findByText("Kiwi S.")).toBeTruthy();
    // The refused one says so, and says it in the words that mean "waiting
    // will not help" rather than the ones that mean "nearly there".
    expect(await screen.findByTestId("hyg-name-unavailable")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("hyg-name-pending")).toBeNull());
    expect(fixtures.fillCalls).toBe(1);
  });

  it("stops asking when a batch makes no progress", async () => {
    fixtures.day = UNNAMED_DAY;
    // Two still pending, every time. The server is not lying and not failing —
    // it simply is not getting anywhere.
    fixtures.fills = [fill({ pending: 2 })];
    renderAt(<HygDay />, "/hyg/day");

    await screen.findByTestId("hyg-day-list");
    await waitFor(() => expect(fixtures.fillCalls).toBe(1));
    // Give the loop every chance to run again. It must not.
    await new Promise((r) => setTimeout(r, 60));
    expect(fixtures.fillCalls).toBe(1);
  });

  it("A CARD THE FILL NEVER REACHES STOPS SHIMMERING", async () => {
    // The server says nothing is pending and this card was not among the names
    // — it is past the fan-out cap, which `patientNamesTruncated` also reports.
    // A shimmer with no request behind it claims something untrue, so it
    // settles to the words that mean "waiting will not help".
    fixtures.day = { ...UNNAMED_DAY, patientNamesTruncated: true };
    fixtures.fills = [
      fill({
        patients: [{ patNum: 12827, patientName: "Kiwi S.", premed: null, medicalAlerts: null }],
        pending: 0,
      }),
    ];
    renderAt(<HygDay />, "/hyg/day");

    expect(await screen.findByText("Kiwi S.")).toBeTruthy();
    expect(await screen.findByTestId("hyg-name-unavailable")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("hyg-name-pending")).toBeNull());
    expect(fixtures.fillCalls).toBe(1);
  });

  it("a failed fill keeps the schedule and offers its OWN retry", async () => {
    // Refetching the day to recover the names would throw away a schedule that
    // loaded perfectly well — and on a slow morning that is the thing she is
    // actually reading.
    fixtures.day = UNNAMED_DAY;
    fixtures.fillFail = new HygApiError("Open Dental did not answer", 502, "OD_READ_FAILED", {
      phase: "identities",
      detail: "HTTP 504",
    });
    renderAt(<HygDay />, "/hyg/day");

    await screen.findByTestId("hyg-day-list");
    expect(screen.getAllByTestId("hyg-appointment-card")).toHaveLength(2);

    const banner = await screen.findByTestId("hyg-fill-error");
    expect(banner.textContent).toContain("The schedule loaded; the names did not");
    // And the cards stop pretending a request is on its way — the banner is
    // the thing saying what happened, not a shimmer that never ends.
    await waitFor(() => expect(screen.queryByTestId("hyg-name-pending")).toBeNull());
    // WHAT OPEN DENTAL SAID, verbatim. "It fails at times" costs a day to
    // reproduce; a status line costs nothing to read out over a phone.
    expect(screen.getByTestId("hyg-fill-error-detail").textContent).toBe("HTTP 504");
    // And it is NOT the whole-day error state.
    expect(screen.queryByTestId("hyg-day-error")).toBeNull();
    expect(screen.getByTestId("hyg-fill-retry")).toBeTruthy();
  });
});

describe("mergeIdentities", () => {
  it("keeps every flag it was not told about", async () => {
    // The fill answers for premed and medicalAlerts and NOTHING ELSE.
    // Replacing the flags object would blank the other five — and blanking a
    // clinical flag is the failure this whole module is written against.
    const { mergeIdentities } = await import("@/pages/hyg/HygDay");
    const before: HygDayResponse = {
      ...UNNAMED_DAY,
      appointments: [
        appt({
          patNum: 12827,
          identity: "pending",
          patientName: null,
          flags: flags({ allergies: true, xraysDue: false }),
        }),
      ],
    };

    const after = mergeIdentities(
      before,
      fill({
        patients: [{ patNum: 12827, patientName: "Kiwi S.", premed: true, medicalAlerts: false }],
        pending: 0,
      }),
    );

    expect(after.appointments[0].identity).toBe("resolved");
    expect(after.appointments[0].patientName).toBe("Kiwi S.");
    expect(after.appointments[0].flags.premed).toBe(true);
    expect(after.appointments[0].flags.medicalAlerts).toBe(false);
    expect(after.appointments[0].flags.allergies).toBe(true);
    expect(after.appointments[0].flags.xraysDue).toBe(false);
    expect(after.identitiesPending).toBe(0);
  });

  it("does not un-resolve a card the fill did not mention", async () => {
    const { mergeIdentities } = await import("@/pages/hyg/HygDay");
    const after = mergeIdentities(DAY, fill({ pending: 0 }));
    expect(after.appointments[0].patientName).toBe("Kiwi S.");
    expect(after.appointments[0].identity).toBe("resolved");
    // And a card that was already `unavailable` stays that way — an empty
    // batch is not evidence about anybody.
    expect(after.appointments[2].identity).toBe("unavailable");
  });
});
