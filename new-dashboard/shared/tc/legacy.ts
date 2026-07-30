/**
 * TC module — legacy TC-app boundary (Slice 1).
 *
 * Typed schemas for the shapes the legacy TC-app actually produced (the
 * client-owned PatientCase & friends the old server accepted via
 * `.passthrough()`), plus the one-way mappers into the strict contract.
 * This file is the ONLY place legacy sloppiness is tolerated; nothing past
 * `legacyCaseToTc()` ever sees it. The Slice 2 importer and the round-trip
 * tests are the consumers.
 *
 * LEGACY → CONTRACT FIELD MAP (the full table lives in docs/TC_SCHEMA.md):
 *  - location 'riley'                → officeId 'valley' (Fort Smith). 'roland' unchanged.
 *  - float dollars                   → integer cents via dollarsToCents (Math.round(d*100), negatives clamp to 0).
 *  - followUps[] + followUpSteps[] + nurtureTouchpoints[]
 *                                    → ONE followups[] list (TcFollowup, kind-discriminated). See unifyFollowups().
 *  - contactAttempts[]               → events[] type 'contact_attempt' with typed detail payload.
 *  - hygieneIntake                   → hygieneIntake (1:0..1, strict).
 *  - phases[].id (number)            → phase.position; items keep legacy ids in legacyItemId,
 *                                      'od_<n>' item ids also parse into odProcNum.
 *  - financingOptions[]              → DROPPED (stale derived snapshots — the documented DOM-04 bug;
 *                                      recomputed from tc_library_config + patient portion at render time).
 *  - nextFollowUpDate (@deprecated)  → DROPPED (derived from the followup queue).
 *  - Both dropped fields survive verbatim inside tc_cases.legacy_snapshot at import.
 */
import { z } from "zod";
import {
  ContactAttemptDetail,
  TcCase,
  TcCaseEvent,
  TcFollowup,
  TcHygieneIntake,
  TcPreauthCase,
  type OfficeId,
} from "./contract";

// ── Conversions ─────────────────────────────────────────────────────────────

/**
 * Legacy float dollars → integer cents. Math.round(d * 100); non-finite and
 * negative inputs clamp to 0 (legacy computed patient portions already clamp
 * at 0 — a negative here is corrupt data, not a refund).
 */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * 100);
}

/** Frozen internal office keys. Legacy 'riley' = Fort Smith = 'valley'. */
export function legacyLocationToOffice(location: string | undefined | null): OfficeId {
  return location === "riley" ? "valley" : "roland";
}

/** 'YYYY-MM-DD' | ISO timestamp | junk → 'YYYY-MM-DD' or null. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const head = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
}

/** 'YYYY-MM-DD' | ISO timestamp | junk → full ISO timestamp (UTC) or null. */
export function toIsoTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ── Legacy shapes (tolerant-but-typed; unknown keys are stripped) ───────────

const LegacyMoney = z.number().catch(0);
const Str = z.string().catch("");

export const LegacyTreatmentItem = z.object({
  id: Str.default(""),
  tooth: Str.default(""),
  procedureName: Str.default(""),
  patientDescription: Str.default(""),
  fee: LegacyMoney.default(0),
  estimatedInsurance: LegacyMoney.default(0),
  patientPortion: LegacyMoney.default(0),
  urgency: z.enum(["high", "medium", "low", "elective"]).catch("medium"),
  timeEstimate: Str.default(""),
  benefits: z.array(z.string()).catch([]).default([]),
  risksOfDelay: z.array(z.string()).catch([]).default([]),
  expectedOutcome: Str.default(""),
});

export const LegacyTreatmentPhase = z.object({
  id: z.number().catch(0),
  name: Str.default(""),
  description: Str.default(""),
  items: z.array(LegacyTreatmentItem).default([]),
});

export const LegacyObjection = z.object({
  category: Str.default("other"),
  note: Str.default(""),
  patientWords: Str.default(""),
  loggedAt: Str.default(""),
});

/** System 1 (oldest): no ids, boolean completed, free-text note. */
export const LegacyFollowUp = z.object({
  type: z.enum(["phone_call", "email", "text", "in_person"]).catch("phone_call"),
  dueDate: Str.default(""),
  note: Str.default(""),
  completed: z.boolean().catch(false),
});

