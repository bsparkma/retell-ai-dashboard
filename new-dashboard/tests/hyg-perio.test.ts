/**
 * The perio chart's pure half (H4 slice 10): the charting order, the counts,
 * the canonical form, the preview, and what every key does.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ACCEPTANCE #1 LIVES HERE AS A STATEMENT ABOUT FUNCTIONS
 * ═════════════════════════════════════════════════════════════════════════════
 * "A full 32-tooth chart is enterable with keyboard only, in charting order."
 * The page test drives the same thing through the DOM; this file states it
 * without one, so a failure says whether the ORDER broke or the PAGE did.
 *
 * NO PHI — there is not a patient anywhere in this file.
 */
import { describe, expect, it } from "vitest";

import { LOWER_PERMANENT, UPPER_PERMANENT } from "@/lib/hyg/dentition";
import {
  PERIO_FULL_MOUTH_SITES,
  PerioChartSchema,
  bleedSupPlaqCalcBits,
  chartingOrder,
  countPerioChart,
  defaultPerioSweep,
  emptyPerioChart,
  emptyPerioTooth,
  firstOpenPerioCursor,
  flagsFromBits,
  normalizePerioChart,
  perioPreviewLines,
  perioProgressLabel,
  perioSite,
  PERIO_LOWER_TEETH,
  PERIO_UPPER_TEETH,
  samePerioReadings,
  screenSites,
  stepPerioCursor,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
} from "@shared/hyg/perio";
import {
  flagTarget,
  initialPerioEntry,
  keyToPerioAction,
  reducePerioEntry,
  type PerioEntryState,
  type PerioKey,
} from "@/features/hyg/perio/entry";

function key(code: string, over: Partial<PerioKey> = {}): PerioKey {
  const digit = /(\d)$/.exec(code);
  const letter = /^Key([A-Z])$/.exec(code);
  return {
    key: digit ? digit[1] : letter ? letter[1].toLowerCase() : code,
    code,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...over,
  };
}

function press(state: PerioEntryState, k: PerioKey): PerioEntryState {
  const action = keyToPerioAction(k);
  return action ? reducePerioEntry(state, action) : state;
}

const label = (c: { tooth: number; surface: string }) => `#${c.tooth} ${c.surface}`;

describe("the arches", () => {
  it("are the same arrays the rest of the app draws teeth with", () => {
    // The lower arch reads #32 → #17 on screen. Getting it backwards makes every
    // site she taps the wrong one, in a way that looks plausible.
    expect([...PERIO_UPPER_TEETH]).toEqual(UPPER_PERMANENT);
    expect([...PERIO_LOWER_TEETH]).toEqual(LOWER_PERMANENT);
  });

  it("mirror the site order across the midline", () => {
    expect(screenSites(8, "facial")).toEqual(["DB", "B", "MB"]);
    expect(screenSites(9, "facial")).toEqual(["MB", "B", "DB"]);
    expect(screenSites(24, "lingual")).toEqual(["ML", "L", "DL"]);
    expect(screenSites(25, "lingual")).toEqual(["DL", "L", "ML"]);
  });
});

describe("the charting order", () => {
  const order = chartingOrder(defaultPerioSweep());

  it("visits all 192 sites exactly once", () => {
    expect(order).toHaveLength(PERIO_FULL_MOUTH_SITES);
    expect(new Set(order.map(label)).size).toBe(192);
  });

  it("is one continuous snake — every sweep starts where the last one ended", () => {
    expect(order.slice(0, 3).map(label)).toEqual(["#1 DB", "#1 B", "#1 MB"]);
    // Across the midline the probe keeps moving the same way: #8 ends mesial,
    // #9 starts mesial.
    expect(order.slice(21, 27).map(label)).toEqual(["#8 DB", "#8 B", "#8 MB", "#9 MB", "#9 B", "#9 DB"]);
    // Upper facial ends at #16 distal; upper lingual starts at #16 distal.
    expect(label(order[47])).toBe("#16 DB");
    expect(label(order[48])).toBe("#16 DL");
    // Upper lingual ends at #1; lower lingual starts right below it at #32.
    expect(label(order[95])).toBe("#1 DL");
    expect(label(order[96])).toBe("#32 DL");
    // Lower lingual ends at #17; lower facial comes back from #17 to #32.
    expect(label(order[143])).toBe("#17 DL");
    expect(label(order[144])).toBe("#17 DB");
    expect(label(order[191])).toBe("#32 DB");
  });

  it("flips ONE sweep, teeth and sites both, and leaves the others alone", () => {
    const flipped = chartingOrder({ ...defaultPerioSweep(), upperFacial: "rtl" });
    expect(flipped.slice(0, 48).map(label)).toEqual(order.slice(0, 48).reverse().map(label));
    expect(flipped.slice(48).map(label)).toEqual(order.slice(48).map(label));
  });

  it("steps over skipped teeth and stops at either end rather than wrapping", () => {
    const chart = withPerioSkipped(emptyPerioChart(), 2, true);
    expect(stepPerioCursor(chart, { tooth: 1, surface: "MB" }, 1)).toEqual({ tooth: 3, surface: "DB" });
    expect(stepPerioCursor(chart, { tooth: 3, surface: "DB" }, -1)).toEqual({ tooth: 1, surface: "MB" });
    expect(stepPerioCursor(chart, { tooth: 1, surface: "DB" }, -1)).toBeNull();
    expect(stepPerioCursor(chart, { tooth: 32, surface: "DB" }, 1)).toBeNull();
  });

  it("resumes at the first uncharted site on a tooth that is not skipped", () => {
    let chart = withPerioSkipped(emptyPerioChart(), 1, true);
    for (const c of order.slice(3, 6)) chart = withPerioSite(chart, c.tooth, c.surface, { depth: 2 });
    expect(label(firstOpenPerioCursor(chart))).toBe("#3 DB");
  });
});

