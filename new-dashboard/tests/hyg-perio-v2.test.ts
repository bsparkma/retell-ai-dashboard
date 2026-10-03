/**
 * PERIO v2 — recession, mobility, furcation, and a CAL that is never written.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY NUMBER BELOW COMES FROM A MEASUREMENT
 * ═════════════════════════════════════════════════════════════════════════════
 * §0 (`PERIO_GM_FAMILIES`): Beau hand-entered a 2 mm recession on #3 buccal in
 * Open Dental's OWN perio chart on roland 12828, and the probe read it back as
 * `"Bvalue":2`. So recession is the LOW family, 0-19, and **CAL = depth +
 * recession by addition**. Everything in this file that depends on the sign
 * depends on that one row.
 *
 * Item 19's probe (`docs/reports/feature-hyg-perio-v2-probe.md`) measured the
 * rest: the row shapes, that Open Dental accepts furcation class 5 and furcation
 * on a central incisor, that a mobility row refuses a surface value, and that a
 * second POST for the same (tooth, type) is refused rather than overwritten.
 *
 * NO PHI: 12827 and 12828 are the designated roland fixtures, and neither appears
 * here — this file is all chart arithmetic.
 */
import { describe, expect, it } from "vitest";

import {
  PERIO_FURCATION_TEETH,
  PERIO_GM_FAMILIES,
  PERIO_MAX_FURCATION,
  PERIO_MAX_MOBILITY,
  countPerioChart,
  emptyPerioChart,
  emptyPerioSite,
  normalizePerioChart,
  perioCal,
  perioGmIsRecession,
  perioHasReading,
  perioPreviewLines,
  perioSite,
  perioTooth,
  perioToothHasFurcation,
  withPerioMobility,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
} from "@shared/hyg/perio";
import { comparePerioReadback, perioChartChanges, planPerioSend } from "@shared/hyg/perioSend";
import {
  PERIO_MODES,
  PERIO_MODE_KEYS,
  initialPerioEntry,
  keyToPerioAction,
  reducePerioEntry,
  type PerioEntryState,
  type PerioMode,
} from "@/features/hyg/perio/entry";

// ─────────────────────────────────────────────────────────────────────────────
// §0 — the one constant the slice turns on
// ─────────────────────────────────────────────────────────────────────────────

