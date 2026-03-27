/**
 * Zod validation schemas for all scheduling API route inputs.
 *
 * Import and call .safeParse(req.body) at the top of each route handler.
 * On failure, return 400 with the formatted Zod error.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const ISODateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format");

const ISODateTimeString = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    "Must be an ISO 8601 datetime string"
  );

// ---------------------------------------------------------------------------
// POST /api/scheduling/evaluate
// Body: { patientInfo, request }
// ---------------------------------------------------------------------------

const PatientInfoSchema = z.object({
  patientId: z.string().optional(),
  age: z.number().int().min(0).max(150).optional(),
  isNewPatient: z.boolean(),
  lastCleaningDate: ISODateString.nullable().optional(),
  cleaningHistory: z
    .enum(["unknown", "recent", "within_year", "over_year", "ambiguous"])
    .optional(),
  providerPreference: z.string().max(100).optional(),
  language: z.string().max(10).optional(),
  isMinor: z.boolean().optional(),
});

const AppointmentRequestSchema = z.object({
  requestedType: z.enum([
    "cleaning",
    "emergency",
    "exam",
    "ortho",
    "new_patient",
    "other",
  ]),
  notes: z.string().max(2000).optional(),
  isEmergency: z.boolean().optional(),
  preferredProviderId: z.string().max(100).optional(),
  // clinicNum is intentionally excluded — it must come from X-Clinic-Num header
});

export const EvaluateRequestSchema = z.object({
  patientInfo: PatientInfoSchema,
  request: AppointmentRequestSchema,
});

export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

// ---------------------------------------------------------------------------
// POST /api/scheduling/find-slots
// Body: { evaluation, preferences?, preferredProviderId?, startDate?, endDate?, maxResults? }
// ---------------------------------------------------------------------------

const SchedulingPreferencesSchema = z.object({
  timeOfDay: z.enum(["morning", "afternoon"]).optional(),
  dayOfWeek: z.enum(["early", "late"]).optional(),
});

const EvaluationSummarySchema = z.object({
  durationMinutes: z.number().int().min(15).max(480),
  providerType: z.enum(["DENTIST", "HYGIENIST", "ANY"]),
  requiresHygieneRoom: z.boolean(),
  checkEmergencySlots: z.boolean(),
});

export const FindSlotsRequestSchema = z.object({
  evaluation: EvaluationSummarySchema,
  preferences: SchedulingPreferencesSchema.optional(),
  preferredProviderId: z.string().max(100).optional(),
  startDate: ISODateString.optional(),
  endDate: ISODateString.optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
});

export type FindSlotsRequest = z.infer<typeof FindSlotsRequestSchema>;

// ---------------------------------------------------------------------------
// POST /api/scheduling/book
// Body: { slot, patientId?, evaluation, notes?, source? }
// ---------------------------------------------------------------------------

const TimeSlotSchema = z.object({
  dateTime: ISODateTimeString,
  duration: z.number().int().min(15).max(480),
  providerId: z.number().int().positive(),
  providerName: z.string().max(200),
  operatoryId: z.number().int().positive(),
  operatoryName: z.string().max(200),
  clinicNum: z.number().int().positive(),
});

const BookEvaluationSchema = z.object({
  category: z.string().min(1).max(100),
  durationMinutes: z.number().int().min(15).max(480),
});

export const BookRequestSchema = z.object({
  slot: TimeSlotSchema,
  patientId: z.string().max(100).optional(),
  evaluation: BookEvaluationSchema,
  notes: z.string().max(2000).optional(),
  source: z.string().max(50).optional(),
});

export type BookRequest = z.infer<typeof BookRequestSchema>;

// ---------------------------------------------------------------------------
// POST /api/scheduling/emergency-check
// Body: (no fields required — clinicNum comes from header)
// ---------------------------------------------------------------------------

export const EmergencyCheckSchema = z.object({}).strict();

export type EmergencyCheckInput = z.infer<typeof EmergencyCheckSchema>;

// ---------------------------------------------------------------------------
// GET /api/scheduling/appointments (query params)
// ---------------------------------------------------------------------------

export const AppointmentsQuerySchema = z.object({
  startDate: ISODateString,
  endDate: ISODateString,
  providerId: z.string().optional(),
  operatoryId: z.string().optional(),
});

export type AppointmentsQuery = z.infer<typeof AppointmentsQuerySchema>;
