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

export function useSlotMarkerSummary(): Record<SlotCategory, number> {
  const { markers } = useSlotMarkers();
  return useMemo(() => {
    const start = todayIso();
    const end = plusDaysIso(30);
    const counts = emptyCategoryCounts();
    for (const m of markers) {
      if (m.date >= start && m.date <= end) {
        counts[m.category] += 1;
      }
    }
    return counts;
  }, [markers]);
}
