/**
 * TC module — DB row mapping for the case aggregate (Slice 1).
 *
 * Bidirectional, lossless mapping between the strict contract's TcCase
 * aggregate and the flat snake_case rows of tc_cases + children
 * (tc_case_phases, tc_case_items, tc_case_objections, tc_followups,
 * tc_case_events, tc_hygiene_intakes). The Slice 2 importer writes
 * caseToRows() output; Slice 3 routes read rows and serve
 * caseFromRows() output. Round-trip losslessness is proven in
 * tests/tc-contract.test.ts.
 *
 * Row interfaces mirror migration 1785373200000_tc_schema.js column-for-column
 * (minus created_at/updated_at bookkeeping, which the DB owns).
 */
import {
  TcCase,
  type ContactAttemptDetail,
  type OfficeId,
  type TcCommunication,
  type TcEmailTemplate,
  type TcGalleryCase,
  type TcLegacyUserMapEntry,
  type TcPreauthCase,
  type TcSmileSimulation,
} from "./contract";
import type { EmailBlock } from "./emailBlocks";

type Iso = string;

export interface TcCaseRow {
  case_id: string;
  legacy_id: string | null;
  office_id: OfficeId;
  patient_name: string;
  patient_age: number | null;
  phone: string | null;
  email: string | null;
  od_patient_id: number | null;
  case_type: string;
  category: string;
  status: string;
  urgency: string;
  doctor_name: string;
  diagnosing_provider: string | null;
  assigned_tc: string;
  case_value_cents: number;
  readiness_score: number;
  financing_status: string;
  preferred_financing_provider: string | null;
  decision_makers: string;
  financial_situation: string[];
  key_motivators: string[];
  contact_preference: string | null;
  best_time_to_reach: string;
  notes: string;
  referral_source: string | null;
  lost_reason: string | null;
  diagnosed_date: string | null;
  status_changed_at: Iso | null;
  nurture_cadence: string;
  in_long_tail_mode: boolean;
  nurture_enrolled_at: Iso | null;
  nurture_phase_changed_at: Iso | null;
  nurture_phase1_days_override: number | null;
  nurture_phase2_days_override: number | null;
  nurture_unsubscribed: boolean;
}

export interface TcCasePhaseRow {
  phase_id: string;
  case_id: string;
  office_id: OfficeId;
  position: number;
  name: string;
  description: string;
}

export interface TcCaseItemRow {
  item_id: string;
  phase_id: string;
  case_id: string;
  office_id: OfficeId;
  position: number;
  legacy_item_id: string | null;
  od_proc_num: number | null;
  tooth: string;
  procedure_name: string;
  patient_description: string;
  fee_cents: number;
  insurance_est_cents: number;
  patient_portion_cents: number;
  urgency: string;
  time_estimate: string;
  benefits: string[];
  risks_of_delay: string[];
  expected_outcome: string;
}

export interface TcCaseObjectionRow {
  objection_id: string;
  case_id: string;
  office_id: OfficeId;
  category: string;
  note: string;
  patient_words: string;
  logged_at: Iso;
}

export interface TcFollowupRow {
  followup_id: string;
  case_id: string;
  office_id: OfficeId;
  kind: string;
  due_date: string;
  channel: string;
  status: string;
  talking_point: string;
  outcome_note: string;
  completed_at: Iso | null;
  completed_by: string | null;
  source: string;
  patient_responded: boolean | null;
  nurture_type: string | null;
  legacy_id: string | null;
}

export interface TcCaseEventRow {
  event_id: string;
  case_id: string;
  office_id: OfficeId;
  ts: Iso;
  type: string;
  description: string;
  actor: string | null;
  detail: ContactAttemptDetail | null;
  legacy_id: string | null;
}

export interface TcHygieneIntakeRow {
  intake_id: string;
  case_id: string;
  office_id: OfficeId;
  submitted_by: string;
  submitted_by_name: string;
  submitted_at: Iso;
  operatory: string;
  visit_date: string | null;
  provider_seen: string;
  chief_concern: string;
  perio_status: string;
  recall_type: string;
  radiographs: string[];
  intraoral_photos_taken: boolean;
  areas_of_concern: string;
  suspected_treatment: string;
  hygienist_recommendation: string;
  insurance_noted: string;
  patient_interest_level: string;
  flag_urgent: boolean;
}

