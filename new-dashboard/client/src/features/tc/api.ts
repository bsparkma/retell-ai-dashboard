/**
 * TC module API client — the ONLY way TC pages talk to /api/tc.
 *
 * Differences from lib/api.ts's request() that make this wrapper necessary:
 *  - /api/tc errors carry `{ success:false, error, code }` (the `error` key,
 *    not `message`) — the main wrapper would surface "HTTP 403" instead of
 *    MODULE_NOT_ENTITLED. TcApiError preserves status + code + issues.
 *  - Every endpoint requires `?office=roland|valley` (never "all", never a
 *    header) — enforced here by typing office as OfficeId.
 *  - Money is integer cents end-to-end; list/queue endpoints return snake_case
 *    DB rows which are mapped to camelCase here so components never see them.
 *
 * Confirmed-save rule (Slice-0 standing rule): none of these functions toast.
 * They resolve with the server's persisted row or throw — callers toast
 * success ONLY after the promise resolves and keep dialogs open on rejection.
 */
import type { z } from "zod";
import type {
  CaseCategory,
  CaseStatus,
  ContactAttemptDetail,
  FollowupChannel,
  FollowupKind,
  FollowupSource,
  FollowupStatus,
  LibrarySection,
  LibrarySectionSchemas,
  LostReason,
  NurtureType,
  OfficeId,
  PatientInterestLevel,
  PerioStatus,
  PreauthStatus,
  PreauthType,
  RecallType,
  Radiograph,
  TcCase,
  TcCaseEvent,
  TcCaseItem,
  TcCasePhase,
  TcCommunication,
  TcEmailTemplate,
  TcGalleryCase,
  TcObjection,
  TcPreauthCase,
  TcSmileSimulation,
  Urgency,
} from "@shared/tc/contract";

type CaseStatusId = z.infer<typeof CaseStatus>;
type PreauthStatusId = z.infer<typeof PreauthStatus>;
type UrgencyId = z.infer<typeof Urgency>;

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";
const DASHBOARD_TOKEN = (import.meta.env.VITE_DASHBOARD_API_TOKEN ?? "").trim();

// ── Error type ──────────────────────────────────────────────────────────────

export interface TcValidationIssue {
  path: string;
  code: string;
  message: string;
}

export class TcApiError extends Error {
  readonly status: number;
  /** Backend error code, e.g. MODULE_NOT_ENTITLED, LOST_REASON_REQUIRED. */
  readonly code: string | null;
  /** Present on 501 FEATURE_DISABLED responses. */
  readonly feature: string | null;
  readonly issues: TcValidationIssue[];

  constructor(
    message: string,
    status: number,
    code: string | null,
    feature: string | null,
    issues: TcValidationIssue[],
  ) {
    super(message);
    this.name = "TcApiError";
    this.status = status;
    this.code = code;
    this.feature = feature;
    this.issues = issues;
  }
}

/** Human-friendly line for a caught error — use in toast.error(...). */
export function tcErrorMessage(err: unknown): string {
  if (err instanceof TcApiError) {
    if (err.code === "MODULE_NOT_ENTITLED") {
      return "This practice isn't enabled for Treatment Coordinator yet.";
    }
    if (err.code === "FEATURE_DISABLED") return "This feature isn't enabled yet.";
    if (err.code === "VALIDATION_FAILED" && err.issues.length > 0) {
      const first = err.issues[0];
      return first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : err.message;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

// ── Core request ────────────────────────────────────────────────────────────

interface TcRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  office: OfficeId;
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

async function tcRequest<T>(path: string, options: TcRequestOptions): Promise<T> {
  const { method = "GET", office, params, body } = options;
  const url = new URL(
    `${BASE}${path.startsWith("/") ? "" : "/"}${path}`,
    window.location.origin,
  );
  url.searchParams.set("office", office);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    });
  }
  const authHeaders: Record<string, string> = DASHBOARD_TOKEN
    ? { Authorization: `Bearer ${DASHBOARD_TOKEN}` }
    : {};
  const res = await fetch(url.toString(), {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const obj = (parsed ?? {}) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
      feature?: unknown;
      issues?: unknown;
    };
    const message =
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.message === "string" && obj.message) ||
      `HTTP ${res.status}`;
    const issues: TcValidationIssue[] = Array.isArray(obj.issues)
      ? obj.issues.filter(
          (i): i is TcValidationIssue =>
            typeof i === "object" && i !== null && "message" in i,
        )
      : [];
    throw new TcApiError(
      message,
      res.status,
      typeof obj.code === "string" ? obj.code : null,
      typeof obj.feature === "string" ? obj.feature : null,
      issues,
    );
  }
  return parsed as T;
}

