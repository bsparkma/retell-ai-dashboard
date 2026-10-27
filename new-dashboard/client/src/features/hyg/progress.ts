/**
 * The day card's progress pill and step marks — the WORDS, in one place.
 *
 * The server decides the states (backend/services/hyg/visitProgress.js); this
 * only decides how each one reads on a card. Every mark carries its word:
 * tone is a second channel, never the only one, because a colour on an iPad in
 * a bright operatory is not something anybody can be asked to read.
 *
 * ⚠️ "PROGRESS UNAVAILABLE" IS NOT "NOT STARTED". ⚠️ `not_started` is the
 * server's claim that no visit exists. A card whose progress did not load, or
 * whose AptNum the answer did not include, has no claim at all — and reading it
 * as "nobody has started this visit" could send a second hygienist into a
 * patient's visit that is half done.
 */
import type { HygStepState, HygVisitOverall, HygVisitProgress } from "@shared/hyg/contract";

/** What a card knows about its own progress. */
export type CardProgress =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; value: HygVisitProgress };

export type ProgressTone = "sent" | "ready" | "neutral" | "attention" | "unavailable";

export const OVERALL_LABELS: Record<HygVisitOverall, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  ready_to_send: "Ready to send",
  sent: "Sent",
  needs_attention: "Needs attention",
};

export const OVERALL_TONES: Record<HygVisitOverall, ProgressTone> = {
  not_started: "neutral",
  in_progress: "neutral",
  ready_to_send: "ready",
  sent: "sent",
  needs_attention: "attention",
};

/** The pill's text and tone for any card state, unavailable included. */
export function summaryPill(progress: CardProgress): { label: string; tone: ProgressTone } | null {
  if (progress.kind === "loading") return null;
  if (progress.kind === "unavailable") return { label: "Progress unavailable", tone: "unavailable" };
  const overall = progress.value.overall;
  return { label: OVERALL_LABELS[overall], tone: OVERALL_TONES[overall] };
}

export type StepKey = "note" | "slip" | "perio" | "tc";

const STEP_NAMES: Record<StepKey, string> = {
  note: "Note",
  // The office calls this paper the ROUTER. The step key stays `slip`.
  slip: "Router",
  perio: "Perio",
  tc: "TC",
};

export interface StepMark {
  key: StepKey;
  /** What is drawn. Always a word; never only a glyph. */
  text: string;
  /** Read by a screen reader after `text`, where `text` leans on a symbol. */
  srText: string | null;
  tone: ProgressTone;
}

function markFor(key: StepKey, state: HygStepState): StepMark | null {
  const name = STEP_NAMES[key];
  switch (state) {
    case "not_applicable":
      // Hidden: a step this visit does not owe is not a step to draw.
      return null;
    case "none":
      return { key, text: `${name} —`, srText: "not started", tone: "neutral" };
    case "drafting":
      return { key, text: `${name}: Drafting`, srText: null, tone: "neutral" };
    case "ready":
      return { key, text: `${name}: Ready`, srText: null, tone: "ready" };
    case "sending":
      return { key, text: `${name}: Sending…`, srText: null, tone: "neutral" };
    case "written":
      // TC's write is a case in the coordinator's queue, not a chart entry.
      return {
        key,
        text: key === "tc" ? `${name} ✓ Handed off` : `${name} ✓ In chart`,
        srText: null,
        tone: "sent",
      };
    case "failed":
      return { key, text: `${name}: Failed`, srText: null, tone: "attention" };
  }
}

/** The step marks for a visit, in send order. Empty when there is no visit. */
export function stepMarks(progress: HygVisitProgress): StepMark[] {
  const steps = progress.steps;
  if (steps === null) return [];
  const marks: StepMark[] = [];
  for (const key of ["note", "slip", "perio"] as const) {
    const mark = markFor(key, steps[key].state);
    if (mark) marks.push(mark);
  }
  const tc = steps.tc;
  // The checkout alert is the more useful sentence while the handoff is merely
  // pending — but it never covers a failure, and never a landed handoff.
  if (tc.checkoutAlerted && tc.state !== "failed" && tc.state !== "written") {
    marks.push({ key: "tc", text: "TC: Checkout alerted", srText: null, tone: "neutral" });
  } else {
    const mark = markFor("tc", tc.state);
    if (mark) marks.push(mark);
  }
  return marks;
}

/** Tailwind classes per tone. Unavailable is dashed — a question, not a state. */
export const TONE_CLASSES: Record<ProgressTone, string> = {
  sent: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300",
  ready: "bg-blue-100 text-blue-900 dark:bg-blue-950/50 dark:text-blue-300",
  neutral: "bg-muted text-muted-foreground",
  attention: "bg-red-100 text-red-900 dark:bg-red-950/50 dark:text-red-300",
  unavailable: "border border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground",
};

/**
 * The AptNums to ask about, from the day already on screen.
 *
 * Positive, deduped, and at most 200 — the server's cap. A day bigger than that
 * is not a day this office has; the cards past it read "Progress unavailable"
 * rather than being guessed.
 */
export function progressAptNums(appointments: ReadonlyArray<{ aptNum: number | null }>): number[] {
  const seen = new Set<number>();
  for (const a of appointments) {
    if (a.aptNum !== null && a.aptNum > 0) seen.add(a.aptNum);
  }
  return Array.from(seen).slice(0, 200);
}

/** The card state for one AptNum, given the page's progress read. */
export function cardProgressFor(
  aptNum: number | null,
  read: { status: "loading" | "failed" | "ready"; byApt: ReadonlyMap<number, HygVisitProgress> },
): CardProgress {
  if (read.status === "loading") return { kind: "loading" };
  if (read.status === "failed" || aptNum === null) return { kind: "unavailable" };
  const value = read.byApt.get(aptNum);
  return value ? { kind: "ready", value } : { kind: "unavailable" };
}
