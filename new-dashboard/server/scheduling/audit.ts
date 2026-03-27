/**
 * CareIN Scheduling Audit Logger
 *
 * Records all PHI access and scheduling actions for HIPAA compliance.
 * Every read, write, or update involving patient data must be logged here.
 *
 * Log entries are written to:
 *   1. Console (structured JSON — picked up by Azure Monitor / log aggregator)
 *   2. In-memory buffer (accessible via getRecentAuditLog for admin UI)
 *
 * In production, pipe these logs to Azure Monitor or a SIEM system.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAction =
  | "PATIENT_SEARCH"
  | "PATIENT_VIEW"
  | "SCHEDULE_EVALUATE"
  | "SLOTS_FETCHED"
  | "APPOINTMENT_BOOKED"
  | "APPOINTMENT_UPDATED"
  | "APPOINTMENT_CANCELLED"
  | "EMERGENCY_CHECK"
  | "SYNC_TRIGGERED";

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: AuditAction;
  /** Who performed the action (staff ID, agent ID, or "voice_agent") */
  actorId: string;
  /** Source system ("voice_agent" | "front_desk" | "web" | "system") */
  source: string;
  clinicNum: number;
  /** Patient ID if applicable (do NOT log patient names here) */
  patientId?: string;
  /** Appointment ID if applicable */
  appointmentId?: string;
  /** Additional structured context (no PHI) */
  context?: Record<string, string | number | boolean>;
  /** Whether the action succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// In-memory buffer (last 500 entries, for admin UI only)
// ---------------------------------------------------------------------------

const BUFFER_SIZE = 500;
const auditBuffer: AuditEntry[] = [];

function addToBuffer(entry: AuditEntry): void {
  auditBuffer.push(entry);
  if (auditBuffer.length > BUFFER_SIZE) {
    auditBuffer.shift();
  }
}

// ---------------------------------------------------------------------------
// ID generation (no crypto dependency needed — nanoid would be better in prod)
// ---------------------------------------------------------------------------

let counter = 0;
function generateId(): string {
  counter++;
  return `audit-${Date.now()}-${counter}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a PHI access or scheduling action for HIPAA compliance.
 * Call this for every operation that involves patient data.
 */
export function auditLog(
  action: AuditAction,
  params: {
    actorId: string;
    source: string;
    clinicNum: number;
    patientId?: string;
    appointmentId?: string;
    context?: Record<string, string | number | boolean>;
    success: boolean;
    error?: string;
  }
): AuditEntry {
  const entry: AuditEntry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    action,
    actorId: params.actorId,
    source: params.source,
    clinicNum: params.clinicNum,
    patientId: params.patientId,
    appointmentId: params.appointmentId,
    context: params.context,
    success: params.success,
    error: params.error,
  };

  // Write to structured log (production: Azure Monitor / log aggregator picks this up)
  console.log(JSON.stringify({ level: "audit", ...entry }));

  // Keep in memory for admin UI
  addToBuffer(entry);

  return entry;
}

/**
 * Get recent audit log entries for the admin UI.
 * Optionally filter by clinicNum.
 */
export function getRecentAuditLog(clinicNum?: number): AuditEntry[] {
  if (clinicNum === undefined) return [...auditBuffer].reverse();
  return auditBuffer.filter((e) => e.clinicNum === clinicNum).reverse();
}