/** System 2 (current): ids, status, outcome, source. */
export const LegacyFollowUpStep = z.object({
  id: Str.default(""),
  dueDate: Str.default(""),
  type: z.enum(["phone_call", "text", "email", "in_person"]).catch("phone_call"),
  suggestedTalkingPoint: Str.default(""),
  status: z.enum(["pending", "completed", "skipped"]).catch("pending"),
  outcomeNote: Str.default(""),
  completedAt: z.string().nullable().catch(null).default(null),
  source: z.enum(["auto", "manual"]).catch("manual"),
  patientResponded: z.boolean().nullable().optional().catch(null),
});

/** System 3 (campaign outreach) — unified into the same queue. */
export const LegacyNurtureTouchpoint = z.object({
  id: Str.default(""),
  type: z.enum(["check_in", "seasonal", "life_event", "financing"]).catch("check_in"),
  dueDate: Str.default(""),
  status: z.enum(["pending", "completed", "skipped"]).catch("pending"),
  channel: z.enum(["call", "text", "email"]).catch("call"),
  scriptTemplate: Str.default(""),
  completedAt: z.string().nullable().catch(null).default(null),
  completedBy: z.string().nullable().catch(null).default(null),
  note: z.string().nullable().catch(null).default(null),
});

export const LegacyContactAttempt = z.object({
  id: Str.default(""),
  date: Str.default(""),
  type: z.enum(["call", "text", "email"]).catch("call"),
  outcome: z.enum(["reached", "voicemail", "no_answer"]).catch("no_answer"),
  note: Str.default(""),
});

export const LegacyCaseEvent = z.object({
  id: Str.default(""),
  timestamp: Str.default(""),
  type: z
    .enum([
      "status_change",
      "follow_up_completed",
      "objection_logged",
      "note_added",
      "case_created",
      "nurture_enrolled",
    ])
    .catch("note_added"),
  description: Str.default(""),
  actor: z.string().optional(),
});

export const LegacyHygieneIntake = z.object({
  submittedById: Str.default(""),
  submittedByName: Str.default(""),
  submittedAt: Str.default(""),
  operatory: Str.default(""),
  visitDate: Str.default(""),
  providerSeen: Str.default(""),
  chiefConcern: Str.default(""),
  perioStatus: z
    .enum(["healthy", "gingivitis", "early_perio", "moderate_perio", "advanced_perio", "unknown"])
    .catch("unknown"),
  recallType: z.enum(["prophy", "perio_maint", "srp_needed", "d4346", "fmd", "none"]).catch("none"),
  radiographs: z.array(z.enum(["BWX", "PANO", "FMX", "PA", "none"])).catch([]).default([]),
  intraoralPhotosTaken: z.boolean().catch(false),
  areasOfConcern: Str.default(""),
  suspectedTreatment: Str.default(""),
  hygienistRecommendation: Str.default(""),
  insuranceNoted: Str.default(""),
  patientInterestLevel: z.enum(["hot", "warm", "cold", "unknown"]).catch("unknown"),
  flagUrgent: z.boolean().catch(false),
});

/** Legacy FinancingOption — parsed only to archive; never mapped forward. */
export const LegacyFinancingOption = z.object({
  provider: Str.default(""),
  termMonths: z.number().catch(0),
  apr: z.number().catch(0),
  monthlyPayment: LegacyMoney.default(0),
  downPayment: LegacyMoney.default(0),
  totalCost: LegacyMoney.default(0),
});