describe("§0: the recession family, measured", () => {
  it("is the LOW family, 0-19, and the other one is 101-119", () => {
    // The raw row: {"PerioExamNum":2268,"SequenceType":"GingMargin","IntTooth":3,
    //               "ToothValue":-1,"MBvalue":-1,"Bvalue":2, ...}
    // A KNOWN 2 mm recession read back as 2, not 102.
    expect(PERIO_GM_FAMILIES.recessionMin).toBe(0);
    expect(PERIO_GM_FAMILIES.recessionMax).toBe(19);
    expect(PERIO_GM_FAMILIES.otherMin).toBe(101);
    expect(PERIO_GM_FAMILIES.otherMax).toBe(119);
  });

  it("tells the two families apart, and calls nothing else a recession", () => {
    for (const v of [0, 1, 2, 19]) expect(perioGmIsRecession(v)).toBe(true);
    for (const v of [101, 102, 119, -1, 20, 100, 120, null]) {
      expect(perioGmIsRecession(v)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 4 — CAL, and the ways it must say nothing
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE 4: CAL = depth + recession, display only", () => {
  const site = (over: Partial<ReturnType<typeof emptyPerioSite>>) => ({ ...emptyPerioSite(), ...over });

  it("adds, because §0 proved recession is the low family", () => {
    expect(perioCal(site({ depth: 4, gm: 2 }))).toBe(6);
    expect(perioCal(site({ depth: 0, gm: 0 }))).toBe(0);
    expect(perioCal(site({ depth: 19, gm: 19 }))).toBe(38);
  });

  it("a zero on either side is a READING, not an absence", () => {
    expect(perioCal(site({ depth: 4, gm: 0 }))).toBe(4);
    expect(perioCal(site({ depth: 0, gm: 3 }))).toBe(3);
  });

  it("says NOTHING when either operand is missing — never 0, never a dash", () => {
    expect(perioCal(site({ depth: 4 }))).toBeNull();
    expect(perioCal(site({ gm: 2 }))).toBeNull();
    expect(perioCal(site({}))).toBeNull();
  });

  it("says nothing for a margin in the OTHER family, whatever H0 claims", () => {
    // H0 documents 101-119 as "negative (subtract 100)". That sign has never been
    // observed, and a guess here becomes a clinical number that reads as plausible.
    for (const gm of [101, 102, 119]) {
      expect(perioCal(site({ depth: 4, gm }))).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 2 — four modes, and a digit lands in exactly one row
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE 2: the four modes", () => {
  /** Press a key through the real key map, like a keyboard would. */
  function press(state: PerioEntryState, key: string, code: string): PerioEntryState {
    const action = keyToPerioAction({ key, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    return action === null ? state : reducePerioEntry(state, action);
  }
  const digit = (state: PerioEntryState, d: number) => press(state, String(d), `Digit${d}`);
  const start = () => initialPerioEntry(emptyPerioChart());

  it("starts in Depth, and every mode has a key that reaches it", () => {
    expect(start().mode).toBe("depth");
    for (const mode of PERIO_MODES) {
      const key = PERIO_MODE_KEYS[mode];
      const after = press(start(), key.toLowerCase(), "Key" + key);
      expect(after.mode).toBe(mode);
    }
  });

  it("the mode keys and the flag keys share no letter", () => {
    // Otherwise one of the two tables would silently win, and the legend would be
    // promising something the reducer does not do.
    const modeKeys = PERIO_MODES.map((m) => PERIO_MODE_KEYS[m].toLowerCase());
    for (const flag of ["b", "s", "p", "c", "x"]) expect(modeKeys).not.toContain(flag);
    expect(new Set(modeKeys).size).toBe(modeKeys.length);
  });

  it("a digit lands ONLY in the active mode's row", () => {
    const cases: [PerioMode, number, (c: PerioChart) => unknown][] = [
      ["depth", 4, (c) => perioSite(c, 1, "DB").depth],
      ["gm", 3, (c) => perioSite(c, 1, "DB").gm],
      ["furcation", 2, (c) => perioSite(c, 1, "DB").furcation],
      ["mobility", 1, (c) => perioTooth(c, 1).mobility],
    ];
    for (const [mode, value, read] of cases) {
      let state = reducePerioEntry(start(), { type: "mode", mode });
      state = digit(state, value);
      expect(read(state.chart)).toBe(value);

      // And NOTHING landed in any other row at that site.
      const site = perioSite(state.chart, 1, "DB");
      const others: Record<string, unknown> = {
        depth: site.depth,
        gm: site.gm,
        furcation: site.furcation,
        mobility: perioTooth(state.chart, 1).mobility,
      };
      for (const [key, got] of Object.entries(others)) {
        if (key === mode) continue;
        expect(got, `${mode} digit leaked into ${key}`).toBeNull();
      }
    }
  });

  it("flag keys do NOTHING outside depth mode", () => {
    for (const mode of PERIO_MODES) {
      let state = reducePerioEntry(start(), { type: "mode", mode });
      state = press(state, "b", "KeyB");
      const bleeding = perioSite(state.chart, 1, "DB").bleeding;
      expect(bleeding).toBe(mode === "depth");
    }
  });

  it("the walk advances by SITE in the three per-site modes and by TOOTH in mobility", () => {
    for (const mode of ["depth", "gm", "furcation"] as const) {
      let state = reducePerioEntry(start(), { type: "mode", mode });
      const from = state.cursor;
      state = digit(state, 2);
      expect(state.cursor.tooth).toBe(from.tooth);
      expect(state.cursor.surface).not.toBe(from.surface);
    }
    let state = reducePerioEntry(start(), { type: "mode", mode: "mobility" });
    const from = state.cursor;
    state = digit(state, 2);
    expect(state.cursor.tooth).not.toBe(from.tooth);
  });

  it("navigation, skip and erase behave the same in every mode", () => {
    for (const mode of PERIO_MODES) {
      let state = reducePerioEntry(start(), { type: "mode", mode });
      const first = state.cursor;
      state = press(state, " ", "Space");
      expect(state.cursor).not.toEqual(first);
      state = press(state, "ArrowLeft", "ArrowLeft");
      expect(state.cursor).toEqual(first);
      state = press(state, "x", "KeyX");
      expect(perioTooth(state.chart, first.tooth).skipped).toBe(true);
    }
  });

  it("Backspace and Delete take back the ACTIVE mode's value, not another mode's", () => {
    // Delete in Depth mode must not quietly discard a recession from a minute ago.
    let state = reducePerioEntry(start(), { type: "mode", mode: "gm" });
    state = digit(state, 3);
    state = reducePerioEntry(state, { type: "mode", mode: "depth" });
    state = digit(state, 5);
    state = press(state, "Backspace", "Backspace");
    expect(perioSite(state.chart, 1, "DB").depth).toBeNull();
    expect(perioSite(state.chart, 1, "DB").gm).toBe(3, 1 as unknown as string);
  });

  it("a reload keeps the mode she is working in", () => {
    let state = reducePerioEntry(start(), { type: "mode", mode: "mobility" });
    state = reducePerioEntry(state, { type: "load", chart: emptyPerioChart() });
    expect(state.mode).toBe("mobility");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 3 + 5 — what cannot be entered
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE 3 + 5: refused at ENTRY, with a reason", () => {
  const at = (mode: PerioMode, tooth: number) => {
    const state = initialPerioEntry(emptyPerioChart());
    return reducePerioEntry(
      { ...state, cursor: { tooth, surface: "DB" } },
      { type: "mode", mode },
    );
  };
  const enter = (state: PerioEntryState, value: number) => reducePerioEntry(state, { type: "number", value });

  it("mobility above 3 is refused, though Open Dental would take it", () => {
    for (const value of [4, 9, 10, 19]) {
      const after = enter(at("mobility", 3), value);
      expect(perioTooth(after.chart, 3).mobility).toBeNull();
      expect(after.refusal).toMatch(/Mobility is 0-3/);
    }
    // And the clinical range does go in.
    for (const value of [0, 1, 2, PERIO_MAX_MOBILITY]) {
      expect(perioTooth(enter(at("mobility", 3), value).chart, 3).mobility).toBe(value);
    }
  });

  it("furcation above class 3 is refused — there is no class 5", () => {
    for (const value of [0, 4, 5, 9]) {
      const after = enter(at("furcation", 3), value);
      expect(perioSite(after.chart, 3, "DB").furcation).toBeNull();
      expect(after.refusal).toMatch(/class/);
    }
    for (const value of [1, 2, PERIO_MAX_FURCATION]) {
      expect(perioSite(enter(at("furcation", 3), value).chart, 3, "DB").furcation).toBe(value);
    }
  });

  it("furcation on a single-rooted tooth is refused, and says why", () => {
    for (const tooth of [6, 8, 9, 22, 27]) {
      expect(perioToothHasFurcation(tooth)).toBe(false);
      const after = enter(at("furcation", tooth), 2);
      expect(perioSite(after.chart, tooth, "DB").furcation).toBeNull();
      expect(after.refusal).toMatch(/one root/);
    }
    // Molars and the two-rooted upper first premolars take one.
    for (const tooth of PERIO_FURCATION_TEETH) {
      expect(perioSite(enter(at("furcation", tooth), 2).chart, tooth, "DB").furcation).toBe(2);
    }
  });

  it("the furcation list is molars plus #5 and #12, and nothing else", () => {
    expect([...PERIO_FURCATION_TEETH].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 5, 12, 14, 15, 16, 17, 18, 19, 30, 31, 32,
    ]);
  });

  it("the OTHER gingival-margin family cannot be ENTERED at all", () => {
    // Not merely refused: there is no key sequence that produces one. The pad's
    // largest digit entry is Shift+9 = 19, which is the top of the recession family.
    for (const value of [20, 100, 101, 102, 119]) {
      const after = enter(at("gm", 3), value);
      expect(perioSite(after.chart, 3, "DB").gm).toBeNull();
      expect(after.refusal).toMatch(/Recession is 0-19/);
    }
    for (const value of [0, 1, 19]) {
      expect(perioSite(enter(at("gm", 3), value).chart, 3, "DB").gm).toBe(value);
    }
  });

  it("a literal negative is never produced — there is no key for it", () => {
    // Open Dental's own UI refused a negative too (§0), so this is parity. The
    // minus key is the number pad's PLAQUE flag, and only in depth mode.
    const action = keyToPerioAction({
      key: "-",
      code: "NumpadSubtract",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    });
    expect(action).toEqual({ type: "flag", flag: "plaque" });
  });

  it("the refusal clears the moment she does anything else", () => {
    const refused = enter(at("mobility", 3), 7);
    expect(refused.refusal).not.toBeNull();
    expect(reducePerioEntry(refused, { type: "move", step: 1 }).refusal).toBeNull();
  });

  it("a skipped tooth takes no reading in any mode", () => {
    for (const mode of PERIO_MODES) {
      const state = at(mode, 3);
      const skipped = { ...state, chart: withPerioSkipped(state.chart, 3, true) };
      const after = enter(skipped, 2);
      expect(after.chart).toEqual(skipped.chart);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 6 — absence over zero
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE 6: nothing entered means NO row", () => {
  it("an untouched chart plans no v2 rows at all", () => {
    const plan = planPerioSend(emptyPerioChart());
    expect(plan.rows.filter((r) => r.sequenceType === "GingMargin")).toEqual([]);
    expect(plan.rows.filter((r) => r.sequenceType === "Furcation")).toEqual([]);
    expect(plan.rows.filter((r) => r.sequenceType === "Mobility")).toEqual([]);
  });

  it("a tooth with only a depth gets no GingMargin row, and vice versa", () => {
    const depthOnly = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4 }));
    expect(planPerioSend(depthOnly).rows.some((r) => r.sequenceType === "GingMargin")).toBe(false);

    const gmOnly = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { gm: 2 }));
    const rows = planPerioSend(gmOnly).rows;
    expect(rows.some((r) => r.sequenceType === "GingMargin")).toBe(true);
    expect(rows.some((r) => r.sequenceType === "Probing")).toBe(false);
  });

  it("an uncharted site inside a charted tooth is -1, never 0", () => {
    const chart = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { gm: 0 }));
    const row = planPerioSend(chart).rows.find((r) => r.sequenceType === "GingMargin");
    expect(row).toBeTruthy();
    // DB carries the zero she measured; the other five say nothing.
    expect(row?.body.DBvalue).toBe(0);
    expect(row?.body.Bvalue).toBe(-1);
    expect(row?.body.MLvalue).toBe(-1);
    expect(row?.body.ToothValue).toBe(-1);
  });

  it("the three row shapes are exactly what the probe measured", () => {
    let chart = withPerioSite(emptyPerioChart(), 3, "B", { gm: 2 });
    chart = withPerioSite(chart, 3, "ML", { furcation: 3 });
    chart = withPerioMobility(chart, 30, 2);
    const rows = planPerioSend(normalizePerioChart(chart)).rows;

    const gm = rows.find((r) => r.sequenceType === "GingMargin");
    expect(gm?.body.ToothValue).toBe(-1);
    expect(gm?.body.Bvalue).toBe(2);

    const furcation = rows.find((r) => r.sequenceType === "Furcation");
    expect(furcation?.body.ToothValue).toBe(-1);
    expect(furcation?.body.MLvalue).toBe(3);

    const mobility = rows.find((r) => r.sequenceType === "Mobility");
    expect(mobility?.body.ToothValue).toBe(2);
    // EVERY surface -1, or Open Dental refuses the row.
    for (const key of ["MBvalue", "Bvalue", "DBvalue", "MLvalue", "Lvalue", "DLvalue"] as const) {
      expect(mobility?.body[key]).toBe(-1);
    }
  });

  it("the v2 rows come AFTER the v1 ones, so the send keeps its phases", () => {
    let chart = withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4, gm: 2 });
    chart = withPerioMobility(chart, 3, 1);
    const rows = planPerioSend(normalizePerioChart(chart)).rows;
    const lastV1 = Math.max(
      ...rows.map((r, i) => (["Probing", "BleedSupPlaqCalc", "SkipTooth"].includes(r.sequenceType) ? i : -1)),
    );
    const firstV2 = rows.findIndex((r) =>
      ["GingMargin", "Furcation", "Mobility"].includes(r.sequenceType),
    );
    expect(firstV2).toBeGreaterThan(lastV1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 4 — and CAL never reaches a payload
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE 4: no CAL ever reaches a payload", () => {
  it("a full v2 chart plans no CAL row, and no field named like one", () => {
    let chart = emptyPerioChart();
    for (let tooth = 1; tooth <= 32; tooth += 1) {
      for (const surface of ["DB", "B", "MB", "DL", "L", "ML"] as const) {
        chart = withPerioSite(chart, tooth, surface, { depth: 4, gm: 2 });
      }
      chart = withPerioMobility(chart, tooth, 1);
    }
    const plan = planPerioSend(normalizePerioChart(chart));
    for (const row of plan.rows) {
      expect(row.sequenceType).not.toMatch(/cal/i);
      expect(Object.keys(row.body).some((k) => /cal/i.test(k))).toBe(false);
    }
    // CAL is computable for those sites, and still goes nowhere near the plan.
    expect(perioCal(perioSite(normalizePerioChart(chart), 3, "DB"))).toBe(6);
    expect(JSON.stringify(plan)).not.toMatch(/cal/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 7 — the read-back sees the v2 rows; drift still does not
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE 7: the read-back compares every v2 value", () => {
  const withGm = (gm: number) => normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { gm }));

  it("a recession that came back different is a mismatch naming the site", () => {
    const mismatches = comparePerioReadback(withGm(2), withGm(3));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].kind).toBe("gm");
    expect(mismatches[0].tooth).toBe(3);
    expect(mismatches[0].expected).toBe("2 mm recession");
    expect(mismatches[0].found).toBe("3 mm recession");
  });

  it("a recession that came back in the OTHER family is a mismatch, not a match", () => {
    const mismatches = comparePerioReadback(withGm(2), withGm(102));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].found).toMatch(/unrecognised margin/);
  });

  it("a missing mobility row is a mismatch on the TOOTH, with no surface", () => {
    const want = normalizePerioChart(withPerioMobility(emptyPerioChart(), 30, 2));
    const mismatches = comparePerioReadback(want, emptyPerioChart());
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].kind).toBe("mobility");
    expect(mismatches[0].surface).toBeNull();
    expect(mismatches[0].expected).toBe("grade 2");
    expect(mismatches[0].found).toBe("not charted");
  });

  it("a furcation that did not land is a mismatch", () => {
    const want = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "B", { furcation: 2 }));
    const mismatches = comparePerioReadback(want, emptyPerioChart());
    expect(mismatches.map((m) => m.kind)).toEqual(["furcation"]);
  });

  it("an identical chart reads back with nothing to say", () => {
    let chart = withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4, gm: 2, furcation: 1 });
    chart = normalizePerioChart(withPerioMobility(chart, 3, 1));
    expect(comparePerioReadback(chart, chart)).toEqual([]);
  });

  it("DRIFT still answers the v1 question — the v2 kinds are filtered, not forgotten", () => {
    // 26b, ruled on in the report: widening drift means widening
    // PerioSiteChange.kind, which the drift notice and the resend dialog render.
    const changes = perioChartChanges(withGm(2), withGm(3));
    expect(changes).toEqual([]);
    // And a DEPTH change still comes through, so drift is not simply broken.
    const a = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4 }));
    const b = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { depth: 5 }));
    expect(perioChartChanges(a, b).map((c) => c.kind)).toEqual(["depth"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 8 — the preview, and therefore the fingerprint
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE 8: the preview moves when a v2 value moves", () => {
  const lines = (chart: PerioChart) => perioPreviewLines(chart).join("\n");

  it("names a recession per site, so an edit changes the preview", () => {
    const two = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4, gm: 2 }));
    const three = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4, gm: 3 }));
    expect(lines(two)).toMatch(/recession DB 2 mm/);
    expect(lines(two)).not.toBe(lines(three));
  });

  it("names a furcation class and a mobility grade too", () => {
    let chart = withPerioSite(emptyPerioChart(), 3, "B", { furcation: 2 });
    chart = normalizePerioChart(withPerioMobility(chart, 3, 1));
    expect(lines(chart)).toMatch(/furcation B class 2/);
    expect(lines(chart)).toMatch(/mobility grade 1/);
  });

  it("a chart with no v2 values says nothing about them", () => {
    const chart = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { depth: 4 }));
    expect(lines(chart)).not.toMatch(/recession/);
    expect(lines(chart)).not.toMatch(/mobility/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Counts, and item 28's rule
// ─────────────────────────────────────────────────────────────────────────────

describe("the counts, and what counts as a reading", () => {
  it("counts recession sites, furcation sites and mobility teeth", () => {
    let chart = withPerioSite(emptyPerioChart(), 3, "DB", { gm: 2 });
    chart = withPerioSite(chart, 3, "B", { gm: 0 });
    chart = withPerioSite(chart, 3, "ML", { furcation: 2 });
    chart = normalizePerioChart(withPerioMobility(chart, 30, 1));
    const counts = countPerioChart(chart);
    expect(counts.gmSites).toBe(2);
    expect(counts.furcationSites).toBe(1);
    expect(counts.mobilityTeeth).toBe(1);
    // The progress label still measures PROBING completeness.
    expect(counts.sitesCharted).toBe(0);
  });

  it("a recession IS a reading, so a chart of recessions can be staged (item 28)", () => {
    const gmOnly = normalizePerioChart(withPerioSite(emptyPerioChart(), 3, "DB", { gm: 2 }));
    expect(perioHasReading(countPerioChart(gmOnly))).toBe(true);
    const mobilityOnly = normalizePerioChart(withPerioMobility(emptyPerioChart(), 3, 1));
    expect(perioHasReading(countPerioChart(mobilityOnly))).toBe(true);

    // And item 28's rule is untouched: a skip is still not a measurement.
    const skipsOnly = normalizePerioChart(withPerioSkipped(emptyPerioChart(), 3, true));
    expect(countPerioChart(skipsOnly).empty).toBe(false);
    expect(perioHasReading(countPerioChart(skipsOnly))).toBe(false);
  });

  it("a tooth holding ONLY a mobility reading survives normalisation", () => {
    const chart = normalizePerioChart(withPerioMobility(emptyPerioChart(), 30, 0));
    expect(chart.teeth["30"]).toBeTruthy();
    expect(chart.teeth["30"].mobility).toBe(0);
  });

  it("mobility survives a change to one of the tooth's sites", () => {
    let chart = withPerioMobility(emptyPerioChart(), 3, 2);
    chart = withPerioSite(chart, 3, "DB", { depth: 4 });
    chart = withPerioSkipped(chart, 3, false);
    expect(perioTooth(normalizePerioChart(chart), 3).mobility).toBe(2);
  });
});