export interface TcCaseRows {
  caseRow: TcCaseRow;
  phaseRows: TcCasePhaseRow[];
  itemRows: TcCaseItemRow[];
  objectionRows: TcCaseObjectionRow[];
  followupRows: TcFollowupRow[];
  eventRows: TcCaseEventRow[];
  hygieneIntakeRow: TcHygieneIntakeRow | null;
}

/** Contract aggregate → flat rows. `newId` supplies the hygiene intake_id. */
export function caseToRows(tcCase: TcCase, newId: () => string): TcCaseRows {
  const c = tcCase;
  const office = c.officeId;

  const caseRow: TcCaseRow = {
    case_id: c.caseId,
    legacy_id: c.legacyId,
    office_id: office,
    patient_name: c.patientName,
    patient_age: c.patientAge,
    phone: c.phone,
    email: c.email,
    od_patient_id: c.odPatientId,
    case_type: c.caseType,
    category: c.category,
    status: c.status,
    urgency: c.urgency,
    doctor_name: c.doctorName,
    diagnosing_provider: c.diagnosingProvider,
    assigned_tc: c.assignedTc,
    case_value_cents: c.caseValueCents,
    readiness_score: c.readinessScore,
    financing_status: c.financingStatus,
    preferred_financing_provider: c.preferredFinancingProvider,
    decision_makers: c.decisionMakers,
    financial_situation: c.financialSituation,
    key_motivators: c.keyMotivators,
    contact_preference: c.contactPreference,
    best_time_to_reach: c.bestTimeToReach,
    notes: c.notes,
    referral_source: c.referralSource,
    lost_reason: c.lostReason,
    diagnosed_date: c.diagnosedDate,
    status_changed_at: c.statusChangedAt,
    nurture_cadence: c.nurtureCadence,
    in_long_tail_mode: c.inLongTailMode,
    nurture_enrolled_at: c.nurtureEnrolledAt,
    nurture_phase_changed_at: c.nurturePhaseChangedAt,
    nurture_phase1_days_override: c.nurturePhase1DaysOverride,
    nurture_phase2_days_override: c.nurturePhase2DaysOverride,
    nurture_unsubscribed: c.nurtureUnsubscribed,
  };

  const phaseRows: TcCasePhaseRow[] = [];
  const itemRows: TcCaseItemRow[] = [];
  for (const p of c.phases) {
    phaseRows.push({
      phase_id: p.phaseId,
      case_id: c.caseId,
      office_id: office,
      position: p.position,
      name: p.name,
      description: p.description,
    });
    for (const it of p.items) {
      itemRows.push({
        item_id: it.itemId,
        phase_id: p.phaseId,
        case_id: c.caseId,
        office_id: office,
        position: it.position,
        legacy_item_id: it.legacyItemId,
        od_proc_num: it.odProcNum,
        tooth: it.tooth,
        procedure_name: it.procedureName,
        patient_description: it.patientDescription,
        fee_cents: it.feeCents,
        insurance_est_cents: it.insuranceEstCents,
        patient_portion_cents: it.patientPortionCents,
        urgency: it.urgency,
        time_estimate: it.timeEstimate,
        benefits: it.benefits,
        risks_of_delay: it.risksOfDelay,
        expected_outcome: it.expectedOutcome,
      });
    }
  }

  const objectionRows: TcCaseObjectionRow[] = c.objections.map((o) => ({
    objection_id: o.objectionId,
    case_id: c.caseId,
    office_id: office,
    category: o.category,
    note: o.note,
    patient_words: o.patientWords,
    logged_at: o.loggedAt,
  }));

  const followupRows: TcFollowupRow[] = c.followups.map((f) => ({
    followup_id: f.followupId,
    case_id: c.caseId,
    office_id: office,
    kind: f.kind,
    due_date: f.dueDate,
    channel: f.channel,
    status: f.status,
    talking_point: f.talkingPoint,
    outcome_note: f.outcomeNote,
    completed_at: f.completedAt,
    completed_by: f.completedBy,
    source: f.source,
    patient_responded: f.patientResponded,
    nurture_type: f.nurtureType,
    legacy_id: f.legacyId,
  }));

  const eventRows: TcCaseEventRow[] = c.events.map((e) => ({
    event_id: e.eventId,
    case_id: c.caseId,
    office_id: office,
    ts: e.ts,
    type: e.type,
    description: e.description,
    actor: e.actor,
    detail: e.detail,
    legacy_id: e.legacyId,
  }));

  const hygieneIntakeRow: TcHygieneIntakeRow | null = c.hygieneIntake
    ? {
        intake_id: newId(),
        case_id: c.caseId,
        office_id: office,
        submitted_by: c.hygieneIntake.submittedBy,
        submitted_by_name: c.hygieneIntake.submittedByName,
        submitted_at: c.hygieneIntake.submittedAt,
        operatory: c.hygieneIntake.operatory,
        visit_date: c.hygieneIntake.visitDate,
        provider_seen: c.hygieneIntake.providerSeen,
        chief_concern: c.hygieneIntake.chiefConcern,
        perio_status: c.hygieneIntake.perioStatus,
        recall_type: c.hygieneIntake.recallType,
        radiographs: c.hygieneIntake.radiographs,
        intraoral_photos_taken: c.hygieneIntake.intraoralPhotosTaken,
        areas_of_concern: c.hygieneIntake.areasOfConcern,
        suspected_treatment: c.hygieneIntake.suspectedTreatment,
        hygienist_recommendation: c.hygieneIntake.hygienistRecommendation,
        insurance_noted: c.hygieneIntake.insuranceNoted,
        patient_interest_level: c.hygieneIntake.patientInterestLevel,
        flag_urgent: c.hygieneIntake.flagUrgent,
      }
    : null;

  return { caseRow, phaseRows, itemRows, objectionRows, followupRows, eventRows, hygieneIntakeRow };
}

