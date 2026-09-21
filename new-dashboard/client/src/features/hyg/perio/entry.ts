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
 *   Delete         clear the current site
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
}

const FLAG_BY_KEY: Record<string, PerioFlag> = {
  b: "bleeding",
  s: "suppuration",
  p: "plaque",
  c: "calculus",
};

/** A key press → what it does, or null for a key entry does not own. */
export function keyToPerioAction(e: PerioKey): PerioEntryAction | null {
  // Browser and OS shortcuts are not ours.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  // By CODE, not key: Shift+3 is "#" as a key and still the 3 key physically.
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (digit) {
    const d = Number(digit[1]);
    return { type: "depth", depth: e.shiftKey ? 10 + d : d };
  }

  const lower = e.key.toLowerCase();
  if (lower in FLAG_BY_KEY) return { type: "flag", flag: FLAG_BY_KEY[lower] };
  if (lower === "x") return { type: "toggleSkip" };

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
      return { type: "clear" };
    default:
      return null;
  }
}
