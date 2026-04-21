export type SlotCategory =
  | "new-patient"
  | "emergency"
  | "hygiene"
  | "asap"
  | "restorative-fillings"
  | "restorative-production"
  | "restorative-extractions"
  | "restorative-pediatric";

export interface SlotMarker {
  id: number;
  date: string;
  startTime: string;
  duration: number;
  operatoryId: number;
  operatoryName: string;
  providerId?: number;
  providerName?: string;
  category: SlotCategory;
  clinicNum: number;
}

export interface SlotCategoryMeta {
  label: string;
  color: string;
  icon: string;
}