export const LegacyPatientCase = z.object({
  id: z.string().min(1),
  patientName: z.string().min(1),
  age: z.number().catch(0),
  phone: Str.default(""),
  email: Str.default(""),
  caseType: Str.default(""),
  category: z
    .enum(["single_tooth", "quadrant", "implant", "full_mouth_rehab", "full_arch", "cosmetic", "ortho"])
    .catch("single_tooth"),
  doctor: Str.default(""),
  tc: Str.default(""),
  location: z.enum(["roland", "riley"]).catch("roland"),
  status: z
    .enum([
      "hygiene_review",
      "diagnosed",
      "pending_tc",
      "pending_pt",
      "presented",
      "considering",
      "financing_pending",
      "accepted",
      "partially_accepted",
      "scheduled",
      "started",
      "completed",
      "lost",
      "nurture",
    ])
    .catch("diagnosed"),
  urgency: z.enum(["high", "medium", "low", "elective"]).catch("medium"),
  caseValue: LegacyMoney.default(0),
  readinessScore: z.number().catch(0),
  financingStatus: Str.default(""),
  phases: z.array(LegacyTreatmentPhase).default([]),
  financingOptions: z.array(LegacyFinancingOption).default([]), // archived, not mapped
  objections: z.array(LegacyObjection).default([]),
  followUps: z.array(LegacyFollowUp).default([]),
  keyMotivators: z.array(z.string()).catch([]).default([]),
  notes: Str.default(""),
  nextFollowUpDate: z.string().nullable().catch(null).default(null), // deprecated — dropped
  diagnosedDate: Str.default(""),
  odPatientId: z.number().nullable().catch(null).default(null),
  followUpSteps: z.array(LegacyFollowUpStep).default([]),
  contactAttempts: z.array(LegacyContactAttempt).optional(),
  nurtureCadence: z.enum(["light", "standard", "high_touch"]).catch("standard"),
  inLongTailMode: z.boolean().catch(false),
  lostReason: z
    .enum(["moved", "chose_another_provider", "declined_permanently", "unresponsive", "other"])
    .nullable()
    .catch(null)
    .default(null),
  preferredFinancingProvider: z.string().nullable().catch(null).default(null),
  decisionMakers: Str.default(""),
  financialSituation: z.array(z.string()).catch([]).default([]),
  contactPreference: z.enum(["phone", "text", "email"]).nullable().catch(null).default(null),
  bestTimeToReach: Str.default(""),
  nurtureEnrolledAt: z.string().nullable().catch(null).default(null),
  nurturePhaseChangedAt: z.string().nullable().catch(null).default(null),
  nurtureCadenceOverride: z
    .object({
      phase1Days: z.number().nullable().catch(null).default(null),
      phase2Days: z.number().nullable().catch(null).default(null),
    })
    .nullable()
    .catch(null)
    .default(null),
  nurtureUnsubscribed: z.boolean().catch(false),
  nurtureTouchpoints: z.array(LegacyNurtureTouchpoint).default([]),
  referralSource: z
    .enum(["google", "existing_patient", "doctor_referral", "social_media", "carein_call", "walk_in", "hygiene", "other"])
    .nullable()
    .optional()
    .catch(null),
  statusChangedAt: z.string().nullable().optional().catch(null),
  caseEvents: z.array(LegacyCaseEvent).optional(),
  hygieneIntake: LegacyHygieneIntake.nullable().optional(),
});
export type LegacyPatientCase = z.infer<typeof LegacyPatientCase>;

export const LegacyPreAuthCase = z.object({
  id: z.string().min(1),
  patientName: z.string().min(1),
  phone: Str.default(""),
  email: Str.default(""),
  odPatientId: z.number().nullable().catch(null).default(null),
  preAuthType: z.enum(["treatment", "perio", "manual"]).catch("manual"),
  description: Str.default(""),
  insuranceCarrier: Str.default(""),
  status: z
    .enum(["pending", "submitted", "in_review", "approved", "denied", "appealing", "expired"])
    .catch("pending"),
  doctor: Str.default(""),
  createdAt: Str.default(""),
  submittedDate: z.string().nullable().catch(null).default(null),
  decisionDate: z.string().nullable().catch(null).default(null),
  referenceNumber: Str.default(""),
  notes: Str.default(""),
  location: z.enum(["roland", "riley"]).optional().catch(undefined),
});
export type LegacyPreAuthCase = z.infer<typeof LegacyPreAuthCase>;

// ── Follow-up unification ───────────────────────────────────────────────────

const NURTURE_CHANNEL_MAP = { call: "phone_call", text: "text", email: "email" } as const;

/**
 * The unification decision, in code. Three legacy lists → one queue:
 *  - followUpSteps[] map 1:1 (kind 'followup', source preserved).
 *  - followUps[] (legacy system) map with source 'legacy'; boolean completed
 *    → status; completedAt is unknowable → null; note → talkingPoint.
 *  - nurtureTouchpoints[] map to kind 'nurture'; channel 'call' → 'phone_call';
 *    scriptTemplate → talkingPoint; note → outcomeNote; completedBy preserved.
 * Items with no parseable dueDate are dropped (a queue item without a due
 * date is unactionable) — the importer counts and reports every drop.
 */