// ── Cases ───────────────────────────────────────────────────────────────────

/** GET /cases list item — TcCase scalars (no children) + timestamps. */
export type TcCaseSummary = Omit<
  TcCase,
  "phases" | "objections" | "followups" | "events" | "hygieneIntake"
> & { createdAt: string; updatedAt: string };

export interface TcCaseListFilters {
  status?: CaseStatusId;
  category?: z.infer<typeof CaseCategory>;
  assignee?: string;
}

export type TcItemCreate = Omit<TcCaseItem, "itemId" | "legacyItemId">;
export type TcPhaseCreate = Omit<TcCasePhase, "phaseId" | "items"> & {
  items?: TcItemCreate[];
};

/** POST /cases body — contract minus server-owned fields; most fields default. */
export type TcCaseCreate = Partial<
  Omit<
    TcCase,
    | "caseId"
    | "legacyId"
    | "officeId"
    | "statusChangedAt"
    | "phases"
    | "objections"
    | "followups"
    | "events"
    | "hygieneIntake"
  >
> & {
  patientName: string;
  category: z.infer<typeof CaseCategory>;
  status: CaseStatusId;
  urgency: UrgencyId;
  phases?: TcPhaseCreate[];
};

export type TcCaseScalarPatch = Partial<
  Omit<
    TcCase,
    | "caseId"
    | "legacyId"
    | "officeId"
    | "status"
    | "lostReason"
    | "statusChangedAt"
    | "phases"
    | "objections"
    | "followups"
    | "events"
    | "hygieneIntake"
  >
>;

export function listCases(
  office: OfficeId,
  filters?: TcCaseListFilters,
): Promise<TcCaseSummary[]> {
  return tcRequest<{ cases: TcCaseSummary[] }>("/tc/cases", {
    office,
    params: { ...filters },
  }).then((r) => r.cases);
}

export function createCase(office: OfficeId, input: TcCaseCreate): Promise<TcCase> {
  return tcRequest<{ case: TcCase }>("/tc/cases", {
    method: "POST",
    office,
    body: input,
  }).then((r) => r.case);
}

export function getCase(office: OfficeId, caseId: string): Promise<TcCase> {
  return tcRequest<{ case: TcCase }>(`/tc/cases/${caseId}`, { office }).then((r) => r.case);
}

export function patchCase(
  office: OfficeId,
  caseId: string,
  patch: TcCaseScalarPatch,
): Promise<TcCase> {
  return tcRequest<{ case: TcCase }>(`/tc/cases/${caseId}`, {
    method: "PUT",
    office,
    body: patch,
  }).then((r) => r.case);
}

/** THE status transition path (mirrors backend guards in status.ts). */
export function transitionCase(
  office: OfficeId,
  caseId: string,
  input: {
    status: CaseStatusId;
    lostReason?: z.infer<typeof LostReason> | null;
    note?: string;
  },
): Promise<{ changed: boolean; case: TcCase }> {
  return tcRequest<{ changed: boolean; case: TcCase }>(`/tc/cases/${caseId}/status`, {
    method: "POST",
    office,
    body: { lostReason: null, note: "", ...input },
  });
}

export function deleteCase(office: OfficeId, caseId: string): Promise<void> {
  return tcRequest<{ success: true }>(`/tc/cases/${caseId}`, {
    method: "DELETE",
    office,
  }).then(() => undefined);
}

export function replacePhases(
  office: OfficeId,
  caseId: string,
  phases: TcPhaseCreate[],
): Promise<TcCase> {
  return tcRequest<{ case: TcCase }>(`/tc/cases/${caseId}/phases`, {
    method: "PUT",
    office,
    body: phases,
  }).then((r) => r.case);
}

export type TcObjectionCreate = Omit<TcObjection, "objectionId" | "loggedAt"> & {
  loggedAt?: string;
};

export function addObjection(
  office: OfficeId,
  caseId: string,
  input: TcObjectionCreate,
): Promise<TcObjection> {
  return tcRequest<{ objection: TcObjection }>(`/tc/cases/${caseId}/objections`, {
    method: "POST",
    office,
    body: input,
  }).then((r) => r.objection);
}

