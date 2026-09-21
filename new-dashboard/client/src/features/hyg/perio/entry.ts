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
 *   0–9            depth, then advance
 *   Shift + 0–9    10–19, then advance (Open Dental's range stops at 19)
 *   B S P C        toggle bleeding / suppuration / plaque / calculus
 *   X              skip or un-skip the current tooth
 *   → Space Enter  next site, no reading
 *   ←              previous site
 *   Backspace      take back the last reading and go back to it
 *   Delete  Esc    clear the current site, cursor stays
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
  PERIO_MAX_DEPTH,
  chartingOrder,
  firstOpenPerioCursor,
  perioSite,
  perioTooth,
  sameCursor,
  stepPerioCursor,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
  type PerioCursor,
  type PerioDirection,
  type PerioFlag,
  type PerioSegment,
} from "@shared/hyg/perio";

export interface PerioEntryState {
  chart: PerioChart;
  cursor: PerioCursor;
  /** The site the last depth went to, while that is still the latest action. */
  lastEntered: PerioCursor | null;
}

export type PerioEntryAction =
  | { type: "depth"; depth: number }
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
  return { chart, cursor: firstOpenPerioCursor(chart), lastEntered: null };
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

export function reducePerioEntry(state: PerioEntryState, action: PerioEntryAction): PerioEntryState {
  switch (action.type) {
    case "depth": {
      const { cursor } = state;
      if (!Number.isInteger(action.depth) || action.depth < 0 || action.depth > PERIO_MAX_DEPTH) {
        return state;
      }
      // A skipped tooth takes no reading. Un-skip it first (X), on purpose.
      if (perioTooth(state.chart, cursor.tooth).skipped) return state;
      const chart = withPerioSite(state.chart, cursor.tooth, cursor.surface, { depth: action.depth });
      const next = stepPerioCursor(chart, cursor, 1);
      // At the last site the cursor stays put: wrapping to #1 would put the
      // next number on a tooth charted minutes ago.
      return { chart, cursor: next ?? cursor, lastEntered: cursor };
    }
    case "flag": {
      const target = flagTarget(state);
      if (perioTooth(state.chart, target.tooth).skipped) return state;
      const current = perioSite(state.chart, target.tooth, target.surface)[action.flag];
      return {
        ...state,
        chart: withPerioSite(state.chart, target.tooth, target.surface, { [action.flag]: !current }),
      };
    }
    case "move": {
      const next = stepPerioCursor(state.chart, state.cursor, action.step);
      return { ...state, cursor: next ?? state.cursor, lastEntered: null };
    }
    case "tooth": {
      const next = siteOfNeighbourTooth(state.chart, state.cursor, action.step);
      return { ...state, cursor: next ?? state.cursor, lastEntered: null };
    }
    case "select":
      return { ...state, cursor: action.cursor, lastEntered: null };
    case "erase": {
      // Take back the reading just typed, or the one before the cursor.
      const target = state.lastEntered ?? stepPerioCursor(state.chart, state.cursor, -1) ?? state.cursor;
      return {
        chart: withPerioSite(state.chart, target.tooth, target.surface, { depth: null }),
        cursor: target,
        lastEntered: null,
      };
    }
    case "clear":
      return {
        ...state,
        chart: withPerioSite(state.chart, state.cursor.tooth, state.cursor.surface, { depth: null }),
        lastEntered: null,
      };
    case "toggleSkip": {
      const { tooth } = state.cursor;
      const skipped = !perioTooth(state.chart, tooth).skipped;
      const chart = withPerioSkipped(state.chart, tooth, skipped);
      // Skipping moves on to the next tooth; un-skipping stays, ready for its first number.
      const cursor = skipped ? siteAfterTooth(chart, state.cursor) ?? state.cursor : state.cursor;
      return { chart, cursor, lastEntered: null };
    }
    case "skipTeeth": {
      let chart = state.chart;
      for (const tooth of action.teeth) chart = withPerioSkipped(chart, tooth, true);
      const cursor = perioTooth(chart, state.cursor.tooth).skipped
        ? firstOpenPerioCursor(chart)
        : state.cursor;
      return { chart, cursor, lastEntered: null };
    }
    case "sweep":
      return {
        ...state,
        chart: { ...state.chart, sweep: { ...state.chart.sweep, [action.segment]: action.direction } },
      };
    case "load":
      return initialPerioEntry(action.chart);
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
    return { type: "depth", depth: e.shiftKey ? 10 + d : d };
  }

  const lower = e.key.toLowerCase();
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
