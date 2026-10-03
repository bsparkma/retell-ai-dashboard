/**
 * Perio entry — what each key does to the chart (H4 slice 10).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A PURE REDUCER, SO THE ORDER CAN BE TESTED WITHOUT A SCREEN
 * ═════════════════════════════════════════════════════════════════════════════
 * The keyboard is the fast path at a chair and voice will be the faster one, and
 * both come down to the same three moves: a number lands on the current site
 * and the cursor steps to the next one in charting order; a flag lands on the
 * site that number went to; a tooth that is not there is skipped. Keeping that
 * here rather than in a component means "type 192 digits and the chart is full,
 * in order" is a statement a test can make about a function.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE KEYS
 * ═════════════════════════════════════════════════════════════════════════════
 *   0–9            a reading in the ACTIVE MODE, then advance
 *   Shift + 0–9    10–19, then advance (Open Dental's range stops at 19)
 *   D G M F        the four modes: Depth / Gingival margin / Mobility / Furcation
 *   B S P C        toggle bleeding / suppuration / plaque / calculus (DEPTH MODE ONLY)
 *   X              skip or un-skip the current tooth
 *   → Space Enter  next site, no reading
 *   ←              previous site
 *   Backspace      take back the last reading and go back to it
 *   Delete  Esc    clear the current site, cursor stays
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR MODES, ONE GRID, ONE WALK (item 26)
 * ═════════════════════════════════════════════════════════════════════════════
 * A digit means whatever the active mode says it means. Everything else — the
 * charting order, the skip, Backspace, Delete, the pad — behaves identically in
 * all four, because a hygienist mid-sweep should not have to relearn the keyboard
 * to record a recession.
 *
 *   Depth            0–19 mm probing depth, per site        (the v1 behaviour)
 *   Gingival margin  0–19 mm RECESSION, per site            (item 26 §0)
 *   Mobility         0–3, PER TOOTH — the walk advances by tooth, not by site
 *   Furcation        1–3, per site, on multi-rooted teeth only
 *
 * ⚠️ A DIGIT THE MODE CANNOT TAKE IS REFUSED HERE, IN THE REDUCER, AND SAYS WHY.
 * Open Dental would accept furcation class 5 and furcation on a central incisor
 * (item 19's probe, §7). Refusing at entry rather than at the transport means she
 * finds out while the probe is still in her hand, not halfway through a send.
 * `state.refusal` carries the sentence; any other action clears it.
 *
 * ⚠️ MODE IS NOT A MODIFIER ON THE FLAGS. B S P C do nothing outside Depth mode:
 * a flag rides a probing depth, and there is no such thing as bleeding on a
 * mobility reading.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE NUMBER PAD (item 17)
 * ═════════════════════════════════════════════════════════════════════════════
 * One hand on the probe, one on a Bluetooth number pad. The pad is a plain
 * keyboard, so it is only more keys — all of them in NUMPAD_KEYS below, the one
 * place the table lives:
 *
 *   /  *  -  +     bleeding / suppuration / plaque / calculus (same target as B S P C)
 *   .              skip or un-skip the current tooth (same as X)
 *   (  )           previous / next tooth — from the PAD only; see below
 *   Tab  =         reserved, unmapped
 *
 * `(` and `)` are tooth moves only when the PAD sends them (a Numpad code, or
 * the numpad key location). On the main row they are Shift+9 and Shift+0, which
 * have meant 19 mm and 10 mm since slice 10, and still do.
 *
 * NUM LOCK OFF IS NOT A READING. With Num Lock off the pad's digits arrive as
 * Home, End, PageUp, arrows and Clear. Those are reported by `perioKeyWarning`
 * and do NOTHING to the chart — a depth is never guessed from a navigation key.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHICH SITE A FLAG LANDS ON
 * ═════════════════════════════════════════════════════════════════════════════
 * "Three, two, three — bleeding." The flag belongs to the site just called,
 * but the cursor has already moved past it. So a flag lands on the LAST ENTERED
 * site while that is the most recent thing that happened, and on the cursor
 * otherwise (after moving, selecting, or before anything was typed). The page
 * names the target site beside the flag buttons, so this is never a guess the
 * hygienist has to make.
 */