export function deleteObjection(
  office: OfficeId,
  caseId: string,
  objectionId: string,
): Promise<void> {
  return tcRequest<{ success: true }>(`/tc/cases/${caseId}/objections/${objectionId}`, {
    method: "DELETE",
    office,
  }).then(() => undefined);
}

export function addCaseEvent(
  office: OfficeId,
  caseId: string,
  input: {
    type: "note_added" | "contact_attempt";
    description?: string;
    detail?: ContactAttemptDetail | null;
  },
): Promise<TcCaseEvent> {
  return tcRequest<{ event: TcCaseEvent }>(`/tc/cases/${caseId}/events`, {
    method: "POST",
    office,
    body: input,
  }).then((r) => r.event);
}

// ── Follow-ups (snake_case rows mapped here) ────────────────────────────────

export interface TcQueueFollowup {
  followupId: string;
  caseId: string;
  officeId: OfficeId;
  kind: z.infer<typeof FollowupKind>;
  dueDate: string;
  channel: z.infer<typeof FollowupChannel>;
  status: z.infer<typeof FollowupStatus>;
  talkingPoint: string;
  outcomeNote: string;
  completedAt: string | null;
  completedBy: string | null;
  source: z.infer<typeof FollowupSource>;
  patientResponded: boolean | null;
  nurtureType: z.infer<typeof NurtureType> | null;
  legacyId: string | null;
}

/** Due-queue row: followup + joined case context. */
export interface TcDueFollowup extends TcQueueFollowup {
  patientName: string;
  casePhone: string | null;
  caseStatus: CaseStatusId;
  assignedTc: string;
  caseValueCents: number;
  caseUrgency: UrgencyId;
}

interface FollowupRow {
  followup_id: string;
  case_id: string;
  office_id: OfficeId;
  kind: z.infer<typeof FollowupKind>;
  due_date: string;
  channel: z.infer<typeof FollowupChannel>;
  status: z.infer<typeof FollowupStatus>;
  talking_point: string;
  outcome_note: string;
  completed_at: string | null;
  completed_by: string | null;
  source: z.infer<typeof FollowupSource>;
  patient_responded: boolean | null;
  nurture_type: z.infer<typeof NurtureType> | null;
  legacy_id: string | null;
}

interface DueFollowupRow extends FollowupRow {
  patient_name: string;
  case_phone: string | null;
  case_status: CaseStatusId;
  assigned_tc: string;
  case_value_cents: number;
  case_urgency: UrgencyId;
}

function mapFollowupRow(r: FollowupRow): TcQueueFollowup {
  return {
    followupId: r.followup_id,
    caseId: r.case_id,
    officeId: r.office_id,
    kind: r.kind,
    dueDate: r.due_date,
    channel: r.channel,
    status: r.status,
    talkingPoint: r.talking_point,
    outcomeNote: r.outcome_note,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
    source: r.source,
    patientResponded: r.patient_responded,
    nurtureType: r.nurture_type,
    legacyId: r.legacy_id,
  };
}

function mapDueFollowupRow(r: DueFollowupRow): TcDueFollowup {
  return {
    ...mapFollowupRow(r),
    patientName: r.patient_name,
    casePhone: r.case_phone,
    caseStatus: r.case_status,
    assignedTc: r.assigned_tc,
    caseValueCents: Number(r.case_value_cents),
    caseUrgency: r.case_urgency,
  };
}

export function followupsDue(
  office: OfficeId,
  filters?: { date?: string; assignee?: string; kind?: z.infer<typeof FollowupKind> },
): Promise<TcDueFollowup[]> {
  return tcRequest<{ due: DueFollowupRow[] }>("/tc/followups/due", {
    office,
    params: filters,
  }).then((r) => r.due.map(mapDueFollowupRow));
}

export function listFollowups(
  office: OfficeId,
  filters?: {
    caseId?: string;
    status?: z.infer<typeof FollowupStatus>;
    kind?: z.infer<typeof FollowupKind>;
  },
): Promise<TcQueueFollowup[]> {
  return tcRequest<{ followups: FollowupRow[] }>("/tc/followups", {
    office,
    params: filters,
  }).then((r) => r.followups.map(mapFollowupRow));
}

