export type { SlotMarker, SlotCategory, SlotCategoryMeta } from "./types";
export {
  CAREIN_BLOCK_PATNUM,
  USE_MOCK_SLOT_MARKERS,
  SLOT_CATEGORIES,
  OD_APPT_TYPE_TO_CATEGORY,
} from "./config";
export { MOCK_SLOT_MARKERS } from "./mockData";
export { getSlotMarkers } from "./api";
export type { GetSlotMarkersParams } from "./api";
export { SlotMarkersProvider, useSlotMarkers } from "./SlotMarkersContext";
export {
  useSlotMarkersForDate,
  useSlotMarkersForRange,
  useSlotMarkerSummary,
} from "./useSlotMarkers";