describe("Open Dental's packed flags", () => {
  it("round-trip every one of the sixteen values", () => {
    for (let bits = 0; bits <= 15; bits += 1) {
      const flags = flagsFromBits(bits);
      expect(flags).not.toBeNull();
      expect(bleedSupPlaqCalcBits(flags!)).toBe(bits);
    }
    expect(flagsFromBits(5)).toEqual({ bleeding: true, suppuration: false, plaque: true, calculus: false });
  });

  it("read -1 and anything out of range as UNKNOWN, not as four falses", () => {
    expect(flagsFromBits(-1)).toBeNull();
    expect(flagsFromBits(16)).toBeNull();
    expect(flagsFromBits("3")).toBeNull();
  });
});

describe("what a chart adds up to", () => {
  it("labels a partial chart partial, and counts skipped teeth out of the total", () => {
    let chart = emptyPerioChart();
    for (const c of chartingOrder(chart.sweep).slice(0, 84)) {
      chart = withPerioSite(chart, c.tooth, c.surface, { depth: 3 });
    }
    expect(perioProgressLabel(countPerioChart(chart))).toBe("Partial chart: 84 of 192 sites charted");

    // #16's six charted sites leave the count with it; #17 had none to lose.
    chart = withPerioSkipped(withPerioSkipped(chart, 16, true), 17, true);
    const counts = countPerioChart(chart);
    expect(counts.sitesExpected).toBe(180);
    expect(perioProgressLabel(counts)).toBe("Partial chart: 78 of 180 sites charted (2 teeth skipped)");
  });

  it("calls a chart full only when every expected site has a reading", () => {
    let chart = withPerioSkipped(emptyPerioChart(), 1, true);
    for (const c of chartingOrder(chart.sweep)) {
      if (c.tooth !== 1) chart = withPerioSite(chart, c.tooth, c.surface, { depth: 2 });
    }
    const counts = countPerioChart(chart);
    expect(counts.complete).toBe(true);
    expect(perioProgressLabel(counts)).toBe("Full chart: 186 of 186 sites charted (1 tooth skipped)");
  });

  it("treats a zero as a reading and a null as not charted", () => {
    const chart = withPerioSite(emptyPerioChart(), 3, "B", { depth: 0 });
    expect(countPerioChart(chart).sitesCharted).toBe(1);
    expect(countPerioChart(emptyPerioChart()).empty).toBe(true);
  });
});

describe("the canonical form", () => {
  it("is idempotent, drops untouched teeth, and ignores key order", () => {
    let chart = withPerioSite(emptyPerioChart(), 14, "DL", { depth: 6, bleeding: true });
    chart = { ...chart, teeth: { ...chart.teeth, 2: emptyPerioTooth() } };
    const once = normalizePerioChart(chart);
    expect(Object.keys(once.teeth)).toEqual(["14"]);
    expect(normalizePerioChart(once)).toEqual(once);

    // jsonb hands keys back in its own order; the canonical JSON must not care.
    const shuffled = JSON.parse(JSON.stringify(once).replace('"depth":6,"bleeding":true', '"bleeding":true,"depth":6')) as PerioChart;
    expect(JSON.stringify(normalizePerioChart(shuffled))).toBe(JSON.stringify(once));
  });

  it("calls two charts the same when only the typing direction differs", () => {
    const a = withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4 });
    const b = { ...a, sweep: { ...a.sweep, lowerFacial: "ltr" as const } };
    expect(samePerioReadings(a, b)).toBe(true);
    expect(samePerioReadings(a, withPerioSite(a, 3, "DB", { depth: 5 }))).toBe(false);
  });
});