export function createFollowup(
  office: OfficeId,
  input: {
    caseId: string;
    kind: z.infer<typeof FollowupKind>;
    dueDate: string;
    channel: z.infer<typeof FollowupChannel>;
    talkingPoint: string;
    outcomeNote?: string;
    patientResponded?: boolean | null;
    nurtureType?: z.infer<typeof NurtureType> | null;
    source?: "auto" | "manual";
  },
): Promise<TcQueueFollowup> {
  return tcRequest<{ followup: FollowupRow }>("/tc/followups", {
    method: "POST",
    office,
    body: input,
  }).then((r) => mapFollowupRow(r.followup));
}

export function completeFollowup(
  office: OfficeId,
  followupId: string,
  input?: { outcomeNote?: string; patientResponded?: boolean },
): Promise<TcQueueFollowup> {
  return tcRequest<{ followup: FollowupRow }>(`/tc/followups/${followupId}/complete`, {
    method: "POST",
    office,
    body: input ?? {},
  }).then((r) => mapFollowupRow(r.followup));
}

export function skipFollowup(
  office: OfficeId,
  followupId: string,
  input?: { outcomeNote?: string },
): Promise<TcQueueFollowup> {
  return tcRequest<{ followup: FollowupRow }>(`/tc/followups/${followupId}/skip`, {
    method: "POST",
    office,
    body: input ?? {},
  }).then((r) => mapFollowupRow(r.followup));
}

export function rescheduleFollowup(
  office: OfficeId,
  followupId: string,
  dueDate: string,
): Promise<TcQueueFollowup> {
  return tcRequest<{ followup: FollowupRow }>(`/tc/followups/${followupId}/reschedule`, {
    method: "POST",
    office,
    body: { dueDate },
  }).then((r) => mapFollowupRow(r.followup));
}

// ── Hygiene intakes ─────────────────────────────────────────────────────────

/** POST /hygiene-intakes body: clinical intake + case-entry fields. */
export interface TcIntakeSubmit {
  // Case entry.
  patientName: string;
  patientAge?: number | null;
  phone?: string | null;
  email?: string | null;
  odPatientId?: number | null;
  diagnosingProvider: string; // required — who diagnosed chairside
  category: z.infer<typeof CaseCategory>;
  urgency: UrgencyId;
  caseType?: string;
  // Clinical intake (contract TcHygieneIntake minus submittedBy/Name/At).
  operatory?: string;
  visitDate?: string | null;
  providerSeen?: string;
  chiefConcern?: string;
  perioStatus: z.infer<typeof PerioStatus>;
  recallType: z.infer<typeof RecallType>;
  radiographs: z.infer<typeof Radiograph>[];
  intraoralPhotosTaken: boolean;
  areasOfConcern?: string;
  suspectedTreatment?: string;
  hygienistRecommendation?: string;
  insuranceNoted?: string;
  patientInterestLevel: z.infer<typeof PatientInterestLevel>;
  flagUrgent: boolean;
}

export interface TcMyIntake {
  intakeId: string;
  caseId: string;
  officeId: OfficeId;
  submittedBy: string;
  submittedByName: string;
  submittedAt: string;
  visitDate: string | null;
  chiefConcern: string;
  suspectedTreatment: string;
  flagUrgent: boolean;
  patientInterestLevel: z.infer<typeof PatientInterestLevel>;
  patientName: string;
  caseStatus: CaseStatusId;
}

export interface TcInboxIntake {
  intakeId: string;
  caseId: string;
  officeId: OfficeId;
  submittedBy: string;
  submittedByName: string;
  submittedAt: string;
  visitDate: string | null;
  chiefConcern: string;
  perioStatus: z.infer<typeof PerioStatus>;
  recallType: z.infer<typeof RecallType>;
  radiographs: z.infer<typeof Radiograph>[];
  intraoralPhotosTaken: boolean;
  areasOfConcern: string;
  suspectedTreatment: string;
  hygienistRecommendation: string;
  insuranceNoted: string;
  patientInterestLevel: z.infer<typeof PatientInterestLevel>;
  flagUrgent: boolean;
  patientName: string;
  patientAge: number | null;
  phone: string | null;
  category: z.infer<typeof CaseCategory>;
  urgency: UrgencyId;
  diagnosingProvider: string | null;
}

