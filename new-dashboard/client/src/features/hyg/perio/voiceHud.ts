/**
 * Perio voice HUD (queue item 36) — what the HUD shows, as PURE functions.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PRESENTATION ONLY
 * ═════════════════════════════════════════════════════════════════════════════
 * Everything here is read off state item 35 already keeps: the sheet's entry
 * state (chart, cursor, last-entered site) and the parse of the last final.
 * Nothing here charts, nothing here talks to a server. The one place a spoken
 * phrase's EFFECT is worked out (`voiceOutcome`) runs the sheet's own reducer on
 * a copy, so the ribbon can only ever say what the sheet itself did — it never
 * keeps a second opinion about where a depth landed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE WINDOW
 * ═════════════════════════════════════════════════════════════════════════════
 * Five teeth of the CURRENT ARCH, in the sheet's screen order (upper #1→#16,
 * lower #32→#17), centred on the cursor's tooth and clamped at the arch ends —
 * so #1 shows #1–#5 and #16 shows #12–#16, never a tooth from the other arch.
 */
import type { ToothSurface } from "@shared/hyg/contract";
import {
  PERIO_FLAGS,
  PERIO_UPPER_TEETH,
  PERIO_LOWER_TEETH,
  perioSideOf,
  perioSite,
  perioTooth,
  screenSites,
  type PerioChart,
  type PerioCursor,
  type PerioFlag,
  type PerioSide,
} from "@shared/hyg/perio";
import { reducePerioEntry, type PerioEntryState } from "./entry";
import { describeVoiceCommands, type VoiceCommand, type VoiceRejectReason } from "./voiceGrammar";

export const HUD_WINDOW_SIZE = 5;

/** The arch a tooth is on, in the sheet's on-screen order. */
export function hudArchTeeth(tooth: number): readonly number[] {
  return tooth <= 16 ? PERIO_UPPER_TEETH : PERIO_LOWER_TEETH;
}

/** Five teeth of the cursor's arch, centred on it, clamped at the arch ends. */
export function hudWindow(tooth: number): number[] {
  const arch = hudArchTeeth(tooth);
  const at = Math.max(0, arch.indexOf(tooth));
  const start = Math.min(Math.max(0, at - Math.floor(HUD_WINDOW_SIZE / 2)), arch.length - HUD_WINDOW_SIZE);
  return arch.slice(start, start + HUD_WINDOW_SIZE);
}

export interface HudPass {
  arch: "upper" | "lower";
  side: PerioSide;
  /** "Upper buccal pass" — the mockup's word for the facial sweep. */
  label: string;
}

export function hudPass(cursor: PerioCursor): HudPass {
  const arch = cursor.tooth <= 16 ? "upper" : "lower";
  const side = perioSideOf(cursor.surface);
  return {
    arch,
    side,
    label: `${arch === "upper" ? "Upper" : "Lower"} ${side === "facial" ? "buccal" : "lingual"} pass`,
  };
}

/** A tooth's side is charted when all three of its sites have a depth. */
function sideCharted(chart: PerioChart, tooth: number, side: PerioSide): boolean {
  return screenSites(tooth, side).every((s) => perioSite(chart, tooth, s).depth !== null);
}

/** "N of 16 charted" for the pass the cursor is on. A skipped tooth is not charted. */
export function hudPassProgress(chart: PerioChart, pass: HudPass): { charted: number; skipped: number; total: number } {
  const teeth = pass.arch === "upper" ? PERIO_UPPER_TEETH : PERIO_LOWER_TEETH;
  let charted = 0;
  let skipped = 0;
  for (const tooth of teeth) {
    if (perioTooth(chart, tooth).skipped) skipped += 1;
    else if (sideCharted(chart, tooth, pass.side)) charted += 1;
  }
  return { charted, skipped, total: teeth.length };
}

export type HudTag = "NOW" | "DONE" | "SKIPPED" | "NEXT";

export interface HudSiteValue {
  surface: ToothSurface;
  depth: number | null;
}

export interface HudCard {
  tooth: number;
  tag: HudTag;
  /** The pass being charted, in the sheet's screen order. */
  active: HudSiteValue[];
  /** The other surface's three, for the small gray row. */
  other: HudSiteValue[];
  /** The site the next depth lands on — on the NOW card only, and never on a skipped tooth. */
  ringed: ToothSurface | null;
  skipped: boolean;
  /** Any flag set on any of the tooth's six sites. */
  flags: PerioFlag[];
}

