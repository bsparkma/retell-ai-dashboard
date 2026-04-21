import type { SlotMarker } from "./types";

export const MOCK_SLOT_MARKERS: SlotMarker[] = [
  { id: 9001, date: "2026-04-22", startTime: "09:00", duration: 60, operatoryId: 1, operatoryName: "Op 1", providerId: 1, providerName: "Dr. Smith",   category: "new-patient",            clinicNum: 1 },
  { id: 9002, date: "2026-04-29", startTime: "14:00", duration: 60, operatoryId: 2, operatoryName: "Op 2", providerId: 1, providerName: "Dr. Smith",   category: "new-patient",            clinicNum: 1 },

  { id: 9003, date: "2026-04-22", startTime: "08:00", duration: 60, operatoryId: 1, operatoryName: "Op 1", providerId: 1, providerName: "Dr. Smith",   category: "emergency",              clinicNum: 1 },
  { id: 9004, date: "2026-04-24", startTime: "11:00", duration: 60, operatoryId: 3, operatoryName: "Op 3", providerId: 1, providerName: "Dr. Smith",   category: "emergency",              clinicNum: 1 },

  { id: 9005, date: "2026-04-22", startTime: "10:00", duration: 60, operatoryId: 2, operatoryName: "Op 2", providerId: 2, providerName: "Hyg. Lopez",  category: "hygiene",                clinicNum: 1 },
  { id: 9006, date: "2026-04-23", startTime: "13:00", duration: 60, operatoryId: 2, operatoryName: "Op 2", providerId: 2, providerName: "Hyg. Lopez",  category: "hygiene",                clinicNum: 1 },
  { id: 9007, date: "2026-05-04", startTime: "09:00", duration: 60, operatoryId: 2, operatoryName: "Op 2", providerId: 2, providerName: "Hyg. Lopez",  category: "hygiene",                clinicNum: 1 },

  { id: 9008, date: "2026-04-23", startTime: "08:30", duration: 30, operatoryId: 1, operatoryName: "Op 1", providerId: 1, providerName: "Dr. Smith",   category: "asap",                   clinicNum: 1 },
  { id: 9009, date: "2026-04-30", startTime: "16:30", duration: 30, operatoryId: 3, operatoryName: "Op 3", providerId: 1, providerName: "Dr. Smith",   category: "asap",                   clinicNum: 1 },

  { id: 9010, date: "2026-04-24", startTime: "09:30", duration: 60, operatoryId: 1, operatoryName: "Op 1", providerId: 1, providerName: "Dr. Smith",   category: "restorative-fillings",   clinicNum: 1 },
  { id: 9011, date: "2026-05-01", startTime: "14:30", duration: 60, operatoryId: 2, operatoryName: "Op 2", providerId: 1, providerName: "Dr. Smith",   category: "restorative-fillings",   clinicNum: 1 },

  { id: 9012, date: "2026-04-27", startTime: "10:00", duration: 90, operatoryId: 3, operatoryName: "Op 3", providerId: 1, providerName: "Dr. Smith",   category: "restorative-production", clinicNum: 1 },
  { id: 9013, date: "2026-05-05", startTime: "13:00", duration: 90, operatoryId: 1, operatoryName: "Op 1", providerId: 1, providerName: "Dr. Smith",   category: "restorative-production", clinicNum: 1 },

  { id: 9014, date: "2026-04-28", startTime: "09:00", duration: 60, operatoryId: 3, operatoryName: "Op 3", providerId: 1, providerName: "Dr. Smith",   category: "restorative-extractions",clinicNum: 1 },
  { id: 9015, date: "2026-05-06", startTime: "15:00", duration: 60, operatoryId: 3, operatoryName: "Op 3", providerId: 1, providerName: "Dr. Smith",   category: "restorative-extractions",clinicNum: 1 },

  { id: 9016, date: "2026-04-29", startTime: "11:00", duration: 30, operatoryId: 2, operatoryName: "Op 2", providerId: 2, providerName: "Hyg. Lopez",  category: "restorative-pediatric",  clinicNum: 1 },
  { id: 9017, date: "2026-05-07", startTime: "09:30", duration: 30, operatoryId: 2, operatoryName: "Op 2", providerId: 2, providerName: "Hyg. Lopez",  category: "restorative-pediatric",  clinicNum: 1 },
];
