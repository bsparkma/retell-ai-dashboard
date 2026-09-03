/**
 * The pure logic behind the hygiene Day View.
 *
 * Two classes of bug live here and neither announces itself:
 *
 *   DATES. `toISOString().slice(0,10)` is UTC, so a Central-time hygienist
 *   opening the app at 7pm would be shown TOMORROW under the heading "Today".
 *   And Open Dental's `AptDateTime` is the office's own local clock, so parsing
 *   it into a Date renders a different time on an iPad that has travelled — or
 *   in CI, which runs under UTC and would bake the wrong times into every
 *   committed screenshot.
 *
 *   THREE-STATE FLAGS. `null` means unknown, and a screen that draws it the way
 *   it draws `false` tells a hygienist "no premedication needed" about a patient
 *   nobody asked. This is the last screen before instruments go in a mouth.
 */
import { describe, expect, it } from "vitest";

import type { HygAppointment, HygOperatory } from "@shared/hyg/contract";
import {
  columnLabel,
  flagTone,
  formatClock,
  formatLength,
  groupByOperatory,
  shiftIsoDate,
  startMinutes,
  summarise,
  todayIso,
  visibleFlags,
} from "@/features/hyg/day";

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
    patientName: "Fixture, Synthetic",
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

function op(over: Partial<HygOperatory> = {}): HygOperatory {
  return { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1, ...over };
}

// ─── dates ───────────────────────────────────────────────────────────────────