interface IntakeRowBase {
  intake_id: string;
  case_id: string;
  office_id: OfficeId;
  submitted_by: string;
  submitted_by_name: string;
  submitted_at: string;
  operatory: string;
  visit_date: string | null;
  provider_seen: string;
  chief_concern: string;
  perio_status: z.infer<typeof PerioStatus>;
  recall_type: z.infer<typeof RecallType>;
  radiographs: z.infer<typeof Radiograph>[];
  intraoral_photos_taken: boolean;
  areas_of_concern: string;
  suspected_treatment: string;
  hygienist_recommendation: string;
  insurance_noted: string;
  patient_interest_level: z.infer<typeof PatientInterestLevel>;
  flag_urgent: boolean;
}

export function submitHygieneIntake(
  office: OfficeId,
  input: TcIntakeSubmit,
): Promise<TcCase> {
  return tcRequest<{ case: TcCase }>("/tc/hygiene-intakes", {
    method: "POST",
    office,
    body: input,
  }).then((r) => r.case);
}

export function myHygieneIntakes(office: OfficeId): Promise<TcMyIntake[]> {
  return tcRequest<{ intakes: (IntakeRowBase & { patient_name: string; case_status: CaseStatusId })[] }>(
    "/tc/hygiene-intakes/mine",
    { office },
  ).then((r) =>
    r.intakes.map((row) => ({
      intakeId: row.intake_id,
      caseId: row.case_id,
      officeId: row.office_id,
      submittedBy: row.submitted_by,
      submittedByName: row.submitted_by_name,
      submittedAt: row.submitted_at,
      visitDate: row.visit_date,
      chiefConcern: row.chief_concern,
      suspectedTreatment: row.suspected_treatment,
      flagUrgent: row.flag_urgent,
      patientInterestLevel: row.patient_interest_level,
      patientName: row.patient_name,
      caseStatus: row.case_status,
    })),
  );
}

export function hygieneInbox(office: OfficeId): Promise<TcInboxIntake[]> {
  return tcRequest<{
    inbox: (IntakeRowBase & {
      patient_name: string;
      patient_age: number | null;
      phone: string | null;
      category: z.infer<typeof CaseCategory>;
      urgency: UrgencyId;
      diagnosing_provider: string | null;
    })[];
  }>("/tc/hygiene-intakes/inbox", { office }).then((r) =>
    r.inbox.map((row) => ({
      intakeId: row.intake_id,
      caseId: row.case_id,
      officeId: row.office_id,
      submittedBy: row.submitted_by,
      submittedByName: row.submitted_by_name,
      submittedAt: row.submitted_at,
      visitDate: row.visit_date,
      chiefConcern: row.chief_concern,
      perioStatus: row.perio_status,
      recallType: row.recall_type,
      radiographs: row.radiographs,
      intraoralPhotosTaken: row.intraoral_photos_taken,
      areasOfConcern: row.areas_of_concern,
      suspectedTreatment: row.suspected_treatment,
      hygienistRecommendation: row.hygienist_recommendation,
      insuranceNoted: row.insurance_noted,
      patientInterestLevel: row.patient_interest_level,
      flagUrgent: row.flag_urgent,
      patientName: row.patient_name,
      patientAge: row.patient_age,
      phone: row.phone,
      category: row.category,
      urgency: row.urgency,
      diagnosingProvider: row.diagnosing_provider,
    })),
  );
}

/** Claim a hygiene_review case — assigns the caller, moves to pending_tc. */
export function claimHygieneCase(office: OfficeId, caseId: string): Promise<TcCase> {
  return tcRequest<{ case: TcCase }>(`/tc/hygiene-intakes/${caseId}/claim`, {
    method: "POST",
    office,
    body: {},
  }).then((r) => r.case);
}

// ── Pre-auth ────────────────────────────────────────────────────────────────

export interface TcPreauthCreate {
  patientName: string;
  preauthType: z.infer<typeof PreauthType>;
  insuranceCarrier: string;
  doctorName: string;
  caseId?: string | null;
  phone?: string | null;
  email?: string | null;
  odPatientId?: number | null;
  description?: string;
  referenceNumber?: string;
  notes?: string;
}

export type TcPreauthPatch = Partial<
  Pick<
    TcPreauthCase,
    | "patientName"
    | "phone"
    | "email"
    | "odPatientId"
    | "caseId"
    | "preauthType"
    | "description"
    | "insuranceCarrier"
    | "doctorName"
    | "referenceNumber"
    | "notes"
  >
>;

