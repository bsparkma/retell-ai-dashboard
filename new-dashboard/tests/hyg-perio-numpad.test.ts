/**
 * BLUETOOTH NUMBER PAD KEYS FOR PERIO ENTRY (item 17) — the key map, as a
 * function, one test per row of the brief's table.
 *
 *   0–9     depth (unchanged, incl. Shift for 10–19)     Enter    next site, no reading
 *   /       bleeding    *  suppuration                    .        skip / un-skip the tooth
 *   -       plaque      +  calculus                       Backspace  step back and erase
 *   Delete / Esc   erase here, cursor stays               ( )      previous / next tooth
 *   Tab, =  unmapped (reserved)
 *
 * And the honesty rule: with Num Lock off the pad's digits arrive as Home, End,
 * arrows and Clear. Those are FLAGGED and chart NOTHING.
 *
 * entry.ts is DOM-free, so none of this needs a DOM.
 */
import { describe, expect, it } from "vitest";

import { chartingOrder, emptyPerioChart, perioSite, type PerioChart } from "@shared/hyg/perio";
import {
  initialPerioEntry,
  keyToPerioAction,
  perioKeyWarning,
  reducePerioEntry,
  type PerioEntryState,
  type PerioKey,
} from "@/features/hyg/perio/entry";

/** A key from the NUMBER PAD: `location` 3, the numpad codes a real pad sends. */
function pad(key: string, code: string, over: Partial<PerioKey> = {}): PerioKey {
  return { key, code, location: 3, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over };
}
/** A key from the main keyboard. */
function kb(key: string, code: string, over: Partial<PerioKey> = {}): PerioKey {
  return { key, code, location: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over };
}

function press(state: PerioEntryState, k: PerioKey): PerioEntryState {
  const action = keyToPerioAction(k);
  return action ? reducePerioEntry(state, action) : state;
}
function pressAll(state: PerioEntryState, keys: PerioKey[]): PerioEntryState {
  return keys.reduce(press, state);
}

const at = (s: PerioEntryState) => `#${s.cursor.tooth} ${s.cursor.surface}`;
const fresh = () => initialPerioEntry(emptyPerioChart());
const depthAt = (chart: PerioChart, tooth: number, surface: "DB" | "B" | "MB") => perioSite(chart, tooth, surface).depth;

const PAD_DIGIT = (d: number) => pad(String(d), `Numpad${d}`);

describe("ACCEPTANCE 1: every key in the table does its action", () => {
  it("0–9 from the pad: depth on the current site, then the next site", () => {
    let s = fresh();
    for (let d = 0; d <= 9; d += 1) s = press(s, PAD_DIGIT(d));
    const order = chartingOrder(s.chart.sweep);
    for (let d = 0; d <= 9; d += 1) {
      expect(perioSite(s.chart, order[d].tooth, order[d].surface).depth).toBe(d);
    }
    expect(at(s)).toBe(`#${order[10].tooth} ${order[10].surface}`);
  });

  it("≥10 mm is unchanged: Shift + a main-row digit is 10–19", () => {
    let s = fresh();
    s = press(s, kb("(", "Digit9", { shiftKey: true }));
    s = press(s, kb(")", "Digit0", { shiftKey: true }));
    expect(depthAt(s.chart, 1, "DB")).toBe(19);
    expect(depthAt(s.chart, 1, "B")).toBe(10);
  });

  it("Enter (the pad's) moves to the next site with no reading", () => {
    const s = press(fresh(), pad("Enter", "NumpadEnter"));
    expect(at(s)).toBe("#1 B");
    expect(depthAt(s.chart, 1, "DB")).toBeNull();
  });

  it.each([
    ["/", "NumpadDivide", "bleeding"],
    ["*", "NumpadMultiply", "suppuration"],
    ["-", "NumpadSubtract", "plaque"],
    ["+", "NumpadAdd", "calculus"],
  ] as const)("%s is %s", (key, code, flag) => {
    const s = pressAll(fresh(), [PAD_DIGIT(4), pad(key, code)]);
    expect(perioSite(s.chart, 1, "DB")[flag]).toBe(true);
    // Toggles, like its letter twin.
    expect(perioSite(press(s, pad(key, code)).chart, 1, "DB")[flag]).toBe(false);
  });

  it(". skips the current tooth and moves on; . again on it un-skips", () => {
    let s = press(fresh(), pad(".", "NumpadDecimal"));
    expect(s.chart.teeth["1"].skipped).toBe(true);
    expect(at(s)).toBe("#2 DB");
    s = press(s, pad("(", "NumpadParenLeft")); // skipped #1 is passed over: nowhere to go back to
    expect(at(s)).toBe("#2 DB");
    s = reducePerioEntry(s, { type: "select", cursor: { tooth: 1, surface: "DB" } });
    s = press(s, pad(".", "NumpadDecimal"));
    expect(s.chart.teeth["1"].skipped).toBe(false);
    // A comma-decimal pad prints "," on the same key, and it does the same thing.
    expect(keyToPerioAction(pad(",", "NumpadDecimal"))).toEqual({ type: "toggleSkip" });
  });

  it("( and ) go to the first site of the previous and next tooth", () => {
    let s = press(fresh(), pad(")", "NumpadParenRight"));
    expect(at(s)).toBe("#2 DB");
    s = press(s, PAD_DIGIT(3)); // #2 B, mid-tooth
    s = press(s, pad(")", "NumpadParenRight"));
    expect(at(s)).toBe("#3 DB");
    s = press(s, PAD_DIGIT(3)); // #3 B
    s = press(s, pad("(", "NumpadParenLeft"));
    expect(at(s)).toBe("#2 DB", "to the START of the previous tooth, not its last site");
    s = press(s, pad("(", "NumpadParenLeft"));
    expect(at(s)).toBe("#1 DB");
    s = press(s, pad("(", "NumpadParenLeft"));
    expect(at(s)).toBe("#1 DB", "the first tooth has nothing before it");
    // Nothing was charted by moving.
    expect(depthAt(s.chart, 1, "DB")).toBeNull();
  });

  it(") passes over a skipped tooth", () => {
    let s = reducePerioEntry(fresh(), { type: "skipTeeth", teeth: [2] });
    s = press(s, pad(")", "NumpadParenRight"));
    expect(at(s)).toBe("#3 DB");
    s = press(s, pad("(", "NumpadParenLeft"));
    expect(at(s)).toBe("#1 DB");
  });

  it("( and ) from a pad that reports only the numpad LOCATION still move teeth", () => {
    expect(keyToPerioAction(pad("(", "", { location: 3 }))).toEqual({ type: "tooth", step: -1 });
    expect(keyToPerioAction(pad(")", "", { location: 3 }))).toEqual({ type: "tooth", step: 1 });
  });

  it("Tab and = are reserved: they do nothing", () => {
    expect(keyToPerioAction(pad("Tab", "Tab", { location: 0 }))).toBeNull();
    expect(keyToPerioAction(pad("=", "NumpadEqual"))).toBeNull();
    expect(keyToPerioAction(kb("=", "Equal"))).toBeNull();
  });
});