import {
  PERIO_GM_FAMILIES,
  PERIO_MAX_DEPTH,
  PERIO_MAX_FURCATION,
  PERIO_MAX_MOBILITY,
  PERIO_MIN_FURCATION,
  chartingOrder,
  firstOpenPerioCursor,
  perioSite,
  perioTooth,
  perioToothHasFurcation,
  sameCursor,
  stepPerioCursor,
  withPerioMobility,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
  type PerioCursor,
  type PerioDirection,
  type PerioFlag,
  type PerioSegment,
} from "@shared/hyg/perio";

// ─────────────────────────────────────────────────────────────────────────────
// THE MODES (item 26) — one table, and the legend renders FROM it
// ─────────────────────────────────────────────────────────────────────────────
//
// Item 17's doctrine: the legend cannot promise what the reducer does not
// honour, so the keys live here and the screen reads them. A key added below
// without a reducer case is a compile error, not a lie on a legend.

export const PERIO_MODES = ["depth", "gm", "mobility", "furcation"] as const;
export type PerioMode = (typeof PERIO_MODES)[number];

export const PERIO_MODE_LABELS: Readonly<Record<PerioMode, string>> = Object.freeze({
  depth: "Depth",
  gm: "Gingival margin",
  mobility: "Mobility",
  furcation: "Furcation",
});

/** The key that switches to each mode. Not Shift-anything: one hand is holding a probe. */
export const PERIO_MODE_KEYS: Readonly<Record<PerioMode, string>> = Object.freeze({
  depth: "D",
  gm: "G",
  mobility: "M",
  furcation: "F",
});

/** What a digit means in each mode, in the words the legend prints. */
export const PERIO_MODE_RANGES: Readonly<Record<PerioMode, string>> = Object.freeze({
  depth: "0-19 mm",
  gm: "0-19 mm recession",
  mobility: "0-3",
  furcation: "1-3",
});

/** Per site, or per tooth? Mobility is the odd one, and the walk follows it. */
export const PERIO_MODE_SCOPE: Readonly<Record<PerioMode, "site" | "tooth">> = Object.freeze({
  depth: "site",
  gm: "site",
  mobility: "tooth",
  furcation: "site",
});

const MODE_BY_KEY: Readonly<Record<string, PerioMode>> = Object.freeze(
  Object.fromEntries(
    PERIO_MODES.map((mode) => [PERIO_MODE_KEYS[mode].toLowerCase(), mode]),
  ) as Record<string, PerioMode>,
);

export interface PerioEntryState {
  chart: PerioChart;
  cursor: PerioCursor;
  /** The site the last reading went to, while that is still the latest action. */
  lastEntered: PerioCursor | null;
  /** Which row a digit lands in (item 26). */
  mode: PerioMode;
  /**
   * Why the last digit was refused, for the screen to say. Cleared by every other
   * action, so it describes the thing that just happened and not a stale one.
   */
  refusal: string | null;
}

export type PerioEntryAction =
  /**
   * A digit. What it MEANS depends on `state.mode` — which is why this is not
   * called `depth` any more: the key cannot know the mode, and the reducer is the
   * one place that does.
   */
  | { type: "number"; value: number }
  | { type: "mode"; mode: PerioMode }
  | { type: "flag"; flag: PerioFlag }
  | { type: "move"; step: 1 | -1 }
  /** To the first site of the next or previous tooth in charting order. */
  | { type: "tooth"; step: 1 | -1 }
  | { type: "select"; cursor: PerioCursor }
  | { type: "erase" }
  | { type: "clear" }
  | { type: "toggleSkip" }
  | { type: "skipTeeth"; teeth: number[] }
  | { type: "sweep"; segment: PerioSegment; direction: PerioDirection }
  /** A chart from the server, replacing everything. The cursor starts over. */
  | { type: "load"; chart: PerioChart };

export function initialPerioEntry(chart: PerioChart): PerioEntryState {
  return {
    chart,
    cursor: firstOpenPerioCursor(chart),
    lastEntered: null,
    // Depth is where a chart starts and where most of it is spent.
    mode: "depth",
    refusal: null,
  };
}

/** Where a flag key lands. See the header. */
export function flagTarget(state: PerioEntryState): PerioCursor {
  return state.lastEntered ?? state.cursor;
}

/** The first chartable site after this tooth, in charting order. */
function siteAfterTooth(chart: PerioChart, from: PerioCursor): PerioCursor | null {
  const order = chartingOrder(chart.sweep);
  const at = order.findIndex((c) => sameCursor(c, from));
  for (let i = at + 1; i < order.length; i += 1) {
    if (order[i].tooth !== from.tooth && !perioTooth(chart, order[i].tooth).skipped) return order[i];
  }
  return null;
}

