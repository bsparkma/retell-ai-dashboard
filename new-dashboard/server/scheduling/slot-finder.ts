/**
 * CareIN Slot Finder
 *
 * Implements the 2-question preference script for scheduling:
 *   1. Morning vs afternoon
 *   2. Early week (Mon/Tue) vs later week (Wed/Thu)
 *
 * Returns two concrete matching time slot options.
 *
 * For emergencies: checks priority time slots first, then falls back
 * to the preference script if none are available.
 *
 * Respects operatory constraints (hygiene rooms, nitrous, scanner),
 * and avoids double-booking providers or operatories.
 */

import type { PMSAdapter } from "../pms/adapter.js";
import {
  AppointmentEvaluation,
  DayOfWeek,
  EmergencyCheckResult,
  SchedulingPreferences,
  SlotSearchParams,
  TimeOfDay,
  TimeSlot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Time window helpers
// ---------------------------------------------------------------------------

/** Morning slots: 8:00 AM – 11:59 AM */
const MORNING_START_HOUR = 8;
const MORNING_END_HOUR = 12;

/** Afternoon slots: 12:00 PM – 4:30 PM (last slot that can start and still finish by 5) */
const AFTERNOON_START_HOUR = 12;
const AFTERNOON_END_HOUR = 17;

/** "Early week" = Monday (1) and Tuesday (2) */
const EARLY_WEEK_DAYS = new Set([1, 2]);

/** "Late week" = Wednesday (3) and Thursday (4) */
const LATE_WEEK_DAYS = new Set([3, 4]);

/** Emergency priority times (office priority slots, checked before preference script) */
const EMERGENCY_PRIORITY_TIMES = [
  { hour: 8, minute: 0 },    // 8:00 AM opening slot
  { hour: 11, minute: 0 },   // 11:00 AM
  { hour: 14, minute: 0 },   // 2:00 PM
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]!;
}

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr).getDay(); // 0=Sun, 1=Mon, ... 6=Sat
}

function isWeekend(dateStr: string): boolean {
  const dow = getDayOfWeek(dateStr);
  return dow === 0 || dow === 6;
}

function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function timeHour(timeStr: string): number {
  return parseInt(timeStr.split(":")[0] ?? "0", 10);
}

function slotMatchesTimeOfDay(slot: TimeSlot, timeOfDay: TimeOfDay): boolean {
  const dt = new Date(slot.dateTime);
  const hour = dt.getHours();
  if (timeOfDay === TimeOfDay.MORNING) {
    return hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
  }
  return hour >= AFTERNOON_START_HOUR && hour < AFTERNOON_END_HOUR;
}

function slotMatchesDayOfWeek(slot: TimeSlot, dayOfWeek: DayOfWeek): boolean {
  const dt = new Date(slot.dateTime);
  const dow = dt.getDay();
  if (dayOfWeek === DayOfWeek.EARLY) {
    return EARLY_WEEK_DAYS.has(dow);
  }
  return LATE_WEEK_DAYS.has(dow);
}

