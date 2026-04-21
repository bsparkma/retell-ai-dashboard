import type { SlotCategory, SlotCategoryMeta } from "./types";

export const CAREIN_BLOCK_PATNUM = 13290;

export const USE_MOCK_SLOT_MARKERS = true;

export const SLOT_CATEGORIES: Record<SlotCategory, SlotCategoryMeta> = {
  "new-patient":             { label: "New Patient",              color: "#3B82F6", icon: "UserPlus" },
  "emergency":               { label: "Emergency",                color: "#EF4444", icon: "AlertCircle" },
  "hygiene":                 { label: "Hygiene",                  color: "#22C55E", icon: "Sparkles" },
  "asap":                    { label: "ASAP",                     color: "#F97316", icon: "Zap" },
  "restorative-fillings":    { label: "Restorative: Fillings",    color: "#8B5CF6", icon: "Wrench" },
  "restorative-production":  { label: "Restorative: Production",  color: "#6D28D9", icon: "Crown" },
  "restorative-extractions": { label: "Restorative: Extractions", color: "#991B1B", icon: "Scissors" },
  "restorative-pediatric":   { label: "Restorative: Pediatric",   color: "#0D9488", icon: "Heart" },
};

export const OD_APPT_TYPE_TO_CATEGORY: Record<number, SlotCategory> = {};