/**
 * The first site of the neighbouring tooth, in charting order, passing over
 * skipped teeth. "Tooth" here is the run of sites the sweep visits together — a
 * tooth is met twice in a full chart (facial, then lingual) — so `(` and `)` move
 * the way the cursor would, not across the mouth.
 */
function siteOfNeighbourTooth(chart: PerioChart, from: PerioCursor, step: 1 | -1): PerioCursor | null {
  if (step === 1) return siteAfterTooth(chart, from);
  const order = chartingOrder(chart.sweep);
  let i = order.findIndex((c) => sameCursor(c, from));
  // Back to the start of the run the cursor is in…
  while (i > 0 && order[i - 1].tooth === order[i].tooth) i -= 1;
  // …then back over the runs before it until one is chartable…
  for (let j = i - 1; j >= 0; j -= 1) {
    if (perioTooth(chart, order[j].tooth).skipped) continue;
    // …and to the START of that run.
    let k = j;
    while (k > 0 && order[k - 1].tooth === order[k].tooth) k -= 1;
    return order[k];
  }
  return null;
}

/**
 * Clear one reading, in the mode it was entered in.
 *
 * Deliberately NOT "clear everything at this site": Delete in Depth mode must not
 * silently throw away a recession she recorded a minute earlier.
 */
function clearInMode(chart: PerioChart, at: PerioCursor, mode: PerioMode): PerioChart {
  switch (mode) {
    case "mobility":
      return withPerioMobility(chart, at.tooth, null);
    case "gm":
      return withPerioSite(chart, at.tooth, at.surface, { gm: null });
    case "furcation":
      return withPerioSite(chart, at.tooth, at.surface, { furcation: null });
    case "depth":
      return withPerioSite(chart, at.tooth, at.surface, { depth: null });
  }
}