export function listPreauth(
  office: OfficeId,
  status?: PreauthStatusId,
): Promise<TcPreauthCase[]> {
  return tcRequest<{ preauthCases: TcPreauthCase[] }>("/tc/preauth", {
    office,
    params: { status },
  }).then((r) => r.preauthCases);
}

export function createPreauth(
  office: OfficeId,
  input: TcPreauthCreate,
): Promise<TcPreauthCase> {
  return tcRequest<{ preauthCase: TcPreauthCase }>("/tc/preauth", {
    method: "POST",
    office,
    body: input,
  }).then((r) => r.preauthCase);
}

export function getPreauth(office: OfficeId, preauthId: string): Promise<TcPreauthCase> {
  return tcRequest<{ preauthCase: TcPreauthCase }>(`/tc/preauth/${preauthId}`, {
    office,
  }).then((r) => r.preauthCase);
}

export function patchPreauth(
  office: OfficeId,
  preauthId: string,
  patch: TcPreauthPatch,
): Promise<TcPreauthCase> {
  return tcRequest<{ preauthCase: TcPreauthCase }>(`/tc/preauth/${preauthId}`, {
    method: "PUT",
    office,
    body: patch,
  }).then((r) => r.preauthCase);
}

export function transitionPreauth(
  office: OfficeId,
  preauthId: string,
  status: PreauthStatusId,
): Promise<TcPreauthCase> {
  return tcRequest<{ preauthCase: TcPreauthCase }>(`/tc/preauth/${preauthId}/status`, {
    method: "POST",
    office,
    body: { status },
  }).then((r) => r.preauthCase);
}

export function deletePreauth(office: OfficeId, preauthId: string): Promise<void> {
  return tcRequest<{ success: true }>(`/tc/preauth/${preauthId}`, {
    method: "DELETE",
    office,
  }).then(() => undefined);
}

// ── Email templates + communications ────────────────────────────────────────

export type TcTemplateCreate = Omit<
  TcEmailTemplate,
  "templateId" | "legacyId" | "officeId" | "isSeed" | "preheader"
> & { preheader?: string };

export type TcTemplatePatch = Partial<
  Pick<TcEmailTemplate, "name" | "category" | "subject" | "preheader" | "blocks">
>;

export function listTemplates(
  office: OfficeId,
  category?: TcEmailTemplate["category"],
): Promise<TcEmailTemplate[]> {
  return tcRequest<{ templates: TcEmailTemplate[] }>("/tc/templates", {
    office,
    params: { category },
  }).then((r) => r.templates);
}

export function createTemplate(
  office: OfficeId,
  input: TcTemplateCreate,
): Promise<TcEmailTemplate> {
  return tcRequest<{ template: TcEmailTemplate }>("/tc/templates", {
    method: "POST",
    office,
    body: input,
  }).then((r) => r.template);
}

export function getTemplate(office: OfficeId, templateId: string): Promise<TcEmailTemplate> {
  return tcRequest<{ template: TcEmailTemplate }>(`/tc/templates/${templateId}`, {
    office,
  }).then((r) => r.template);
}

export function patchTemplate(
  office: OfficeId,
  templateId: string,
  patch: TcTemplatePatch,
): Promise<TcEmailTemplate> {
  return tcRequest<{ template: TcEmailTemplate }>(`/tc/templates/${templateId}`, {
    method: "PUT",
    office,
    body: patch,
  }).then((r) => r.template);
}

/** 409 SEED_TEMPLATE_PROTECTED when deleting a seeded template. */
export function deleteTemplate(office: OfficeId, templateId: string): Promise<void> {
  return tcRequest<{ success: true }>(`/tc/templates/${templateId}`, {
    method: "DELETE",
    office,
  }).then(() => undefined);
}

export function duplicateTemplate(
  office: OfficeId,
  templateId: string,
): Promise<TcEmailTemplate> {
  return tcRequest<{ template: TcEmailTemplate }>(`/tc/templates/${templateId}/duplicate`, {
    method: "POST",
    office,
    body: {},
  }).then((r) => r.template);
}

export function listCommunications(
  office: OfficeId,
  filters?: { caseId?: string; limit?: number },
): Promise<TcCommunication[]> {
  return tcRequest<{ communications: TcCommunication[] }>("/tc/communications", {
    office,
    params: filters,
  }).then((r) => r.communications);
}

