/**
 * Disposition vocabulary for the UI — labels, icons and colors in ONE place.
 *
 * Pure and framework-free (icons are components, not JSX) so the worklist row,
 * the picker, the filter and the call-detail page all render the same chip for
 * the same value, and a unit test can assert the list without a DOM.
 *
 * Naming note: this file is about CALL DISPOSITIONS — what kind of call it was.
 * The worklist's older "signal chips" (Emergency / Booked / New patient /
 * Insurance) are a different thing and live in CallWorklist as SIGNAL_CHIPS.
 */
import { Beaker, Truck, Pill, Shield, User, Ban, MoreHorizontal } from "lucide-react";
import type { CallDisposition, UnifiedCall } from "./api";

export interface DispositionMeta {
  value: CallDisposition;
  label: string;
  icon: React.ElementType;
  /** Foreground color, used for both the chip text and its icon. */
  color: string;
  /** Chip background — the same 12%-alpha convention the signal chips use. */
  bg: string;
}

/** All seven, in the order the picker offers them. Mirrors DISPOSITIONS server-side. */
export const DISPOSITIONS: readonly DispositionMeta[] = [
  { value: "lab", label: "Lab", icon: Beaker, color: "oklch(0.45 0.11 186)", bg: "oklch(0.52 0.12 186 / 0.12)" },
  { value: "vendor", label: "Vendor", icon: Truck, color: "oklch(0.50 0.16 45)", bg: "oklch(0.75 0.16 60 / 0.15)" },
  { value: "pharmacy", label: "Pharmacy", icon: Pill, color: "oklch(0.48 0.16 155)", bg: "oklch(0.65 0.18 155 / 0.12)" },
  { value: "insurance", label: "Insurance", icon: Shield, color: "oklch(0.45 0.16 260)", bg: "oklch(0.55 0.18 260 / 0.12)" },
  { value: "personal", label: "Personal", icon: User, color: "oklch(0.45 0.13 300)", bg: "oklch(0.55 0.15 300 / 0.12)" },
  { value: "spam", label: "Spam", icon: Ban, color: "oklch(0.55 0.20 25)", bg: "oklch(0.62 0.22 25 / 0.12)" },
  { value: "other", label: "Other", icon: MoreHorizontal, color: "oklch(0.45 0.02 240)", bg: "oklch(0.60 0.02 240 / 0.12)" },
];

const BY_VALUE = new Map(DISPOSITIONS.map((d) => [d.value, d]));

/**
 * The chip definition for a stored value, or null.
 *
 * Returns null rather than throwing on an unknown string: the store is JSON on
 * disk, so a record written by a future version can reach an older client, and a
 * row that can't name its disposition should still render.
 */
export function dispositionMeta(value: CallDisposition | null | undefined): DispositionMeta | null {
  if (!value) return null;
  return BY_VALUE.get(value) ?? null;
}

/** Human label for a value, falling back to the raw value so nothing renders blank. */
export function dispositionLabel(value: CallDisposition | null | undefined): string {
  if (!value) return "";
  return dispositionMeta(value)?.label ?? value;
}

/**
 * The worklist's disposition filter.
 *
 *  - "any"                 no filtering (the default)
 *  - "none"                only calls nobody has dispositioned — the true backlog
 *  - "dispositioned"       any disposition at all
 *  - a CallDisposition     that one specifically
 */
export type DispositionFilter = "any" | "none" | "dispositioned" | CallDisposition;

export function matchesDispositionFilter(call: UnifiedCall, filter: DispositionFilter): boolean {
  switch (filter) {
    case "any": return true;
    case "none": return !call.disposition;
    case "dispositioned": return Boolean(call.disposition);
    default: return call.disposition === filter;
  }
}