export function reducePerioEntry(state: PerioEntryState, action: PerioEntryAction): PerioEntryState {
  switch (action.type) {
    case "mode":
      return { ...state, mode: action.mode, lastEntered: null, refusal: null };
    case "number": {
      const { cursor, mode } = state;
      const value = action.value;
      if (!Number.isInteger(value)) return state;
      // A skipped tooth takes no reading, in any mode. Un-skip it first (X).
      if (perioTooth(state.chart, cursor.tooth).skipped) return state;

      /** Refuse, and SAY WHY — see the header. */
      const refuse = (refusal: string): PerioEntryState => ({ ...state, refusal, lastEntered: null });

      if (mode === "mobility") {
        if (value < 0 || value > PERIO_MAX_MOBILITY) {
          return refuse(
            `Mobility is ${0}-${PERIO_MAX_MOBILITY}. Open Dental would take more; a tooth does not.`,
          );
        }
        const chart = withPerioMobility(state.chart, cursor.tooth, value);
        // PER TOOTH, so the walk goes to the next tooth rather than the next site.
        const next = siteAfterTooth(chart, cursor);
        return { ...state, chart, cursor: next ?? cursor, lastEntered: cursor, refusal: null };
      }

      if (mode === "furcation") {
        if (!perioToothHasFurcation(cursor.tooth)) {
          return refuse(
            `#${cursor.tooth} has one root, so it has no furcation. Open Dental would store a class on it anyway.`,
          );
        }
        if (value < PERIO_MIN_FURCATION || value > PERIO_MAX_FURCATION) {
          return refuse(
            `Furcation classes are ${PERIO_MIN_FURCATION}-${PERIO_MAX_FURCATION}. There is no class ${value}.`,
          );
        }
        const chart = withPerioSite(state.chart, cursor.tooth, cursor.surface, { furcation: value });
        const next = stepPerioCursor(chart, cursor, 1);
        return { ...state, chart, cursor: next ?? cursor, lastEntered: cursor, refusal: null };
      }

      if (mode === "gm") {
        // §0: recession is the 0-19 family, and overgrowth cannot be typed here
        // because it cannot be typed in Open Dental's own chart either.
        if (value < PERIO_GM_FAMILIES.recessionMin || value > PERIO_GM_FAMILIES.recessionMax) {
          return refuse(
            `Recession is ${PERIO_GM_FAMILIES.recessionMin}-${PERIO_GM_FAMILIES.recessionMax} mm.`,
          );
        }
        const chart = withPerioSite(state.chart, cursor.tooth, cursor.surface, { gm: value });
        const next = stepPerioCursor(chart, cursor, 1);
        return { ...state, chart, cursor: next ?? cursor, lastEntered: cursor, refusal: null };
      }

      if (value < 0 || value > PERIO_MAX_DEPTH) return state;
      const chart = withPerioSite(state.chart, cursor.tooth, cursor.surface, { depth: value });
      const next = stepPerioCursor(chart, cursor, 1);
      // At the last site the cursor stays put: wrapping to #1 would put the
      // next number on a tooth charted minutes ago.
      return { ...state, chart, cursor: next ?? cursor, lastEntered: cursor, refusal: null };
    }
    case "flag": {
      // A flag rides a probing depth. There is no bleeding on a mobility grade.
      if (state.mode !== "depth") return state;
      const target = flagTarget(state);
      if (perioTooth(state.chart, target.tooth).skipped) return state;
      const current = perioSite(state.chart, target.tooth, target.surface)[action.flag];
      return {
        ...state,
        chart: withPerioSite(state.chart, target.tooth, target.surface, { [action.flag]: !current }),
        refusal: null,
      };
    }
    case "move": {
      const next = stepPerioCursor(state.chart, state.cursor, action.step);
      return { ...state, cursor: next ?? state.cursor, lastEntered: null, refusal: null };
    }
    case "tooth": {
      const next = siteOfNeighbourTooth(state.chart, state.cursor, action.step);
      return { ...state, cursor: next ?? state.cursor, lastEntered: null, refusal: null };
    }
    case "select":
      return { ...state, cursor: action.cursor, lastEntered: null, refusal: null };
    case "erase": {
      // Take back the reading just typed, or the one before the cursor — in the
      // ACTIVE mode, so Backspace undoes what the last digit actually did.
      const target = state.lastEntered ?? stepPerioCursor(state.chart, state.cursor, -1) ?? state.cursor;
      return {
        ...state,
        chart: clearInMode(state.chart, target, state.mode),
        cursor: target,
        lastEntered: null,
        refusal: null,
      };
    }
    case "clear":
      return {
        ...state,
        chart: clearInMode(state.chart, state.cursor, state.mode),
        lastEntered: null,
        refusal: null,
      };
    case "toggleSkip": {
      const { tooth } = state.cursor;
      const skipped = !perioTooth(state.chart, tooth).skipped;
      const chart = withPerioSkipped(state.chart, tooth, skipped);
      // Skipping moves on to the next tooth; un-skipping stays, ready for its first number.
      const cursor = skipped ? siteAfterTooth(chart, state.cursor) ?? state.cursor : state.cursor;
      return { ...state, chart, cursor, lastEntered: null, refusal: null };
    }
    case "skipTeeth": {
      let chart = state.chart;
      for (const tooth of action.teeth) chart = withPerioSkipped(chart, tooth, true);
      const cursor = perioTooth(chart, state.cursor.tooth).skipped
        ? firstOpenPerioCursor(chart)
        : state.cursor;
      return { ...state, chart, cursor, lastEntered: null, refusal: null };
    }
    case "sweep":
      return {
        ...state,
        chart: { ...state.chart, sweep: { ...state.chart.sweep, [action.segment]: action.direction } },
        refusal: null,
      };
    case "load":
      // A reload keeps the mode she is working in; it is a property of HER, not
      // of the chart that came back.
      return { ...initialPerioEntry(action.chart), mode: state.mode };
  }
}

/** The parts of a key event entry cares about — no DOM type, so tests need none. */
export interface PerioKey {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /**
   * `KeyboardEvent.location`: 3 is the numeric keypad. Optional because a test
   * or a synthetic event may not carry it; absent reads as "not the pad".
   */
  location?: number;
}

/** `KeyboardEvent.DOM_KEY_LOCATION_NUMPAD`, without reaching for the DOM. */
const NUMPAD_LOCATION = 3;

const FLAG_BY_KEY: Record<string, PerioFlag> = {
  b: "bleeding",
  s: "suppuration",
  p: "plaque",
  c: "calculus",
};

/**
 * THE NUMBER PAD'S TABLE (item 17). Keyed by `key` — what is printed on the cap
 * — because `/ * - +` send the same `key` with Num Lock on or off.
 */