/**
 * Flat rows → contract aggregate. Validates through TcCase.parse — a corrupt
 * row set fails loudly rather than producing a half-formed case.
 */
export function caseFromRows(rows: TcCaseRows): TcCase {
  const { caseRow, phaseRows, itemRows, objectionRows, followupRows, eventRows, hygieneIntakeRow } =
    rows;

  const itemsByPhase = new Map<string, TcCaseItemRow[]>();
  for (const it of itemRows) {
    const list = itemsByPhase.get(it.phase_id) ?? [];
    list.push(it);
    itemsByPhase.set(it.phase_id, list);
  }

  return TcCase.parse({
    caseId: caseRow.case_id,
    legacyId: caseRow.legacy_id,
    officeId: caseRow.office_id,
    patientName: caseRow.patient_name,
    patientAge: caseRow.patient_age,
    phone: caseRow.phone,
    email: caseRow.email,
    odPatientId: caseRow.od_patient_id,
    caseType: caseRow.case_type,
    category: caseRow.category,
    status: caseRow.status,
    urgency: caseRow.urgency,
    doctorName: caseRow.doctor_name,
    diagnosingProvider: caseRow.diagnosing_provider,
    assignedTc: caseRow.assigned_tc,
    caseValueCents: caseRow.case_value_cents,
    readinessScore: caseRow.readiness_score,
    financingStatus: caseRow.financing_status,
    preferredFinancingProvider: caseRow.preferred_financing_provider,
    decisionMakers: caseRow.decision_makers,
    financialSituation: caseRow.financial_situation,
    keyMotivators: caseRow.key_motivators,
    contactPreference: caseRow.contact_preference,
    bestTimeToReach: caseRow.best_time_to_reach,
    notes: caseRow.notes,
    referralSource: caseRow.referral_source,
    lostReason: caseRow.lost_reason,
    diagnosedDate: caseRow.diagnosed_date,
    statusChangedAt: caseRow.status_changed_at,
    nurtureCadence: caseRow.nurture_cadence,
    inLongTailMode: caseRow.in_long_tail_mode,
    nurtureEnrolledAt: caseRow.nurture_enrolled_at,
    nurturePhaseChangedAt: caseRow.nurture_phase_changed_at,
    nurturePhase1DaysOverride: caseRow.nurture_phase1_days_override,
    nurturePhase2DaysOverride: caseRow.nurture_phase2_days_override,
    nurtureUnsubscribed: caseRow.nurture_unsubscribed,
    phases: [...phaseRows]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        phaseId: p.phase_id,
        position: p.position,
        name: p.name,
        description: p.description,
        items: (itemsByPhase.get(p.phase_id) ?? [])
          .sort((a, b) => a.position - b.position)
          .map((it) => ({
            itemId: it.item_id,
            legacyItemId: it.legacy_item_id,
            odProcNum: it.od_proc_num,
            position: it.position,
            tooth: it.tooth,
            procedureName: it.procedure_name,
            patientDescription: it.patient_description,
            feeCents: it.fee_cents,
            insuranceEstCents: it.insurance_est_cents,
            patientPortionCents: it.patient_portion_cents,
            urgency: it.urgency,
            timeEstimate: it.time_estimate,
            benefits: it.benefits,
            risksOfDelay: it.risks_of_delay,
            expectedOutcome: it.expected_outcome,
          })),
      })),
    objections: objectionRows.map((o) => ({
      objectionId: o.objection_id,
      category: o.category,
      note: o.note,
      patientWords: o.patient_words,
      loggedAt: o.logged_at,
    })),
    followups: followupRows.map((f) => ({
      followupId: f.followup_id,
      legacyId: f.legacy_id,
      kind: f.kind,
      dueDate: f.due_date,
      channel: f.channel,
      status: f.status,
      talkingPoint: f.talking_point,
      outcomeNote: f.outcome_note,
      completedAt: f.completed_at,
      completedBy: f.completed_by,
      source: f.source,
      patientResponded: f.patient_responded,
      nurtureType: f.nurture_type,
    })),
    events: eventRows.map((e) => ({
      eventId: e.event_id,
      legacyId: e.legacy_id,
      ts: e.ts,
      type: e.type,
      description: e.description,
      actor: e.actor,
      detail: e.detail,
    })),
    hygieneIntake: hygieneIntakeRow
      ? {
          submittedBy: hygieneIntakeRow.submitted_by,
          submittedByName: hygieneIntakeRow.submitted_by_name,
          submittedAt: hygieneIntakeRow.submitted_at,
          operatory: hygieneIntakeRow.operatory,
          visitDate: hygieneIntakeRow.visit_date,
          providerSeen: hygieneIntakeRow.provider_seen,
          chiefConcern: hygieneIntakeRow.chief_concern,
          perioStatus: hygieneIntakeRow.perio_status,
          recallType: hygieneIntakeRow.recall_type,
          radiographs: hygieneIntakeRow.radiographs,
          intraoralPhotosTaken: hygieneIntakeRow.intraoral_photos_taken,
          areasOfConcern: hygieneIntakeRow.areas_of_concern,
          suspectedTreatment: hygieneIntakeRow.suspected_treatment,
          hygienistRecommendation: hygieneIntakeRow.hygienist_recommendation,
          insuranceNoted: hygieneIntakeRow.insurance_noted,
          patientInterestLevel: hygieneIntakeRow.patient_interest_level,
          flagUrgent: hygieneIntakeRow.flag_urgent,
        }
      : null,
  });
}