describe("ACCEPTANCE 2: flag keys land where their letter twins land", () => {
  it.each([
    [["/", "NumpadDivide"], "KeyB", "b"],
    [["*", "NumpadMultiply"], "KeyS", "s"],
    [["-", "NumpadSubtract"], "KeyP", "p"],
    [["+", "NumpadAdd"], "KeyC", "c"],
  ] as const)("%s behaves exactly like %s", ([padKey, padCode], letterCode, letter) => {
    // The same three scenarios the flag target rule exists for: just after a
    // reading, after moving on, and before anything was typed.
    const scripts: PerioKey[][] = [
      [PAD_DIGIT(3)],
      [PAD_DIGIT(3), pad("Enter", "NumpadEnter")],
      [],
    ];
    for (const before of scripts) {
      const viaPad = pressAll(fresh(), [...before, pad(padKey, padCode)]);
      const viaLetter = pressAll(fresh(), [...before, kb(letter, letterCode)]);
      expect(viaPad.chart).toEqual(viaLetter.chart);
      expect(viaPad.cursor).toEqual(viaLetter.cursor);
      expect(viaPad.lastEntered).toEqual(viaLetter.lastEntered);
    }
  });
});

describe("ACCEPTANCE 3: Backspace steps back and erases; Delete and Esc erase in place", () => {
  it("Backspace takes back the reading just typed, and the cursor goes to it", () => {
    let s = pressAll(fresh(), [PAD_DIGIT(3), PAD_DIGIT(4)]); // #1 DB = 3, #1 B = 4, cursor #1 MB
    s = press(s, kb("Backspace", "Backspace"));
    expect(depthAt(s.chart, 1, "B")).toBeNull();
    expect(depthAt(s.chart, 1, "DB")).toBe(3);
    expect(at(s)).toBe("#1 B");
    // Again: one more site back, and that one is erased too.
    s = press(s, kb("Backspace", "Backspace"));
    expect(depthAt(s.chart, 1, "DB")).toBeNull();
    expect(at(s)).toBe("#1 DB");
  });

  it("Backspace after a move still steps back one site and erases it", () => {
    let s = pressAll(fresh(), [PAD_DIGIT(3), PAD_DIGIT(4), PAD_DIGIT(5)]); // cursor #2 DB
    s = press(s, pad("Enter", "NumpadEnter")); // #2 B, nothing typed since the move
    s = press(s, kb("Backspace", "Backspace"));
    expect(at(s)).toBe("#2 DB");
    expect(depthAt(s.chart, 1, "MB")).toBe(5);
  });

  it.each([
    ["Delete", "Delete"],
    ["Escape", "Escape"],
  ])("%s erases the current site and the cursor stays", (key, code) => {
    let s = pressAll(fresh(), [PAD_DIGIT(3), PAD_DIGIT(4)]);
    s = reducePerioEntry(s, { type: "select", cursor: { tooth: 1, surface: "DB" } });
    s = press(s, kb(key, code));
    expect(depthAt(s.chart, 1, "DB")).toBeNull();
    expect(depthAt(s.chart, 1, "B")).toBe(4);
    expect(at(s)).toBe("#1 DB");
  });

  it("a pad's OWN Delete key (code Delete) erases; it is not mistaken for Num Lock", () => {
    expect(perioKeyWarning(pad("Delete", "Delete"))).toBeNull();
    expect(keyToPerioAction(pad("Delete", "Delete"))).toEqual({ type: "clear" });
  });
});

