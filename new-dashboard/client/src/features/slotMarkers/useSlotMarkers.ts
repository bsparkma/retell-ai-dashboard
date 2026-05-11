import { useMemo } from "react";
import type { SlotCategory, SlotMarker } from "./types";
import { SLOT_CATEGORIES } from "./config";
import { useSlotMarkers } from "./SlotMarkersContext";

export function useSlotMarkersForDate(date: string): SlotMarker[] {
  const { markers } = useSlotMarkers();
  return useMemo(
    () => markers.filter((m) => m.date === date),
    [markers, date]
  );
}

export function useSlotMarkersForRange(
  startDate: string,
  endDate: string,
  category?: SlotCategory
): SlotMarker[] {
  const { markers } = useSlotMarkers();
  return useMemo(
    () =>
      markers.filter(
        (m) =>
          m.date >= startDate &&
          m.date <= endDate &&
          (category === undefined || m.category === category)
      ),
    [markers, startDate, endDate, category]
  );
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

function plusDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function emptyCategoryCounts(): Record<SlotCategory, number> {
  const result = {} as Record<SlotCategory, number>;
  for (const key of Object.keys(SLOT_CATEGORIES) as SlotCategory[]) {
    result[key] = 0;
  }
  return result;
}

export interface SlotMarkerSummary {
  counts: Record<SlotCategory, number>;
  loading: boolean;
}

/**
 * 30-day rolling category counts.
 *
 * Returns `loading: true` while the underlying provider's initial fetch is in
 * flight so consumers can render a skeleton instead of a misleading "no
 * markers" empty state. Without this, the counts hook would resolve to all
 * zeros on first render (because `markers` starts as `[]`) and any consumer
 * branching on `total === 0` would flash the empty state for one frame
 * before the real data arrives.
 */
export function useSlotMarkerSummary(): SlotMarkerSummary {
  const { markers, loading } = useSlotMarkers();
  const counts = useMemo(() => {
    const start = todayIso();
    const end = plusDaysIso(30);
    const result = emptyCategoryCounts();
    for (const m of markers) {
      if (m.date >= start && m.date <= end) {
        result[m.category] += 1;
      }
    }
    return result;
  }, [markers]);
  return { counts, loading };
}