describe("the wire shape", () => {
  it("refuses a depth past 19, a tooth past 32, and a field it does not know — CAL included", () => {
    const chart = withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4 });
    expect(PerioChartSchema.safeParse(chart).success).toBe(true);

    const deep = JSON.parse(JSON.stringify(chart)) as PerioChart;
    deep.teeth["3"].sites.DB.depth = 20;
    expect(PerioChartSchema.safeParse(deep).success).toBe(false);

    expect(PerioChartSchema.safeParse({ teeth: { 33: emptyPerioTooth() } }).success).toBe(false);
    expect(
      PerioChartSchema.safeParse({ teeth: { 3: { ...emptyPerioTooth(), cal: 3 } } }).success,
    ).toBe(false);
  });

  it("still parses a stored chart that predates the sweep field", () => {
    const parsed = PerioChartSchema.parse({ teeth: {} });
    expect(parsed.sweep).toEqual(defaultPerioSweep());
  });
});

describe("the staged preview", () => {
  it("spells out every reading, so two different charts cannot share a fingerprint", () => {
    let chart = withPerioSite(emptyPerioChart(), 3, "DB", { depth: 3, bleeding: true });
    chart = withPerioSite(chart, 3, "ML", { depth: 5, plaque: true, calculus: true });
    chart = withPerioSkipped(chart, 1, true);
    const lines = perioPreviewLines(chart);
    expect(lines[0]).toBe("Partial chart: 2 of 186 sites charted (1 tooth skipped)");
    expect(lines).toContain("  #1 skipped");
    expect(lines).toContain("  #3 facial 3 - -, lingual - - 5; bleeding DB; plaque ML; calculus ML");
    for (const line of lines) expect(line).toMatch(/^[\x20-\x7e]*$/);

    const other = withPerioSite(chart, 3, "ML", { depth: 6 });
    expect(perioPreviewLines(other)).not.toEqual(lines);
  });
});

describe("keyboard entry", () => {
  it("fills all 32 teeth from the keyboard alone, in charting order", () => {
    let state = initialPerioEntry(emptyPerioChart());
    const order = chartingOrder(state.chart.sweep);
    order.forEach((_, i) => {
      state = press(state, key(`Digit${(i % 9) + 1}`));
    });

    const counts = countPerioChart(state.chart);
    expect(counts.complete).toBe(true);
    expect(counts.sitesCharted).toBe(192);
    // Every number landed on the site the order says it should have.
    order.forEach((c, i) => {
      expect(perioSite(state.chart, c.tooth, c.surface).depth).toBe((i % 9) + 1);
    });
    // And the cursor stayed on the last site rather than wrapping to #1.
    expect(label(state.cursor)).toBe("#32 DB");
  });

  it("types 10–19 with Shift, by physical key", () => {
    let state = initialPerioEntry(emptyPerioChart());
    state = press(state, key("Digit2", { key: "@", shiftKey: true }));
    expect(perioSite(state.chart, 1, "DB").depth).toBe(12);
    state = press(state, key("Numpad7"));
    expect(perioSite(state.chart, 1, "B").depth).toBe(7);
  });

  it("puts a flag on the reading just entered, and on the cursor after a move", () => {
    let state = initialPerioEntry(emptyPerioChart());
    state = press(state, key("Digit3"));
    expect(label(flagTarget(state))).toBe("#1 DB");
    state = press(state, key("KeyB"));
    expect(perioSite(state.chart, 1, "DB").bleeding).toBe(true);
    expect(perioSite(state.chart, 1, "B").bleeding).toBe(false);

    state = press(state, key("ArrowRight"));
    expect(label(flagTarget(state))).toBe("#1 MB");
    state = press(state, key("KeyC"));
    expect(perioSite(state.chart, 1, "MB").calculus).toBe(true);
  });

  it("skips a missing tooth with X and never puts a number on it", () => {
    let state = initialPerioEntry(emptyPerioChart());
    state = press(state, key("KeyX"));
    expect(state.chart.teeth["1"].skipped).toBe(true);
    expect(label(state.cursor)).toBe("#2 DB");
    state = press(state, key("Digit4"));
    expect(perioSite(state.chart, 2, "DB").depth).toBe(4);
    expect(perioSite(state.chart, 1, "DB").depth).toBeNull();
  });

  it("takes back the last reading with Backspace and ignores shortcuts it does not own", () => {
    let state = initialPerioEntry(emptyPerioChart());
    state = press(state, key("Digit3"));
    state = press(state, key("Digit4"));
    state = press(state, key("Backspace"));
    expect(perioSite(state.chart, 1, "B").depth).toBeNull();
    expect(label(state.cursor)).toBe("#1 B");

    expect(keyToPerioAction(key("KeyC", { ctrlKey: true }))).toBeNull();
    expect(keyToPerioAction(key("Tab"))).toBeNull();
  });
});