describe("ACCEPTANCE 4: Num Lock off is flagged and never writes a reading", () => {
  // What a pad's digit block sends with Num Lock off.
  const numLockOff: [string, string][] = [
    ["Insert", "Numpad0"],
    ["End", "Numpad1"],
    ["ArrowDown", "Numpad2"],
    ["PageDown", "Numpad3"],
    ["ArrowLeft", "Numpad4"],
    ["Clear", "Numpad5"],
    ["ArrowRight", "Numpad6"],
    ["Home", "Numpad7"],
    ["ArrowUp", "Numpad8"],
    ["PageUp", "Numpad9"],
    ["Delete", "NumpadDecimal"],
  ];

  it.each(numLockOff)("%s from %s is flagged, and does nothing", (key, code) => {
    const k = pad(key, code);
    expect(perioKeyWarning(k)).toBe("numLockOff");
    expect(keyToPerioAction(k)).toBeNull();
  });

  it("a whole quadrant typed with Num Lock off charts NOTHING and moves nowhere", () => {
    const start = pressAll(fresh(), [PAD_DIGIT(3)]);
    const after = pressAll(start, numLockOff.map(([key, code]) => pad(key, code)));
    expect(after).toEqual(start);
  });

  it("the signature needs the pad: the main keyboard's own arrows and Delete are not flagged", () => {
    for (const k of [
      kb("ArrowLeft", "ArrowLeft"),
      kb("ArrowRight", "ArrowRight"),
      kb("Home", "Home"),
      kb("Delete", "Delete"),
    ]) {
      expect(perioKeyWarning(k)).toBeNull();
    }
    // …and a navigation key reporting the pad LOCATION with no numpad code is.
    expect(perioKeyWarning(pad("Home", "", { location: 3 }))).toBe("numLockOff");
  });

  it("the pad's operator keys work the same with Num Lock off — they are not navigation", () => {
    expect(perioKeyWarning(pad("/", "NumpadDivide"))).toBeNull();
    expect(keyToPerioAction(pad("+", "NumpadAdd"))).toEqual({ type: "flag", flag: "calculus" });
  });
});

describe("ACCEPTANCE 5: letter keys are unchanged", () => {
  it.each([
    [kb("b", "KeyB"), { type: "flag", flag: "bleeding" }],
    [kb("s", "KeyS"), { type: "flag", flag: "suppuration" }],
    [kb("p", "KeyP"), { type: "flag", flag: "plaque" }],
    [kb("c", "KeyC"), { type: "flag", flag: "calculus" }],
    [kb("x", "KeyX"), { type: "toggleSkip" }],
    [kb("X", "KeyX", { shiftKey: true }), { type: "toggleSkip" }],
    [kb("ArrowRight", "ArrowRight"), { type: "move", step: 1 }],
    [kb(" ", "Space"), { type: "move", step: 1 }],
    [kb("Enter", "Enter"), { type: "move", step: 1 }],
    [kb("ArrowLeft", "ArrowLeft"), { type: "move", step: -1 }],
    [kb("Backspace", "Backspace"), { type: "erase" }],
    [kb("Delete", "Delete"), { type: "clear" }],
    [kb("7", "Digit7"), { type: "depth", depth: 7 }],
    [kb("@", "Digit2", { shiftKey: true }), { type: "depth", depth: 12 }],
  ] as const)("%o", (k, action) => {
    expect(keyToPerioAction(k)).toEqual(action);
  });

  it("shortcuts stay the browser's", () => {
    expect(keyToPerioAction(kb("c", "KeyC", { ctrlKey: true }))).toBeNull();
    expect(keyToPerioAction(pad("+", "NumpadAdd", { metaKey: true }))).toBeNull();
  });
});