export function unifyFollowups(
  legacy: Pick<LegacyPatientCase, "followUps" | "followUpSteps" | "nurtureTouchpoints">,
  newId: () => string,
): TcFollowup[] {
  const out: TcFollowup[] = [];

  for (const s of legacy.followUpSteps) {
    const dueDate = toIsoDate(s.dueDate);
    if (!dueDate) continue;
    out.push(
      TcFollowup.parse({
        followupId: newId(),
        legacyId: s.id || null,
        kind: "followup",
        dueDate,
        channel: s.type,
        status: s.status,
        talkingPoint: s.suggestedTalkingPoint,
        outcomeNote: s.outcomeNote,
        completedAt: toIsoTimestamp(s.completedAt),
        completedBy: null,
        source: s.source,
        patientResponded: s.patientResponded ?? null,
        nurtureType: null,
      }),
    );
  }

  for (const f of legacy.followUps) {
    const dueDate = toIsoDate(f.dueDate);
    if (!dueDate) continue;
    out.push(
      TcFollowup.parse({
        followupId: newId(),
        legacyId: null, // system 1 had no ids
        kind: "followup",
        dueDate,
        channel: f.type,
        status: f.completed ? "completed" : "pending",
        talkingPoint: f.note,
        outcomeNote: "",
        completedAt: null, // boolean-only legacy state: completion time unknowable
        completedBy: null,
        source: "legacy",
        patientResponded: null,
        nurtureType: null,
      }),
    );
  }

  for (const n of legacy.nurtureTouchpoints) {
    const dueDate = toIsoDate(n.dueDate);
    if (!dueDate) continue;
    out.push(
      TcFollowup.parse({
        followupId: newId(),
        legacyId: n.id || null,
        kind: "nurture",
        dueDate,
        channel: NURTURE_CHANNEL_MAP[n.channel],
        status: n.status,
        talkingPoint: n.scriptTemplate,
        outcomeNote: n.note ?? "",
        completedAt: toIsoTimestamp(n.completedAt),
        completedBy: n.completedBy,
        source: "auto", // touchpoints were always cadence-generated
        patientResponded: null,
        nurtureType: n.type,
      }),
    );
  }

  return out;
}

// ── Full case mapping ───────────────────────────────────────────────────────

/**
 * Map one legacy PatientCase into the strict contract. Throws (ZodError) if
 * the result violates the contract — the importer treats that as a per-case
 * failure to report, never a silent skip.
 */
