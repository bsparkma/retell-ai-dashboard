import type { SlotMarker, SlotCategory } from "./types";
import { USE_MOCK_SLOT_MARKERS } from "./config";
import { MOCK_SLOT_MARKERS } from "./mockData";

export interface GetSlotMarkersParams {
  startDate: string;
  endDate: string;
  clinicNum: number;
  category?: SlotCategory;
}

export async function getSlotMarkers(
  params: GetSlotMarkersParams
): Promise<SlotMarker[]> {
  if (USE_MOCK_SLOT_MARKERS) {
    return Promise.resolve(
      MOCK_SLOT_MARKERS.filter(
        (m) =>
          m.date >= params.startDate &&
          m.date <= params.endDate &&
          (params.category === undefined || m.category === params.category)
      )
    );
  }
  const url = new URL("/api/slot-markers", window.location.origin);
  url.searchParams.set("startDate", params.startDate);
  url.searchParams.set("endDate", params.endDate);
  url.searchParams.set("clinicNum", String(params.clinicNum));
  if (params.category) url.searchParams.set("category", params.category);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to load slot markers");
  return res.json() as Promise<SlotMarker[]>;
}