// ── Non-case entity rows (Slice 2 importer + Slice 3 reads) ─────────────────
// Same convention as the case aggregate: interfaces mirror the migration
// column-for-column minus DB-owned bookkeeping. Gallery/smile-sim/comm rows
// carry their historical timestamp column explicitly (created_at / sent_at)
// because the contract preserves it; everything else lets the DB default.

export interface TcPreauthRow {
  preauth_id: string;
  legacy_id: string | null;
  office_id: OfficeId;
  case_id: string | null;
  patient_name: string;
  phone: string | null;
  email: string | null;
  od_patient_id: number | null;
  preauth_type: string;
  description: string;
  insurance_carrier: string;
  status: string;
  doctor_name: string;
  submitted_date: string | null;
  decision_date: string | null;
  reference_number: string;
  notes: string;
}

export function preauthToRow(p: TcPreauthCase): TcPreauthRow {
  return {
    preauth_id: p.preauthId,
    legacy_id: p.legacyId,
    office_id: p.officeId,
    case_id: p.caseId,
    patient_name: p.patientName,
    phone: p.phone,
    email: p.email,
    od_patient_id: p.odPatientId,
    preauth_type: p.preauthType,
    description: p.description,
    insurance_carrier: p.insuranceCarrier,
    status: p.status,
    doctor_name: p.doctorName,
    submitted_date: p.submittedDate,
    decision_date: p.decisionDate,
    reference_number: p.referenceNumber,
    notes: p.notes,
  };
}