export function hudCard(chart: PerioChart, tooth: number, cursor: PerioCursor): HudCard {
  const side = perioSideOf(cursor.surface);
  const otherSide: PerioSide = side === "facial" ? "lingual" : "facial";
  const values = (s: PerioSide): HudSiteValue[] =>
    screenSites(tooth, s).map((surface) => ({ surface, depth: perioSite(chart, tooth, surface).depth }));
  const skipped = perioTooth(chart, tooth).skipped;
  // NOW wins over SKIPPED: a jump or a tap can leave the cursor on a skipped
  // tooth, and the strip must still say where she is (the card says skipped).
  const tag: HudTag = tooth === cursor.tooth
    ? "NOW"
    : skipped
      ? "SKIPPED"
      : sideCharted(chart, tooth, side)
        ? "DONE"
        : "NEXT";
  const all = [...screenSites(tooth, "facial"), ...screenSites(tooth, "lingual")];
  const flags = PERIO_FLAGS.filter((f) => all.some((s) => perioSite(chart, tooth, s)[f]));
  return {
    tooth,
    tag,
    active: values(side),
    other: values(otherSide),
    ringed: tag === "NOW" && !skipped ? cursor.surface : null,
    skipped,
    flags,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HEARD RIBBON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ITEM 37: every kind may carry `said` — Azure's DISPLAY text for the final,
 * shown under the headline so she can see what was recognized. The parser read
 * the lexical form; this is the human-readable one. Page memory only.
 */
export type HudHeard =
  /** Parsed and charted. `heard` is the commands echoed back. */
  | { kind: "accepted"; heard: string; happened: string; said?: string }
  /** The grammar refused the final (item 35's five classes). */
  | { kind: "rejected"; reason: VoiceRejectReason; heard: string; message: string; said?: string }
  /** Parsed, but the sheet refused it (skipped tooth, end of chart, not Depth mode…). */
  | { kind: "refused"; heard: string; message: string; said?: string };

function joinTeeth(teeth: number[]): string {
  return teeth.length === 1 ? `tooth ${teeth[0]}` : `teeth ${teeth.join(", ")}`;
}

/**
 * What one parsed final does to the sheet, in words, worked out by running the
 * sheet's OWN reducer on `before`. Applied all or nothing there, so it is judged
 * all or nothing here: if the sheet would refuse it, this says `refused` with
 * the sheet's own sentence.
 */
export function voiceOutcome(before: PerioEntryState, commands: readonly VoiceCommand[]): HudHeard {
  const heard = describeVoiceCommands(commands);
  const after = reducePerioEntry(before, { type: "voice", commands });
  if (after.refusal !== null) return { kind: "refused", heard, message: after.refusal };

  // Step one command at a time — the same moves the batch made — to name them.
  const parts: string[] = [];
  let charted: number[] = [];
  const flushCharted = () => {
    if (charted.length > 0) parts.push(`charted to ${joinTeeth(charted)}`);
    charted = [];
  };
  let s = before;
  let lastWasMove = false;
  for (const command of commands) {
    const prev = s;
    s = reducePerioEntry(s, { type: "voice", commands: [command] });
    lastWasMove = false;
    switch (command.type) {
      case "depth":
        if (!charted.includes(prev.cursor.tooth)) charted.push(prev.cursor.tooth);
        break;
      case "flag": {
        flushCharted();
        const at = prev.lastEntered ?? prev.cursor;
        parts.push(`${command.flag} on ${at.tooth} ${at.surface}`);
        break;
      }
      case "skipTooth":
        flushCharted();
        parts.push(`skipped tooth ${prev.cursor.tooth}`);
        break;
      case "missing":
        flushCharted();
        parts.push(`tooth ${prev.cursor.tooth} marked missing`);
        break;
      case "jump":
      case "goBack":
        flushCharted();
        parts.push(`moved to tooth ${s.cursor.tooth} ${s.cursor.surface}`);
        lastWasMove = true;
        break;
      case "undo":
        flushCharted();
        parts.push(`took back ${s.cursor.tooth} ${s.cursor.surface}`);
        lastWasMove = true;
        break;
    }
  }
  flushCharted();
  if (!lastWasMove && after.cursor.tooth !== before.cursor.tooth) {
    parts.push(`moved to tooth ${after.cursor.tooth}`);
  }
  return { kind: "accepted", heard, happened: parts.join(" · ") };
}

/** m:ss left, never negative. */
export function hudRemaining(endsAt: number, now: number): string {
  const total = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The cue row — what may be said, in the words it is said in. */
export const HUD_CUES: readonly string[] = Object.freeze([
  "three two three",
  ...PERIO_FLAGS,
  "skip this tooth",
  "missing",
  "jump to tooth fourteen",
  "go back to tooth three MB",
  "undo",
]);