export function legacyCaseToTc(input: unknown, newId: () => string): TcCase {
  const legacy = LegacyPatientCase.parse(input);
  const officeId = legacyLocationToOffice(legacy.location);

  const events: TcCaseEvent[] = [];
  for (const e of legacy.caseEvents ?? []) {
    const ts = toIsoTimestamp(e.timestamp);
    if (!ts) continue;
    events.push(
      TcCaseEvent.parse({
        eventId: newId(),
        legacyId: e.id || null,
        ts,
        type: e.type,
        description: e.description,
        actor: e.actor ?? null,
        detail: null,
      }),
    );
  }
  for (const a of legacy.contactAttempts ?? []) {
    const ts = toIsoTimestamp(a.date);
    if (!ts) continue;
    events.push(
      TcCaseEvent.parse({
        eventId: newId(),
        legacyId: a.id || null,
        ts,
        type: "contact_attempt",
        description: a.note,
        actor: null,
        detail: ContactAttemptDetail.parse({ channel: a.type, outcome: a.outcome }),
      }),
    );
  }

  let hygieneIntake: TcHygieneIntake | null = null;
  if (legacy.hygieneIntake) {
    const h = legacy.hygieneIntake;
    hygieneIntake = TcHygieneIntake.parse({
      submittedBy: h.submittedById || "unknown",
      submittedByName: h.submittedByName,
      submittedAt: toIsoTimestamp(h.submittedAt) ?? new Date(0).toISOString(),
      operatory: h.operatory,
      visitDate: toIsoDate(h.visitDate),
      providerSeen: h.providerSeen,
      chiefConcern: h.chiefConcern,
      perioStatus: h.perioStatus,
      recallType: h.recallType,
      radiographs: h.radiographs,
      intraoralPhotosTaken: h.intraoralPhotosTaken,
      areasOfConcern: h.areasOfConcern,
      suspectedTreatment: h.suspectedTreatment,
      hygienistRecommendation: h.hygienistRecommendation,
      insuranceNoted: h.insuranceNoted,
      patientInterestLevel: h.patientInterestLevel,
      flagUrgent: h.flagUrgent,
    });
  }

  return TcCase.parse({
    caseId: newId(),
    legacyId: legacy.id,
    officeId,
    patientName: legacy.patientName,
    patientAge: legacy.age > 0 && legacy.age <= 130 ? Math.round(legacy.age) : null,
    phone: legacy.phone || null,
    email: legacy.email || null,
    odPatientId: legacy.odPatientId && legacy.odPatientId > 0 ? legacy.odPatientId : null,
    caseType: legacy.caseType,
    category: legacy.category,
    status: legacy.status,
    urgency: legacy.urgency,
    doctorName: legacy.doctor,
    // Legacy cases carried only the free-text doctor name — no provider
    // identity existed to map. New case-entry flows (Slice 3+) set this.
    diagnosingProvider: null,
    assignedTc: legacy.tc,
    caseValueCents: dollarsToCents(legacy.caseValue),
    readinessScore: Math.min(100, Math.max(0, Math.round(legacy.readinessScore))),
    financingStatus: legacy.financingStatus,
    preferredFinancingProvider: legacy.preferredFinancingProvider,
    decisionMakers: legacy.decisionMakers,
    financialSituation: legacy.financialSituation,
    keyMotivators: legacy.keyMotivators,
    contactPreference: legacy.contactPreference,
    bestTimeToReach: legacy.bestTimeToReach,
    notes: legacy.notes,
    referralSource: legacy.referralSource ?? null,
    lostReason: legacy.lostReason,
    diagnosedDate: toIsoDate(legacy.diagnosedDate),
    statusChangedAt: toIsoTimestamp(legacy.statusChangedAt ?? null),
    nurtureCadence: legacy.nurtureCadence,
    inLongTailMode: legacy.inLongTailMode,
    nurtureEnrolledAt: toIsoTimestamp(legacy.nurtureEnrolledAt),
    nurturePhaseChangedAt: toIsoTimestamp(legacy.nurturePhaseChangedAt),
    nurturePhase1DaysOverride: legacy.nurtureCadenceOverride?.phase1Days ?? null,
    nurturePhase2DaysOverride: legacy.nurtureCadenceOverride?.phase2Days ?? null,
    nurtureUnsubscribed: legacy.nurtureUnsubscribed,
    phases: legacy.phases.map((p, phaseIdx) => ({
      phaseId: newId(),
      position: Number.isFinite(p.id) && p.id > 0 ? Math.round(p.id) : phaseIdx + 1,
      name: p.name || `Phase ${phaseIdx + 1}`,
      description: p.description,
      items: p.items.map((it, itemIdx) => {
        const odMatch = /^od_(\d+)$/.exec(it.id);
        return {
          itemId: newId(),
          legacyItemId: it.id || null,
          odProcNum: odMatch ? Number(odMatch[1]) : null,
          position: itemIdx,
          tooth: it.tooth,
          procedureName: it.procedureName || "Unnamed procedure",
          patientDescription: it.patientDescription,
          feeCents: dollarsToCents(it.fee),
          insuranceEstCents: dollarsToCents(it.estimatedInsurance),
          patientPortionCents: dollarsToCents(it.patientPortion),
          urgency: it.urgency,
          timeEstimate: it.timeEstimate,
          benefits: it.benefits,
          risksOfDelay: it.risksOfDelay,
          expectedOutcome: it.expectedOutcome,
        };
      }),
    })),
    objections: legacy.objections.map((o) => ({
      objectionId: newId(),
      category: o.category || "other",
      note: o.note,
      patientWords: o.patientWords,
      loggedAt: toIsoTimestamp(o.loggedAt) ?? new Date(0).toISOString(),
    })),
    followups: unifyFollowups(legacy, newId),
    events,
    hygieneIntake,
  });
}

/** Map one legacy PreAuthCase into the strict contract. */
export function legacyPreauthToTc(input: unknown, newId: () => string): TcPreauthCase {
  const legacy = LegacyPreAuthCase.parse(input);
  return TcPreauthCase.parse({
    preauthId: newId(),
    legacyId: legacy.id,
    officeId: legacyLocationToOffice(legacy.location ?? null),
    caseId: null, // legacy pre-auths had no case link
    patientName: legacy.patientName,
    phone: legacy.phone || null,
    email: legacy.email || null,
    odPatientId: legacy.odPatientId && legacy.odPatientId > 0 ? legacy.odPatientId : null,
    preauthType: legacy.preAuthType,
    description: legacy.description,
    insuranceCarrier: legacy.insuranceCarrier,
    status: legacy.status,
    doctorName: legacy.doctor,
    createdAt: toIsoTimestamp(legacy.createdAt) ?? new Date(0).toISOString(),
    submittedDate: toIsoDate(legacy.submittedDate),
    decisionDate: toIsoDate(legacy.decisionDate),
    referenceNumber: legacy.referenceNumber,
    notes: legacy.notes,
  });
}