describe("todayIso", () => {
  it("uses the LOCAL calendar date, not the UTC one", () => {
    // 7pm Central on the 8th is already the 9th in UTC. The UTC version of this
    // function would head the page "Today" over tomorrow's schedule.
    const localEvening = new Date(2026, 8, 8, 19, 30, 0);
    expect(todayIso(localEvening)).toBe("2026-09-08");
  });

  it("pads single-digit months and days", () => {
    expect(todayIso(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });
});

describe("shiftIsoDate", () => {
  it("steps a day in each direction", () => {
    expect(shiftIsoDate("2026-09-08", 1)).toBe("2026-09-09");
    expect(shiftIsoDate("2026-09-08", -1)).toBe("2026-09-07");
  });

  it("crosses month and year boundaries", () => {
    expect(shiftIsoDate("2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftIsoDate("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("survives the spring-forward day", () => {
    // Parsed at local NOON rather than midnight: on a DST transition, midnight
    // itself moves and "+1 day" from it can land back on the same date.
    expect(shiftIsoDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftIsoDate("2026-03-08", -1)).toBe("2026-03-07");
  });
});

describe("formatClock", () => {
  it("reads the digits out of Open Dental's local timestamp", () => {
    expect(formatClock("2026-09-08 08:00:00")).toBe("8:00 am");
    expect(formatClock("2026-09-08 13:45:00")).toBe("1:45 pm");
    expect(formatClock("2026-09-08 00:15:00")).toBe("12:15 am");
    expect(formatClock("2026-09-08 12:00:00")).toBe("12:00 pm");
  });

  it("does not go through Date, so a browser's zone cannot shift it", () => {
    // `new Date("2026-09-08 08:00:00")` is parsed in the BROWSER's zone. If this
    // function used it, this assertion would depend on TZ — and CI runs UTC,
    // so every committed screenshot would show a time the office never had.
    const original = process.env.TZ;
    try {
      process.env.TZ = "Australia/Sydney";
      expect(formatClock("2026-09-08 08:00:00")).toBe("8:00 am");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("returns null rather than a guess for a missing or unreadable time", () => {
    expect(formatClock(null)).toBeNull();
    expect(formatClock("")).toBeNull();
    expect(formatClock("not a time")).toBeNull();
  });
});

describe("formatLength", () => {
  it("never invents a duration", () => {
    expect(formatLength(60)).toBe("60 min");
    // The failure this guards: config/openDental.js's older helper defaults a
    // missing Pattern to 30, which draws a half-hour block for an unknown one.
    expect(formatLength(null)).toBeNull();
    expect(formatLength(0)).toBeNull();
  });
});

describe("startMinutes", () => {
  it("sorts by the clock, and puts an unreadable time last", () => {
    expect(startMinutes("2026-09-08 08:30:00")).toBe(510);
    expect(startMinutes(null)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ─── columns ─────────────────────────────────────────────────────────────────

describe("groupByOperatory", () => {
  it("gives a column only to chairs that have appointments", () => {
    // A practice has two dozen operatories; a hygiene day fills two or three.
    // Rendering all of them pushes the real ones off an iPad screen.
    const columns = groupByOperatory(
      [appt({ opNum: 2 })],
      [op({ opNum: 2 }), op({ opNum: 3, name: "Hygiene 2", itemOrder: 2 })],
    );
    expect(columns).toHaveLength(1);
    expect(columns[0].opNum).toBe(2);
  });

  it("orders appointments within a chair by the clock", () => {
    const columns = groupByOperatory(
      [
        appt({ aptNum: 3, start: "2026-09-08 14:00:00" }),
        appt({ aptNum: 1, start: "2026-09-08 08:00:00" }),
        appt({ aptNum: 2, start: "2026-09-08 10:30:00" }),
      ],
      [op()],
    );
    expect(columns[0].appointments.map((a) => a.aptNum)).toEqual([1, 2, 3]);
  });

  it("puts hygiene chairs first, and does not promote an unknown one", () => {
    const columns = groupByOperatory(
      [
        appt({ aptNum: 1, opNum: 9, opIsHygiene: false }),
        appt({ aptNum: 2, opNum: 2, opIsHygiene: true }),
        appt({ aptNum: 3, opNum: 5, opIsHygiene: null }),
      ],
      [
        op({ opNum: 9, name: "Doctor 1", isHygiene: false, itemOrder: 1 }),
        op({ opNum: 5, name: "Op 5", isHygiene: null, itemOrder: 2 }),
        op({ opNum: 2, name: "Hygiene 1", isHygiene: true, itemOrder: 3 }),
      ],
    );
    // Hygiene first even though it is LAST in ItemOrder; the unknown chair sorts
    // with the non-hygiene ones rather than being promoted on a guess.
    expect(columns.map((c) => c.opNum)).toEqual([2, 9, 5]);
  });

  it("keeps an appointment whose chair is missing from the roster", () => {
    // Exactly what happens when /operatories fails and /appointments succeeds.
    // Losing a patient because a chair was missing is the worse failure.
    const columns = groupByOperatory([appt({ opNum: 7 })], []);
    expect(columns).toHaveLength(1);
    expect(columns[0].name).toBeNull();
    expect(columnLabel(columns[0])).toBe("Op 7");
  });

  it("keeps an appointment with no chair at all", () => {
    const columns = groupByOperatory([appt({ opNum: null })], [op()]);
    expect(columns).toHaveLength(1);
    // "Op null" would read as a chair. This says what is true.
    expect(columnLabel(columns[0])).toBe("No chair");
  });
});

// ─── flags ───────────────────────────────────────────────────────────────────

describe("flagTone", () => {
  it("has three tones because there are three states", () => {
    expect(flagTone(true)).toBe("alert");
    expect(flagTone(false)).toBe("clear");
    // The one that matters. `unknown` must never share a tone with `clear`.
    expect(flagTone(null)).toBe("unknown");
    expect(flagTone("2026-01-05")).toBe("alert");
  });
});

describe("visibleFlags", () => {
  it("shows what is true and what is unknown, and hides what is clear", () => {
    const shown = visibleFlags(flags({ premed: true, medicalAlerts: false }));
    const keys = shown.map((f) => f.key);
    expect(keys).toContain("premed");
    // Seven green chips on every card would bury the one amber one, and an
    // absent chip already means "no" on a card where unknown is visible.
    expect(keys).not.toContain("medicalAlerts");
    expect(keys).toContain("allergies");
    expect(shown.find((f) => f.key === "allergies")?.tone).toBe("unknown");
  });

  it("shows nothing when every flag is a measured no", () => {
    const all = flags({
      premed: false,
      medicalAlerts: false,
      allergies: false,
      lastPerioDate: null,
      xraysDue: false,
      examNeeded: false,
      openTcCase: false,
    });
    // lastPerioDate is still null here, so exactly one chip survives.
    expect(visibleFlags(all).map((f) => f.key)).toEqual(["lastPerioDate"]);
  });
});

// ─── the summary strip ───────────────────────────────────────────────────────

describe("summarise", () => {
  it("counts flagged and unknown SEPARATELY", () => {
    const day = {
      appointments: [
        appt({ flags: flags({ premed: true, medicalAlerts: false, allergies: false, lastPerioDate: "2026-01-01", xraysDue: false, examNeeded: false, openTcCase: false }) }),
        appt({ flags: flags({ premed: null }) }),
        appt({ isHygiene: false, flags: flags({ premed: false, medicalAlerts: false, allergies: false, lastPerioDate: "2025-12-01", xraysDue: false, examNeeded: false, openTcCase: false }) }),
      ],
    };
    const s = summarise(day);
    expect(s.total).toBe(3);
    expect(s.hygiene).toBe(2);
    // Only the first has something we KNOW is true. "3 flagged" would mean
    // "at least 3", which is not a number anybody can act on.
    expect(s.flagged).toBe(1);
    expect(s.unknownFlags).toBe(1);
  });

  it("counts nothing on an empty day", () => {
    expect(summarise({ appointments: [] })).toEqual({
      total: 0,
      hygiene: 0,
      flagged: 0,
      unknownFlags: 0,
    });
  });
});
