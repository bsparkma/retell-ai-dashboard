/**
 * The Checkout inbox's api (queue item 50). One function per route in
 * backend/routes/tc/checkout.js; every answer is parsed through the shared
 * contract, so a server that drifted is a loud error here, not a quiet blank.
 */
import { z } from "zod";

import { tcRequest, TcApiError } from "@/features/tc/api";
import {
  TcCheckoutHandoff,
  TcCheckoutSummary,
  TcCheckoutCaseTreatment,
  TcCheckoutPanelItem,
  TcCheckoutAppointmentsResponse,
  TcCheckoutScheduleCheck,
  type TcCheckoutUpcomingAppointment,
  type TcCheckoutOutcome,
  type TcCheckoutWorkupRequest,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

export type CheckoutView = "waiting" | "done";

const ListResponse = z.object({
  success: z.literal(true),
  today: z.string(),
  view: z.enum(["waiting", "done"]),
  handoffs: z.array(TcCheckoutHandoff),
});

const OneResponse = z.object({ success: z.literal(true), handoff: TcCheckoutHandoff });

const OutcomeResponse = z.object({
  success: z.literal(true),
  handoff: TcCheckoutHandoff,
  caseId: z.string().uuid().nullable(),
  url: z.string().nullable(),
  attached: z.boolean(),
});
export type CheckoutOutcomeResult = z.infer<typeof OutcomeResponse>;

/** Parse, or throw the mismatch in words. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The checkout answer could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

export async function listCheckout(office: OfficeId, view: CheckoutView) {
  return parse(ListResponse, await tcRequest<unknown>("/tc/checkout", { office, params: { view } }));
}

/**
 * Cards from today's schedule (CO-5b): the office's state. Asking also starts
 * a schedule read on the server when the office's last one is older than its
 * 60-second window, so the answer can say `running: true`.
 */
export async function getScheduleCheck(office: OfficeId): Promise<TcCheckoutScheduleCheck> {
  return parse(TcCheckoutScheduleCheck, await tcRequest<unknown>("/tc/checkout/schedule-check", { office }));
}

export async function getCheckoutSummary(office: OfficeId): Promise<TcCheckoutSummary> {
  return parse(TcCheckoutSummary, await tcRequest<unknown>("/tc/checkout/summary", { office }));
}

export async function getCheckoutHandoff(office: OfficeId, handoffId: string): Promise<TcCheckoutHandoff> {
  const res = parse(OneResponse, await tcRequest<unknown>(`/tc/checkout/${handoffId}`, { office }));
  return res.handoff;
}

const ManualAddResponse = z.object({
  success: z.literal(true),
  /** False when the patient already had a card today: the server opened that one. */
  created: z.boolean(),
  handoff: TcCheckoutHandoff,
});
export type CheckoutManualAddResult = z.infer<typeof ManualAddResponse>;

/**
 * "Add patient" (CO-5a): put the picked patient on today's Checkout, or open
 * the card they already have. The body names only the PatNum; the server takes
 * the office from the request and the name from that office's Open Dental.
 */
export async function addCheckoutPatient(office: OfficeId, patNum: number): Promise<CheckoutManualAddResult> {
  return parse(
    ManualAddResponse,
    await tcRequest<unknown>("/tc/checkout/manual", { office, method: "POST", body: { patNum } }),
  );
}

export async function claimCheckout(office: OfficeId, handoffId: string): Promise<TcCheckoutHandoff> {
  const res = parse(
    OneResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/claim`, { office, method: "POST", body: {} }),
  );
  return res.handoff;
}

export async function dismissCheckout(
  office: OfficeId,
  handoffId: string,
  reason: string,
): Promise<TcCheckoutHandoff> {
  const res = parse(
    OneResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/dismiss`, {
      office,
      method: "POST",
      body: { reason },
    }),
  );
  return res.handoff;
}

export async function recordCheckoutOutcome(
  office: OfficeId,
  handoffId: string,
  outcome: TcCheckoutOutcome,
  appointmentNote: string,
  /** CO-4a, Scheduled only: the picked AptNum, or null for "Not in Open Dental yet". */
  aptNum: number | null = null,
): Promise<CheckoutOutcomeResult> {
  return parse(
    OutcomeResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/outcome`, {
      office,
      method: "POST",
      body: outcome === "scheduled" ? { outcome, appointmentNote, aptNum } : { outcome, appointmentNote },
    }),
  );
}

// ── CO-4a: the "Scheduled" appointment anchor ───────────────────────────────

/**
 * The checkout's patient's UPCOMING Open Dental appointments, soonest first.
 * The server reads them for the stored record's office and patient; nothing
 * here names either. A failed read throws (OD_APPOINTMENTS_UNAVAILABLE) — it is
 * never an empty list.
 */
export async function listCheckoutAppointments(
  office: OfficeId,
  handoffId: string,
): Promise<TcCheckoutUpcomingAppointment[]> {
  const res = parse(
    TcCheckoutAppointmentsResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/appointments`, { office }),
  );
  return res.appointments;
}

/** Link, change, or (null) clear a Scheduled checkout's appointment, later. */
export async function linkCheckoutAppointment(
  office: OfficeId,
  handoffId: string,
  aptNum: number | null,
): Promise<TcCheckoutHandoff> {
  const res = parse(
    OneResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/appointment`, { office, method: "POST", body: { aptNum } }),
  );
  return res.handoff;
}

// ── C2b (item 50b): the staff panel and "entered in Open Dental" ────────────

const EnteredResponse = z.object({
  success: z.literal(true),
  handoffId: z.string().uuid(),
  item: TcCheckoutPanelItem,
  alreadyEntered: z.boolean().optional(),
});
export type CheckoutEnteredResult = z.infer<typeof EnteredResponse>;

/** The staff-only "Treatment from hygiene" panel for one case. */
export async function getCaseHygieneTreatment(
  office: OfficeId,
  caseId: string,
): Promise<TcCheckoutCaseTreatment> {
  return parse(
    TcCheckoutCaseTreatment,
    await tcRequest<unknown>(`/tc/checkout/by-case/${caseId}`, { office }),
  );
}

/** Attest that one staged item has been entered in Open Dental (by hand). */
export async function markItemEntered(
  office: OfficeId,
  handoffId: string,
  index: number,
): Promise<CheckoutEnteredResult> {
  return parse(
    EnteredResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/items/${index}/entered`, {
      office,
      method: "POST",
      body: {},
    }),
  );
}

/** Undo that attestation (admin only; the server enforces it). */
export async function undoItemEntered(
  office: OfficeId,
  handoffId: string,
  index: number,
): Promise<CheckoutEnteredResult> {
  return parse(
    EnteredResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/items/${index}/entered`, {
      office,
      method: "DELETE",
    }),
  );
}

// ── CO-1: the workup checklist ──────────────────────────────────────────────

const WorkupResponse = z.object({
  success: z.literal(true),
  handoff: TcCheckoutHandoff,
  unchanged: z.boolean(),
});

/**
 * Tick or untick ONE box on the workup checklist. The answer is the checklist
 * the server READ BACK after storing it; the caller renders that, never the click.
 */
export async function setCheckoutWorkup(
  office: OfficeId,
  handoffId: string,
  body: TcCheckoutWorkupRequest,
): Promise<TcCheckoutHandoff> {
  const res = parse(
    WorkupResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/workup`, { office, method: "POST", body }),
  );
  return res.handoff;
}
