/**
 * CareIN Scheduling Rules Engine
 *
 * Takes patient info + appointment request and returns the correct appointment
 * type, duration, provider type, and required resources.
 *
 * Rules confirmed by practice owner (Dr. Beau Sparkman):
 *
 * New adult patient (>=18), last cleaning >12 months OR unknown/ambiguous
 *   → 60-min doctor exam + X-rays, NO cleaning that day
 *
 * New adult patient, last cleaning <12 months, on 6-month recall
 *   → 90-min hygiene (exam + X-rays + cleaning)
 *
 * New child patient (<18)
 *   → 60-min hygiene (exam + X-rays + cleaning)
 *
 * Existing adult cleaning → 60 min hygiene
 * Existing child cleaning → 30 min hygiene
 *
 * Emergency → 60-min limited exam. Check priority slot first.
 *   If none, use 2-question preference script.
 *
 * Ortho adjustment → 30 min
 */

import {
  AppointmentCategory,
  AppointmentEvaluation,
  AppointmentRequest,
  PatientInfo,
  ProviderType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Age helpers
// ---------------------------------------------------------------------------

function isMinor(patientInfo: PatientInfo): boolean {
  if (patientInfo.isMinor !== undefined) return patientInfo.isMinor;
  if (patientInfo.age !== undefined) return patientInfo.age < 18;
  return false;
}

// ---------------------------------------------------------------------------
// Cleaning history analysis
// ---------------------------------------------------------------------------

type CleaningRecency =
  | "recent"        // < 6 months — clearly on recall
  | "within_year"   // 6-12 months — borderline, use appointment date diff
  | "over_year"     // > 12 months — needs exam-first path
  | "unknown";      // no data — default to exam-first (safest)

function resolveCleaningRecency(patientInfo: PatientInfo): CleaningRecency {
  // Explicit history override
  if (patientInfo.cleaningHistory) {
    switch (patientInfo.cleaningHistory) {
      case "recent":
        return "recent";
      case "within_year":
        return "within_year";
      case "over_year":
        return "over_year";
      case "ambiguous":
        // Edge case: "about a year" → default to over_year (exam-first)
        return "over_year";
      case "unknown":
        return "unknown";
    }
  }

  // Try to calculate from actual date
  if (patientInfo.lastCleaningDate) {
    const last = new Date(patientInfo.lastCleaningDate);
    const now = new Date();
    if (isNaN(last.getTime())) return "unknown";

    const monthsAgo = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    if (monthsAgo < 6) return "recent";
    if (monthsAgo <= 12) return "within_year";
    return "over_year";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Core rules engine
// ---------------------------------------------------------------------------

export function evaluateAppointment(
  patientInfo: PatientInfo,
  request: AppointmentRequest
): AppointmentEvaluation {
  // Emergency always wins first
  if (request.isEmergency || request.requestedType === "emergency") {
    return {
      category: AppointmentCategory.EMERGENCY,
      durationMinutes: 60,
      providerType: ProviderType.DENTIST,
      requiresHygieneRoom: false,
      rationale:
        "Emergency visit: 60-minute limited exam with dentist. " +
        "Priority time slots will be checked first.",
      checkEmergencySlots: true,
      cleaningDeferred: false,
    };
  }

  // Ortho adjustment
  if (request.requestedType === "ortho") {
    return {
      category: AppointmentCategory.ORTHO_ADJUSTMENT,
      durationMinutes: 30,
      providerType: ProviderType.DENTIST,
      requiresHygieneRoom: false,
      rationale: "Orthodontic adjustment: 30 minutes with dentist.",
      checkEmergencySlots: false,
      cleaningDeferred: false,
    };
  }

  const minor = isMinor(patientInfo);
  const recency = resolveCleaningRecency(patientInfo);

  // ---- New patient paths ----
  if (patientInfo.isNewPatient) {
    // New child patient — always hygiene
    if (minor) {
      return {
        category: AppointmentCategory.NEW_CHILD_HYGIENE,
        durationMinutes: 60,
        providerType: ProviderType.HYGIENIST,
        requiresHygieneRoom: true,
        rationale:
          "New child patient: 60-minute hygiene appointment " +
          "(exam + X-rays + cleaning).",
        checkEmergencySlots: false,
        cleaningDeferred: false,
      };
    }

    // New adult patient — path depends on cleaning history
    // "recent" = last cleaning < 6 months (clearly on recall) → 90-min hygiene
    // "within_year" = 6-12 months → also qualifies for hygiene path
    // "over_year", "unknown", or "ambiguous" → exam-first, NO cleaning
    if (recency === "recent" || recency === "within_year") {
      return {
        category: AppointmentCategory.NEW_PATIENT_HYGIENE,
        durationMinutes: 90,
        providerType: ProviderType.HYGIENIST,
        requiresHygieneRoom: true,
        rationale:
          "New adult patient with recent cleaning (< 12 months): " +
          "90-minute hygiene appointment (exam + X-rays + cleaning).",
        checkEmergencySlots: false,
        cleaningDeferred: false,
      };
    }

    // Default: >12 months or unknown → exam-first, cleaning deferred
    const recencyPhrase =
      recency === "unknown"
        ? "Cleaning history is unknown"
        : "Last cleaning was more than 12 months ago";

    return {
      category: AppointmentCategory.NEW_PATIENT_EXAM,
      durationMinutes: 60,
      providerType: ProviderType.DENTIST,
      requiresHygieneRoom: false,
      rationale:
        `New adult patient — ${recencyPhrase.toLowerCase()}. ` +
        "Scheduling 60-minute doctor exam + X-rays. " +
        "Cleaning will be scheduled as a separate appointment.",
      checkEmergencySlots: false,
      cleaningDeferred: true,
      deferredCleaningMessage:
        "We'll get you in for your exam and X-rays first, then we'll " +
        "schedule a cleaning right away — usually within a week or two. " +
        "Would you like me to note that for our hygiene team?",
    };
  }

  // ---- Existing patient paths ----
  if (
    request.requestedType === "cleaning" ||
    request.requestedType === "exam" ||
    request.requestedType === "new_patient" // shouldn't reach here, but guard
  ) {
    if (minor) {
      return {
        category: AppointmentCategory.EXISTING_CHILD_CLEANING,
        durationMinutes: 30,
        providerType: ProviderType.HYGIENIST,
        requiresHygieneRoom: true,
        rationale: "Existing child patient: 30-minute hygiene cleaning.",
        checkEmergencySlots: false,
        cleaningDeferred: false,
      };
    }

    return {
      category: AppointmentCategory.EXISTING_ADULT_CLEANING,
      durationMinutes: 60,
      providerType: ProviderType.HYGIENIST,
      requiresHygieneRoom: true,
      rationale: "Existing adult patient: 60-minute hygiene cleaning.",
      checkEmergencySlots: false,
      cleaningDeferred: false,
    };
  }

  // Fallback — generic exam
  return {
    category: AppointmentCategory.EXAM,
    durationMinutes: 60,
    providerType: ProviderType.DENTIST,
    requiresHygieneRoom: false,
    rationale: "General appointment: 60-minute exam with dentist.",
    checkEmergencySlots: false,
    cleaningDeferred: false,
  };
}