export const NUMPAD_FLAG_KEYS: Readonly<Record<string, PerioFlag>> = Object.freeze({
  "/": "bleeding",
  "*": "suppuration",
  "-": "plaque",
  "+": "calculus",
});
export const NUMPAD_SKIP_KEY = ".";
export const NUMPAD_PREVIOUS_TOOTH_KEY = "(";
export const NUMPAD_NEXT_TOOTH_KEY = ")";
/** Reserved for a later version. They do nothing here, and Tab keeps its browser meaning. */
export const NUMPAD_RESERVED_KEYS: readonly string[] = Object.freeze(["Tab", "="]);

/**
 * What a pad's digit and decimal keys send with Num Lock OFF. Any of these,
 * arriving from a numpad code or location, is the signature.
 */
const NUM_LOCK_OFF_KEYS = new Set([
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Insert",
  "Delete",
  "Clear",
]);

const NUMPAD_DIGIT_CODE = /^Numpad(?:\d|Decimal)$/;

/** Did this key come from the number pad, by code or by location? */
function fromNumpad(e: PerioKey): boolean {
  return e.code.startsWith("Numpad") || e.location === NUMPAD_LOCATION;
}

/**
 * A key that is not a reading but LOOKS like the pad was used for one.
 *
 * `numLockOff`: a navigation key from the pad's digit block. With Num Lock off,
 * "7" is Home and "4" is ArrowLeft. The screen says so, and `keyToPerioAction`
 * returns null for the same key, so nothing lands in the chart.
 *
 * A pad's OWN dedicated Delete or arrow key sends a code equal to its key
 * (`code: "Delete"`), which is how it is told apart from Num Lock's `Numpad.`.
 */
export function perioKeyWarning(e: PerioKey): "numLockOff" | null {
  if (!NUM_LOCK_OFF_KEYS.has(e.key)) return null;
  if (NUMPAD_DIGIT_CODE.test(e.code)) return "numLockOff";
  if (e.location === NUMPAD_LOCATION && e.code !== e.key) return "numLockOff";
  return null;
}

/** A key press → what it does, or null for a key entry does not own. */
export function keyToPerioAction(e: PerioKey): PerioEntryAction | null {
  // Browser and OS shortcuts are not ours.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  // NEVER A DEPTH FROM A NAVIGATION KEY. Checked before the digit rule below,
  // which reads the CODE and would otherwise turn Num-Lock-off Home (Numpad7) into 7.
  if (perioKeyWarning(e) !== null) return null;

  // The pad's parentheses, before the digit rule: on the main row they are
  // Shift+9 and Shift+0, which are depths (19 and 10) and stay depths.
  if (fromNumpad(e) && e.key === NUMPAD_PREVIOUS_TOOTH_KEY) return { type: "tooth", step: -1 };
  if (fromNumpad(e) && e.key === NUMPAD_NEXT_TOOTH_KEY) return { type: "tooth", step: 1 };

  // By CODE, not key: Shift+3 is "#" as a key and still the 3 key physically.
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (digit) {
    const d = Number(digit[1]);
    return { type: "number", value: e.shiftKey ? 10 + d : d };
  }

  const lower = e.key.toLowerCase();
  // ITEM 26: the mode keys, BEFORE the flags — no letter is in both tables, and
  // a test asserts that, so this order is belt and braces rather than a rule.
  if (lower in MODE_BY_KEY) return { type: "mode", mode: MODE_BY_KEY[lower] };
  if (lower in FLAG_BY_KEY) return { type: "flag", flag: FLAG_BY_KEY[lower] };
  if (lower === "x") return { type: "toggleSkip" };

  const padFlag = NUMPAD_FLAG_KEYS[e.key];
  if (padFlag) return { type: "flag", flag: padFlag };
  // The pad's decimal key; a comma-decimal locale prints "," on the same cap.
  if (e.key === NUMPAD_SKIP_KEY || (e.code === "NumpadDecimal" && e.key === ",")) {
    return { type: "toggleSkip" };
  }

  switch (e.key) {
    case "ArrowRight":
    case " ":
    case "Enter":
      return { type: "move", step: 1 };
    case "ArrowLeft":
      return { type: "move", step: -1 };
    case "Backspace":
      return { type: "erase" };
    case "Delete":
    case "Escape":
      return { type: "clear" };
    default:
      return null;
  }
}