export function getCommunication(
  office: OfficeId,
  commId: string,
): Promise<TcCommunication> {
  return tcRequest<{ communication: TcCommunication }>(`/tc/communications/${commId}`, {
    office,
  }).then((r) => r.communication);
}

export interface TemplateUsage {
  total: number;
  last30Days: number;
}

export function templateUsage(office: OfficeId): Promise<Record<string, TemplateUsage>> {
  return tcRequest<{ usage: Record<string, TemplateUsage> }>(
    "/tc/communications/template-usage",
    { office },
  ).then((r) => r.usage);
}

/**
 * Email send/render/test-send — the backend returns 501 FEATURE_DISABLED until
 * platform email ships. Exposed so the composer can probe, but the UI keeps
 * Send visibly disabled ("coming with platform email") and never calls these
 * on a user path.
 */
export function sendEmail(office: OfficeId, body: unknown): Promise<never> {
  return tcRequest<never>("/tc/communications/send", { method: "POST", office, body });
}

// ── Gallery + smile sim + media ─────────────────────────────────────────────

export type TcGalleryCreate = Omit<
  TcGalleryCase,
  "galleryId" | "legacyId" | "officeId" | "createdAt" | "category" | "description" | "doctorName"
> & { category?: string; description?: string; doctorName?: string };

export function listGallery(office: OfficeId): Promise<TcGalleryCase[]> {
  return tcRequest<{ gallery: TcGalleryCase[] }>("/tc/gallery", { office }).then(
    (r) => r.gallery,
  );
}

export function createGalleryCase(
  office: OfficeId,
  input: TcGalleryCreate,
): Promise<TcGalleryCase> {
  return tcRequest<{ galleryCase: TcGalleryCase }>("/tc/gallery", {
    method: "POST",
    office,
    body: input,
  }).then((r) => r.galleryCase);
}

export function deleteGalleryCase(office: OfficeId, galleryId: string): Promise<void> {
  return tcRequest<{ success: true }>(`/tc/gallery/${galleryId}`, {
    method: "DELETE",
    office,
  }).then(() => undefined);
}

export function listSmileSims(
  office: OfficeId,
  caseId?: string,
): Promise<TcSmileSimulation[]> {
  return tcRequest<{ simulations: TcSmileSimulation[] }>("/tc/smile-sim", {
    office,
    params: { caseId },
  }).then((r) => r.simulations);
}

export function deleteSmileSim(office: OfficeId, simId: string): Promise<void> {
  return tcRequest<{ success: true }>(`/tc/smile-sim/${simId}`, {
    method: "DELETE",
    office,
  }).then(() => undefined);
}

/**
 * Image src for a stored blob key — the ONLY way TC media renders. Routes
 * through the entitlement-checked byte proxy; 404 for keys outside this
 * office, 503 MEDIA_STORE_UNCONFIGURED when blob storage isn't wired.
 */
export function tcMediaUrl(office: OfficeId, blobKey: string): string {
  const url = new URL(
    `${BASE}/tc/media`,
    typeof window !== "undefined" ? window.location.origin : "http://localhost",
  );
  url.searchParams.set("office", office);
  url.searchParams.set("key", blobKey);
  return url.toString();
}

// ── Library config ──────────────────────────────────────────────────────────

export type TcLibrary = {
  [K in LibrarySection]?: z.infer<(typeof LibrarySectionSchemas)[K]>;
};

export function getLibrary(office: OfficeId): Promise<TcLibrary> {
  return tcRequest<{ library: TcLibrary }>("/tc/library", { office }).then(
    (r) => r.library,
  );
}

export function getLibrarySection<K extends LibrarySection>(
  office: OfficeId,
  section: K,
): Promise<z.infer<(typeof LibrarySectionSchemas)[K]>> {
  return tcRequest<{ value: z.infer<(typeof LibrarySectionSchemas)[K]> }>(
    `/tc/library/${section}`,
    { office },
  ).then((r) => r.value);
}

export function putLibrarySection<K extends LibrarySection>(
  office: OfficeId,
  section: K,
  value: z.infer<(typeof LibrarySectionSchemas)[K]>,
): Promise<z.infer<(typeof LibrarySectionSchemas)[K]>> {
  return tcRequest<{ value: z.infer<(typeof LibrarySectionSchemas)[K]> }>(
    `/tc/library/${section}`,
    { method: "PUT", office, body: value },
  ).then((r) => r.value);
}
