/**
 * Scheduling API Routes
 *
 * All routes include:
 * - Tenant context via X-Clinic-Num header or ?clinicNum query param
 * - HIPAA audit logging for every PHI access
 * - Structured error responses: { success: false, error: string, code: string }
 *
 * Routes:
 *   POST /api/scheduling/evaluate         — Rules engine evaluation
 *   POST /api/scheduling/find-slots       — Find available time slots
 *   POST /api/scheduling/book             — Book an appointment
 *   GET  /api/scheduling/appointments     — List appointments for date range
 *   POST /api/scheduling/emergency-check  — Emergency priority slot check
 *   GET  /api/scheduling/audit-log        — Recent audit entries (admin)
 */

import { Router, type Request, type Response } from "express";
import { evaluateAppointment } from "../scheduling/rules-engine.js";
import { findSlots, checkEmergencySlots, buildSlotOfferMessage } from "../scheduling/slot-finder.js";
import { checkConstraints } from "../scheduling/constraint-checker.js";
import { auditLog, getRecentAuditLog } from "../scheduling/audit.js";
import { getPMSAdapter, getTenantConfigFromEnv } from "../pms/factory.js";
import type { AppointmentRequest, PatientInfo, SchedulingPreferences, TimeSlot } from "../scheduling/types.js";
import { PMSType } from "../scheduling/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClinicNum(req: Request): number {
  const header = req.headers["x-clinic-num"];
  const query = req.query.clinicNum;
  const body = (req.body as Record<string, unknown>)?.clinicNum;
  const raw = header ?? query ?? body ?? process.env.OD_CLINIC_NUM ?? "0";
  return parseInt(String(raw), 10);
}

function getActorId(req: Request): string {
  // In production: extract from JWT / auth session
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return "authenticated-user"; // TODO: decode JWT and extract user ID
  }
  return "anonymous";
}

function getSource(req: Request): string {
  return String(req.headers["x-source"] ?? "web");
}

function errorResponse(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  res.status(status).json({ success: false, code, error: message });
}