export interface TcEmailTemplateRow {
  template_id: string;
  legacy_id: string | null;
  office_id: OfficeId;
  name: string;
  category: string;
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
  is_seed: boolean;
}

export function templateToRow(t: TcEmailTemplate): TcEmailTemplateRow {
  return {
    template_id: t.templateId,
    legacy_id: t.legacyId,
    office_id: t.officeId,
    name: t.name,
    category: t.category,
    subject: t.subject,
    preheader: t.preheader,
    blocks: t.blocks,
    is_seed: t.isSeed,
  };
}

export interface TcCommunicationRow {
  comm_id: string;
  legacy_id: string | null;
  office_id: OfficeId;
  case_id: string | null;
  template_id: string | null;
  template_name: string;
  sender: string;
  sender_name: string;
  to_email: string;
  subject: string;
  status: string;
  provider_message_id: string | null;
  error: string | null;
  sent_at: string;
}

export function communicationToRow(c: TcCommunication): TcCommunicationRow {
  return {
    comm_id: c.commId,
    legacy_id: c.legacyId,
    office_id: c.officeId,
    case_id: c.caseId,
    template_id: c.templateId,
    template_name: c.templateName,
    sender: c.sender,
    sender_name: c.senderName,
    to_email: c.toEmail,
    subject: c.subject,
    status: c.status,
    provider_message_id: c.providerMessageId,
    error: c.error,
    sent_at: c.sentAt,
  };
}

export interface TcGalleryRow {
  gallery_id: string;
  legacy_id: string | null;
  office_id: OfficeId;
  title: string;
  category: string;
  description: string;
  doctor_name: string;
  before_blob_key: string;
  after_blob_key: string;
  created_at: string;
}

export function galleryToRow(g: TcGalleryCase): TcGalleryRow {
  return {
    gallery_id: g.galleryId,
    legacy_id: g.legacyId,
    office_id: g.officeId,
    title: g.title,
    category: g.category,
    description: g.description,
    doctor_name: g.doctorName,
    before_blob_key: g.beforeBlobKey,
    after_blob_key: g.afterBlobKey,
    created_at: g.createdAt,
  };
}

export interface TcSmileSimulationRow {
  sim_id: string;
  legacy_id: string | null;
  office_id: OfficeId;
  case_id: string | null;
  treatment_type: string;
  prompt: string;
  original_blob_key: string;
  result_blob_key: string;
  saved_to_gallery: boolean;
  gallery_id: string | null;
  created_by: string;
  created_at: string;
}

export function simulationToRow(s: TcSmileSimulation): TcSmileSimulationRow {
  return {
    sim_id: s.simId,
    legacy_id: s.legacyId,
    office_id: s.officeId,
    case_id: s.caseId,
    treatment_type: s.treatmentType,
    prompt: s.prompt,
    original_blob_key: s.originalBlobKey,
    result_blob_key: s.resultBlobKey,
    saved_to_gallery: s.savedToGallery,
    gallery_id: s.galleryId,
    created_by: s.createdBy,
    created_at: s.createdAt,
  };
}

export interface TcLibraryConfigRow {
  office_id: OfficeId;
  section: string;
  value: unknown;
}

export interface TcLegacyUserMapRow {
  legacy_user_id: string;
  platform_email: string;
  display_name: string;
  legacy_role: string;
}

export function userMapEntryToRow(u: TcLegacyUserMapEntry): TcLegacyUserMapRow {
  return {
    legacy_user_id: u.legacyUserId,
    platform_email: u.platformEmail,
    display_name: u.displayName,
    legacy_role: u.legacyRole,
  };
}
