/**
 * Every RCM timestamp is the PRACTICE'S day, not the browser's.
 *
 * §15.2, finding 2: a plan approved at 20:10 in Roland reported "Approved
 * Aug 26". Two bugs, one lie —
 *
 *   `format.day()` sliced an ISO instant to its first ten characters, which is
 *   its UTC calendar day, and `format.stamp()` rendered in the BROWSER's zone,
 *   so the same approval had a different date depending on who was looking.
 *
 * The 01:xxZ case is the one that matters and it is asserted directly: at 01:10
 * UTC it is still the previous evening in Central, and every function here has
 * to agree about which day that is.
 *
 * The zone is pinned as a string rather than read from the environment. A test
 * that passes because the machine happens to be in Chicago proves nothing about
 * the CI box or about the laptop in the office.
 */
import { describe, expect, it } from "vitest";
import {
  OFFICE_TIMEZONE,
  officeDay,
  officeDayKey,
  officeStamp,
  withinLastDays,
} from "../client/src/features/rcm/time";
import { day } from "../client/src/features/rcm/format";

/** 2026-08-26 01:10 UTC = 2026-08-25 20:10 in America/Chicago. */
const LATE_EVENING = "2026-08-26T01:10:00.000Z";

describe("the practice's own day", () => {
  it("is Central", () => {
    expect(OFFICE_TIMEZONE).toBe("America/Chicago");
  });

  it("puts a 01:xxZ instant on the PREVIOUS calendar day", () => {
    // The §15.2 bug, stated as an assertion.
    expect(officeDay(LATE_EVENING)).toBe("Aug 25, 2026");
    expect(officeDayKey(LATE_EVENING)).toBe("2026-08-25");
    expect(officeStamp(LATE_EVENING)).toContain("Aug 25");
    expect(officeStamp(LATE_EVENING)).toContain("8:10");
  });

  it("does not depend on where the browser thinks it is", () => {
    /*
     * `day()` is what used to render `approvedAt`, and this is exactly what it
     * said: the UTC calendar day. It is kept, and it is correct for what it is
     * now used for — DATE-ONLY values, which carry no time for a zone to move.
     * The two must not be confused, so both are asserted here beside each
     * other.
     */
    expect(day(LATE_EVENING)).toBe("Aug 26, 2026");
    expect(officeDay(LATE_EVENING)).toBe("Aug 25, 2026");
  });

  it("leaves a date-only value alone", () => {
    // No instant, no zone: a service date is the same day everywhere.
    expect(day("2026-03-02")).toBe("Mar 2, 2026");
  });

  it("renders a missing instant as an em dash rather than an epoch", () => {
    expect(officeDay(null)).toBe("—");
    expect(officeDay(undefined)).toBe("—");
    expect(officeStamp("not a date")).toBe("—");
    expect(officeDayKey(null)).toBeNull();
  });

  it("holds across a daylight-saving boundary", () => {
    // 2026-11-01 is the US fall-back. 05:30Z is 00:30 CDT on the 1st; 07:30Z is
    // 01:30 CST, still the 1st. Both are the practice's Nov 1.
    expect(officeDayKey("2026-11-01T05:30:00.000Z")).toBe("2026-11-01");
    expect(officeDayKey("2026-11-01T07:30:00.000Z")).toBe("2026-11-01");
    // 04:00Z is 23:00 on Oct 31 in Central.
    expect(officeDayKey("2026-11-01T04:00:00.000Z")).toBe("2026-10-31");
  });
});

describe("posted this week", () => {
  /** 2026-08-26 15:00 UTC = 10:00 Central on Wednesday the 26th. */
  const NOW = new Date("2026-08-26T15:00:00.000Z");

  it("counts today", () => {
    expect(withinLastDays("2026-08-26T14:00:00.000Z", 7, NOW)).toBe(true);
  });

  it("counts a late-evening instant on the practice's YESTERDAY", () => {
    // The same 01:10Z instant. Six practice days ago it is not — it is one.
    expect(withinLastDays(LATE_EVENING, 7, NOW)).toBe(true);
    expect(withinLastDays(LATE_EVENING, 2, NOW)).toBe(true);
    expect(withinLastDays(LATE_EVENING, 1, NOW)).toBe(false);
  });

  it("counts WHOLE practice days, not a rolling 168 hours", () => {
    /*
     * Seven days back from Wednesday the 26th reaches Thursday the 20th. A
     * payment posted at 08:00 that Thursday is inside the week even though it
     * is more than 168 hours ago, because a biller asking "what posted this
     * week" means calendar days at the practice.
     */
    expect(withinLastDays("2026-08-20T13:00:00.000Z", 7, NOW)).toBe(true);
    expect(withinLastDays("2026-08-19T13:00:00.000Z", 7, NOW)).toBe(false);
  });

  it("refuses a future instant rather than counting it", () => {
    expect(withinLastDays("2026-09-01T13:00:00.000Z", 7, NOW)).toBe(false);
  });

  it("refuses a missing or unparseable stamp", () => {
    expect(withinLastDays(null, 7, NOW)).toBe(false);
    expect(withinLastDays("whenever", 7, NOW)).toBe(false);
  });
});