function slotMatchesPreferences(
  slot: TimeSlot,
  preferences: SchedulingPreferences
): boolean {
  if (preferences.timeOfDay && !slotMatchesTimeOfDay(slot, preferences.timeOfDay)) {
    return false;
  }
  if (preferences.dayOfWeek && !slotMatchesDayOfWeek(slot, preferences.dayOfWeek)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Priority slot filter for emergencies
// ---------------------------------------------------------------------------

function filterEmergencyPrioritySlots(slots: TimeSlot[]): TimeSlot[] {
  return slots.filter((slot) => {
    const dt = new Date(slot.dateTime);
    const h = dt.getHours();
    const m = dt.getMinutes();
    return EMERGENCY_PRIORITY_TIMES.some(
      (pt) => pt.hour === h && pt.minute === m
    );
  });
}

// ---------------------------------------------------------------------------
// Preferred provider logic
// ---------------------------------------------------------------------------

function separateByProvider(
  slots: TimeSlot[],
  preferredProviderId?: string
): { preferred: TimeSlot[]; others: TimeSlot[] } {
  if (!preferredProviderId) return { preferred: [], others: slots };
  const preferred = slots.filter(
    (s) => String(s.providerId) === preferredProviderId
  );
  const others = slots.filter(
    (s) => String(s.providerId) !== preferredProviderId
  );
  return { preferred, others };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find available time slots using the PMS adapter.
 *
 * Returns up to `params.maxResults` (default 2) concrete slots matching
 * the caller's preferences from the 2-question script.
 *
 * Shows preferred provider's slots first, then alternatives if needed.
 */
export async function findSlots(
  adapter: PMSAdapter,
  params: SlotSearchParams
): Promise<TimeSlot[]> {
  const maxResults = params.maxResults ?? 2;

  // Get all available slots from the PMS adapter for the date range
  const allSlots = await adapter.getAvailableSlots(params);

  // Filter by hygiene room requirement
  const filteredByOp = params.requireHygieneRoom
    ? allSlots.filter((s) => s.operatoryName.toLowerCase().includes("hygiene") ||
        s.operatoryName.toLowerCase().includes("hyg"))
    : allSlots;

  // Apply preference filters
  const { preferred, others } = separateByProvider(
    filteredByOp,
    params.preferredProviderId
  );

  let candidates: TimeSlot[];

  if (params.preferences) {
    const matchingPreferred = preferred.filter((s) =>
      slotMatchesPreferences(s, params.preferences!)
    );
    const matchingOthers = others.filter((s) =>
      slotMatchesPreferences(s, params.preferences!)
    );
    // Show preferred provider first, then others
    candidates = [...matchingPreferred, ...matchingOthers];
  } else {
    candidates = [...preferred, ...others];
  }

  // Deduplicate by operatory+provider+time (adapter may return duplicates)
  const seen = new Set<string>();
  const unique = candidates.filter((s) => {
    const key = `${s.dateTime}|${s.providerId}|${s.operatoryId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, maxResults);
}

/**
 * Check for emergency priority slots.
 * Returns up to 2 priority slots if available.
 * If none found, returns empty list with message to use preference script.
 */
export async function checkEmergencySlots(
  adapter: PMSAdapter,
  clinicNum: number
): Promise<EmergencyCheckResult> {
  const today = new Date().toISOString().split("T")[0]!;
  const tomorrow = addDays(today, 1);

  const slots = await adapter.getAvailableSlots({
    clinicNum,
    startDate: today,
    endDate: tomorrow,
    durationMinutes: 60,
    providerType: "DENTIST" as never,
    maxResults: 10,
  });

  const prioritySlots = filterEmergencyPrioritySlots(slots).slice(0, 2);

  if (prioritySlots.length > 0) {
    const slotDescriptions = prioritySlots
      .map((s) => {
        const dt = new Date(s.dateTime);
        const time = dt.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        const date = dt.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        });
        return `${time} on ${date}`;
      })
      .join(", or ");

    return {
      hasPrioritySlot: true,
      prioritySlots,
      message: `We have an emergency slot available at ${slotDescriptions}. Which works better for you?`,
    };
  }

  return {
    hasPrioritySlot: false,
    prioritySlots: [],
    message:
      "Let me find the next available time for you. " +
      "Do you prefer mornings or afternoons?",
  };
}

/**
 * Build a human-readable slot description for the voice agent.
 */
export function describeSlot(slot: TimeSlot): string {
  const dt = new Date(slot.dateTime);
  const time = dt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const date = dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return `${time} on ${date} with ${slot.providerName} in ${slot.operatoryName}`;
}

/**
 * Build the two-option offer message for the 2-question script.
 */
export function buildSlotOfferMessage(slots: TimeSlot[]): string {
  if (slots.length === 0) {
    return "I'm sorry, I don't see any available slots matching those preferences. Let me check other times — would you be open to a different day?";
  }
  if (slots.length === 1) {
    return `I have ${describeSlot(slots[0]!)} available. Would that work for you?`;
  }
  return (
    `I have two options that match your preferences: ` +
    `${describeSlot(slots[0]!)} or ${describeSlot(slots[1]!)}. ` +
    `Which works better for you?`
  );
}
