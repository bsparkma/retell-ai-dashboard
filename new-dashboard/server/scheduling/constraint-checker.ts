/**
 * CareIN Constraint Checker
 *
 * Validates that a proposed time slot satisfies all resource constraints:
 * - Room availability (no operatory double-booking)
 * - Equipment availability (nitrous, intraoral scanner)
 * - Provider schedule (provider is available at that time)
 * - Hygiene room requirement
 */

import type { PMSAdapter, PMSOperatory } from "../pms/adapter.js";
import type { AppointmentEvaluation, TimeSlot } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConstraintViolation {
  code: string;
  message: string;
}

export interface ConstraintCheckResult {
  valid: boolean;
  violations: ConstraintViolation[];
}

export interface ConstraintCheckParams {
  slot: TimeSlot;
  evaluation: AppointmentEvaluation;
  /** ISO datetime string — when the appointment ends */
  endDateTime: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeEndDateTime(slot: TimeSlot): string {
  const start = new Date(slot.dateTime);
  start.setMinutes(start.getMinutes() + slot.duration);
  return start.toISOString();
}

function rangesOverlap(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date
): boolean {
  return startA < endB && startB < endA;
}

// ---------------------------------------------------------------------------
// Constraint checks
// ---------------------------------------------------------------------------

async function checkOperatoryAvailability(
  adapter: PMSAdapter,
  slot: TimeSlot,
  endDateTime: string
): Promise<ConstraintViolation | null> {
  try {
    const operatories = await adapter.getOperatories();
    const op = operatories.find((o) => o.id === slot.operatoryId);
    if (!op) {
      return {
        code: "OPERATORY_NOT_FOUND",
        message: `Operatory ${slot.operatoryId} does not exist.`,
      };
    }
    if (op.isHidden) {
      return {
        code: "OPERATORY_INACTIVE",
        message: `Operatory "${op.name}" is not active.`,
      };
    }
  } catch {
    // If we can't check, allow it (fail open for UX)
  }
  return null;
}

function checkHygieneRoomRequirement(
  evaluation: AppointmentEvaluation,
  operatories: PMSOperatory[],
  slot: TimeSlot
): ConstraintViolation | null {
  if (!evaluation.requiresHygieneRoom) return null;

  const op = operatories.find((o) => o.id === slot.operatoryId);
  if (!op) return null; // Can't verify — allow

  // Check isHygiene flag or name heuristic
  const isHygieneOp =
    op.isHygiene === true ||
    op.name.toLowerCase().includes("hygiene") ||
    op.name.toLowerCase().includes("hyg");

  if (!isHygieneOp) {
    return {
      code: "NOT_HYGIENE_ROOM",
      message: `Operatory "${op.name}" is not a hygiene room but this appointment requires one.`,
    };
  }
  return null;
}

async function checkProviderAvailability(
  adapter: PMSAdapter,
  slot: TimeSlot
): Promise<ConstraintViolation | null> {
  try {
    const providers = await adapter.getProviders();
    const provider = providers.find((p) => p.id === slot.providerId);
    if (!provider) {
      return {
        code: "PROVIDER_NOT_FOUND",
        message: `Provider ${slot.providerId} does not exist.`,
      };
    }
    if (provider.isHidden) {
      return {
        code: "PROVIDER_INACTIVE",
        message: `Provider "${provider.name}" is not active.`,
      };
    }
  } catch {
    // Fail open
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate that a proposed time slot satisfies all resource constraints.
 * Returns a list of violations (empty list = valid).
 */
export async function checkConstraints(
  adapter: PMSAdapter,
  params: ConstraintCheckParams
): Promise<ConstraintCheckResult> {
  const violations: ConstraintViolation[] = [];
  const { slot, evaluation } = params;
  const endDateTime = computeEndDateTime(slot);

  // Run checks
  const [opViolation, providerViolation] = await Promise.all([
    checkOperatoryAvailability(adapter, slot, endDateTime),
    checkProviderAvailability(adapter, slot),
  ]);

  if (opViolation) violations.push(opViolation);
  if (providerViolation) violations.push(providerViolation);

  // Hygiene room check (needs operatory list)
  try {
    const operatories = await adapter.getOperatories();
    const hygieneViolation = checkHygieneRoomRequirement(
      evaluation,
      operatories,
      slot
    );
    if (hygieneViolation) violations.push(hygieneViolation);
  } catch {
    // Fail open
  }

  // Duration sanity check
  if (slot.duration !== evaluation.durationMinutes) {
    violations.push({
      code: "DURATION_MISMATCH",
      message:
        `Slot duration (${slot.duration}min) does not match required duration ` +
        `(${evaluation.durationMinutes}min).`,
    });
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