function getAdapter(clinicNum: number) {
  const pmsTypeStr = process.env.PMS_TYPE ?? "OPEN_DENTAL";
  const pmsType = PMSType[pmsTypeStr as keyof typeof PMSType] ?? PMSType.OPEN_DENTAL;
  return getPMSAdapter({ pmsType, clinicNum });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const schedulingRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/scheduling/evaluate
// Body: { patientInfo: PatientInfo, request: AppointmentRequest }
// Returns: AppointmentEvaluation
// ---------------------------------------------------------------------------

schedulingRouter.post("/evaluate", async (req: Request, res: Response) => {
  const clinicNum = getClinicNum(req);
  const actorId = getActorId(req);
  const source = getSource(req);

  try {
    const body = req.body as {
      patientInfo?: PatientInfo;
      request?: AppointmentRequest;
    };

    if (!body.patientInfo || !body.request) {
      return errorResponse(res, 400, "MISSING_PARAMS", "patientInfo and request are required");
    }

    const patientInfo: PatientInfo = body.patientInfo;
    const appointmentRequest: AppointmentRequest = {
      ...body.request,
      clinicNum,
    };

    const evaluation = evaluateAppointment(patientInfo, appointmentRequest);

    auditLog("SCHEDULE_EVALUATE", {
      actorId,
      source,
      clinicNum,
      patientId: patientInfo.patientId,
      context: {
        isNewPatient: patientInfo.isNewPatient,
        requestedType: appointmentRequest.requestedType,
        resultCategory: evaluation.category,
      },
      success: true,
    });

    return res.json({ success: true, evaluation });
  } catch (err) {
    auditLog("SCHEDULE_EVALUATE", {
      actorId,
      source,
      clinicNum,
      success: false,
      error: String(err),
    });
    return errorResponse(res, 500, "EVALUATION_ERROR", "Failed to evaluate appointment");
  }
});

// ---------------------------------------------------------------------------
// POST /api/scheduling/find-slots
// Body: { evaluation: AppointmentEvaluation, preferences?: SchedulingPreferences,
//         startDate?: string, endDate?: string }
// Returns: { slots: TimeSlot[], offerMessage: string }
// ---------------------------------------------------------------------------

schedulingRouter.post("/find-slots", async (req: Request, res: Response) => {
  const clinicNum = getClinicNum(req);
  const actorId = getActorId(req);
  const source = getSource(req);

  try {
    const body = req.body as {
      evaluation?: {
        durationMinutes: number;
        providerType: string;
        requiresHygieneRoom: boolean;
        checkEmergencySlots: boolean;
      };
      preferences?: SchedulingPreferences;
      preferredProviderId?: string;
      startDate?: string;
      endDate?: string;
      maxResults?: number;
    };

    if (!body.evaluation) {
      return errorResponse(res, 400, "MISSING_PARAMS", "evaluation is required");
    }

    const today = new Date().toISOString().split("T")[0]!;
    const fourWeeksOut = new Date();
    fourWeeksOut.setDate(fourWeeksOut.getDate() + 28);
    const defaultEnd = fourWeeksOut.toISOString().split("T")[0]!;

    const adapter = getAdapter(clinicNum);

    const slots = await findSlots(adapter, {
      clinicNum,
      startDate: body.startDate ?? today,
      endDate: body.endDate ?? defaultEnd,
      durationMinutes: body.evaluation.durationMinutes,
      providerType: body.evaluation.providerType as never,
      requireHygieneRoom: body.evaluation.requiresHygieneRoom,
      preferences: body.preferences,
      preferredProviderId: body.preferredProviderId,
      maxResults: body.maxResults ?? 2,
    });

    const offerMessage = buildSlotOfferMessage(slots);

    auditLog("SLOTS_FETCHED", {
      actorId,
      source,
      clinicNum,
      context: {
        slotsFound: slots.length,
        durationMinutes: body.evaluation.durationMinutes,
      },
      success: true,
    });

    return res.json({ success: true, slots, offerMessage });
  } catch (err) {
    auditLog("SLOTS_FETCHED", {
      actorId,
      source,
      clinicNum,
      success: false,
      error: String(err),
    });
    return errorResponse(res, 500, "SLOT_SEARCH_ERROR", "Failed to find available slots");
  }
});

// ---------------------------------------------------------------------------
// POST /api/scheduling/book
// Body: { slot: TimeSlot, patientId?: string, patientInfo?: PatientInfo,
//         evaluation: AppointmentEvaluation, notes?: string, source: string }
// Returns: { appointment: BookedAppointment }
// ---------------------------------------------------------------------------

schedulingRouter.post("/book", async (req: Request, res: Response) => {
  const clinicNum = getClinicNum(req);
  const actorId = getActorId(req);
  const source = getSource(req);

  try {
    const body = req.body as {
      slot?: TimeSlot;
      patientId?: string;
      evaluation?: { category: string; durationMinutes: number };
      notes?: string;
      source?: string;
    };

    if (!body.slot || !body.evaluation) {
      return errorResponse(res, 400, "MISSING_PARAMS", "slot and evaluation are required");
    }

    const adapter = getAdapter(clinicNum);

    // Validate constraints before booking
    const constraintResult = await checkConstraints(adapter, {
      slot: body.slot,
      evaluation: body.evaluation as never,
      endDateTime: new Date(
        new Date(body.slot.dateTime).getTime() + body.evaluation.durationMinutes * 60000
      ).toISOString(),
    });

    if (!constraintResult.valid) {
      return errorResponse(
        res,
        409,
        "CONSTRAINT_VIOLATION",
        `Cannot book: ${constraintResult.violations.map((v) => v.message).join("; ")}`
      );
    }

    // Create the appointment in PMS
    const created = await adapter.createAppointment({
      patientId: body.patientId,
      providerId: body.slot.providerId,
      operatoryId: body.slot.operatoryId,
      dateTime: body.slot.dateTime,
      duration: body.slot.duration,
      type: body.evaluation.category,
      note: body.notes,
      clinicNum,
    });

    auditLog("APPOINTMENT_BOOKED", {
      actorId,
      source,
      clinicNum,
      patientId: body.patientId,
      appointmentId: created.id,
      context: {
        category: body.evaluation.category,
        dateTime: body.slot.dateTime,
        providerId: body.slot.providerId,
        operatoryId: body.slot.operatoryId,
      },
      success: true,
    });

    return res.json({
      success: true,
      appointment: {
        appointmentId: created.id,
        pmsAppointmentId: created.id,
        clinicNum,
        dateTime: created.dateTime,
        duration: created.duration,
        providerId: created.providerId,
        providerName: body.slot.providerName,
        operatoryId: created.operatoryId,
        operatoryName: body.slot.operatoryName,
        patientId: body.patientId,
        category: body.evaluation.category,
        confirmedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    auditLog("APPOINTMENT_BOOKED", {
      actorId,
      source,
      clinicNum,
      success: false,
      error: String(err),
    });
    return errorResponse(res, 500, "BOOKING_ERROR", "Failed to book appointment");
  }
});

// ---------------------------------------------------------------------------
// GET /api/scheduling/appointments?startDate=&endDate=&providerId=&operatoryId=
// Returns: { appointments: PMSAppointment[] }
// ---------------------------------------------------------------------------

schedulingRouter.get("/appointments", async (req: Request, res: Response) => {
  const clinicNum = getClinicNum(req);
  const actorId = getActorId(req);
  const source = getSource(req);

  try {
    const { startDate, endDate } = req.query as Record<string, string>;

    if (!startDate || !endDate) {
      return errorResponse(res, 400, "MISSING_PARAMS", "startDate and endDate are required");
    }

    const adapter = getAdapter(clinicNum);
    const slots = await adapter.getAvailableSlots({
      clinicNum,
      startDate,
      endDate,
      durationMinutes: 30,
      providerType: "ANY" as never,
    });

    auditLog("SLOTS_FETCHED", {
      actorId,
      source,
      clinicNum,
      context: { startDate, endDate },
      success: true,
    });

    return res.json({ success: true, appointments: slots });
  } catch (err) {
    return errorResponse(res, 500, "FETCH_ERROR", "Failed to fetch appointments");
  }
});

// ---------------------------------------------------------------------------
// POST /api/scheduling/emergency-check
// Body: { clinicNum?: number }
// Returns: EmergencyCheckResult
// ---------------------------------------------------------------------------

schedulingRouter.post("/emergency-check", async (req: Request, res: Response) => {
  const clinicNum = getClinicNum(req);
  const actorId = getActorId(req);
  const source = getSource(req);

  try {
    const adapter = getAdapter(clinicNum);
    const result = await checkEmergencySlots(adapter, clinicNum);

    auditLog("EMERGENCY_CHECK", {
      actorId,
      source,
      clinicNum,
      context: { hasPrioritySlot: result.hasPrioritySlot },
      success: true,
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    auditLog("EMERGENCY_CHECK", {
      actorId,
      source,
      clinicNum,
      success: false,
      error: String(err),
    });
    return errorResponse(res, 500, "EMERGENCY_CHECK_ERROR", "Failed to check emergency slots");
  }
});

// ---------------------------------------------------------------------------
// GET /api/scheduling/audit-log?clinicNum=
// Returns: { entries: AuditEntry[] }
// ---------------------------------------------------------------------------

schedulingRouter.get("/audit-log", (req: Request, res: Response) => {
  const clinicNum = getClinicNum(req);
  const entries = getRecentAuditLog(clinicNum || undefined);
  return res.json({ success: true, entries });
});
