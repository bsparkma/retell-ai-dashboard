/**
 * The pure rules behind "Treatment identified today": how a tooth tap moves the
 * selection, how an add is split into requests, and what the confirmation says.
 *
 * Kept out of the component so each rule can be stated in a test without a
 * render — and so the sentence a hygienist reads after an add is built in ONE
 * place from what the server actually confirmed, never from what was asked for.
 */
import {
  ToothSurfaceLabelSchema,
  type TreatmentItem,
  type TreatmentItemInput,
  type ToothSurfaceLabel,
} from "@shared/hyg/contract";
import { teethText, toothText } from "./ToothPicker";

/** One tooth at a time (the default), or several at once. */
export type SelectionMode = "one" | "several";

/** In Several-teeth mode: one item per tooth, or one item spanning the set. */
export type SpreadMode = "each" | "across";

/**
 * A tooth tap, as the next selection.
 *
 * ONE TOOTH: a tap REPLACES the selection, and tapping the picked tooth clears
 * it. That is the fix for "the first tooth stays selected and the next add lands
 * on both".
 *
 * SEVERAL TEETH: a tap toggles the tooth in or out, in tap order.
 */
export function nextSelection(mode: SelectionMode, prev: readonly number[], tooth: number): number[] {
  if (mode === "one") return prev.length === 1 && prev[0] === tooth ? [] : [tooth];
  return prev.includes(tooth) ? prev.filter((t) => t !== tooth) : [...prev, tooth];
}

/**
 * Several → One keeps ONE tooth: the one she tapped last, if it is still picked;
 * otherwise the last one in the set. One → Several keeps what is there.
 */
export function selectionForMode(
  mode: SelectionMode,
  prev: readonly number[],
  lastTapped: number | null,
): number[] {
  if (mode === "several" || prev.length <= 1) return [...prev];
  if (lastTapped !== null && prev.includes(lastTapped)) return [lastTapped];
  return [prev[prev.length - 1]];
}

/** The line above the tabs: what the next add lands on. */
export function targetText(selected: readonly number[]): string {
  if (selected.length === 0) return "No tooth picked";
  const sorted = [...selected].sort((a, b) => a - b);
  return sorted.length === 1 ? `Tooth ${toothText(sorted[0])}` : `Teeth ${teethText(sorted)}`;
}

/** The one-line hint under the switch. */
export function modeHint(mode: SelectionMode, spread: SpreadMode): string {
  if (mode === "one") return "Tap a tooth to pick it. It stays picked after you add work.";
  return spread === "each"
    ? "Tap teeth to add or remove them. One item per tooth; the selection clears after you add."
    : "Tap teeth to add or remove them. One item across all of them; the selection clears after you add.";
}

/** Surfaces in chart order (M O D B L), whatever order they were tapped in. */
export function orderSurfaces(surfaces: readonly ToothSurfaceLabel[]): ToothSurfaceLabel[] {
  const order = ToothSurfaceLabelSchema.options;
  return order.filter((s) => surfaces.includes(s));
}

/** "Comp MO", or "Comp" with no surfaces. */
export function codeWithSurfaces(code: string, surfaces: readonly ToothSurfaceLabel[]): string {
  return surfaces.length > 0 ? `${code} ${orderSurfaces(surfaces).join("")}` : code;
}

/** Comp and Amal are written with surfaces, so a single-tooth add asks for them. */
export const SURFACE_CODES = new Set(["Comp", "Amal"]);

/**
 * The tooth sets one add sends, one request each.
 *
 * Whole mouth → one "mouth" request. One tooth, or Several "across" → one
 * request for the sorted set. Several "each" → one request per tooth, in tooth
 * order.
 */
export function requestTeeth(
  mouth: boolean,
  selected: readonly number[],
  mode: SelectionMode,
  spread: SpreadMode,
): (number[] | "mouth")[] {
  if (mouth) return ["mouth"];
  const sorted = [...selected].sort((a, b) => a - b);
  if (mode === "several" && spread === "each") return sorted.map((t) => [t]);
  return [sorted];
}

/** "#30", "#3, #14", "the whole mouth" — for a sentence. */
export function teethPhrase(teeth: readonly number[] | "mouth"): string {
  return teeth === "mouth" ? "the whole mouth" : teethText(teeth);
}

/**
 * The confirmation after an add, from what the SERVER confirmed.
 *
 * `added` and `failed` are the tooth sets the requests went to. `after` is what
 * happens to the selection now — and it is always said, because nothing clears
 * silently.
 */
export function addMessage(args: {
  label: string;
  added: readonly (number[] | "mouth")[];
  failed: readonly (number[] | "mouth")[];
  perTooth: boolean;
  after: { kind: "kept"; selected: readonly number[] } | { kind: "cleared" };
}): string {
  const { label, added, failed, perTooth, after } = args;
  const flat = (sets: readonly (number[] | "mouth")[]) =>
    sets.flatMap((s) => (s === "mouth" ? [] : s));

  if (added.length === 0) {
    const where = perTooth ? teethText(flat(failed)) : teethPhrase(failed[0] ?? []);
    return `${label} was not added to ${where}. Nothing changed${
      after.kind === "kept" && after.selected.length > 0 ? `; still on ${teethText(after.selected)}` : ""
    }.`;
  }

  if (failed.length > 0) {
    // NEVER CLAIM ALL. Name the teeth on each side of the line. (Only a
    // per-tooth add can half-succeed; every other add is one request.)
    return `Added ${label} to ${teethText(flat(added))}. Not added to ${teethText(
      flat(failed),
    )} — still selected, so you can try again.`;
  }

  let first: string;
  if (added[0] === "mouth") first = `Added ${label} (whole mouth).`;
  else if (perTooth && added.length > 1) first = `Added ${label} to ${added.length} teeth.`;
  else first = `Added ${label} on ${teethText(perTooth ? flat(added) : (added[0] as number[]))}.`;
  if (after.kind === "cleared") return `${first} Selection cleared.`;
  if (after.kind === "kept" && after.selected.length > 0) {
    return `${first} Still on ${teethText([...after.selected].sort((a, b) => a - b))}.`;
  }
  return first;
}

/** The fields an item was created with, so Undo of a remove re-creates the same item. */
export function itemToInput(item: TreatmentItem): TreatmentItemInput {
  const { id, createdBy, createdAt, ...input } = item;
  void id;
  void createdBy;
  void createdAt;
  return input;
}

/** "Crown on #30", "Whitening (whole mouth)", "Comp MO on #14". */
export function itemPhrase(item: Pick<TreatmentItem, "code" | "teeth" | "surfaces">): string {
  const label = codeWithSurfaces(item.code, item.surfaces ?? []);
  return item.teeth === "mouth" ? `${label} (whole mouth)` : `${label} on ${teethText(item.teeth)}`;
}

/** A thenable, told apart from a handler that returned nothing. */
export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
