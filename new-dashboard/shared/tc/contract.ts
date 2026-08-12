/**
 * TC module — the strict shared data contract (Slice 1).
 *
 * This is the design authority for every tc_* entity. It replaces — and
 * deliberately kills — the legacy TC-app server schema's `.passthrough()`
 * PatientCase: nothing enters or leaves the TC data layer without parsing one
 * of these schemas. No `.passthrough()`, no `any`, no unknown-field tolerance.
 *
 * Contract rules (see docs/TC_SCHEMA.md for the full decision log):
 *  - MONEY IS INTEGER CENTS. Every money field is `*Cents`, a non-negative
 *    integer. Legacy float dollars convert via `dollarsToCents()` in legacy.ts.
 *  - office is 'roland' | 'valley' — frozen internal keys. The legacy key
 *    'riley' maps to 'valley' at the legacy boundary, never here.
 *  - ONE follow-up model (TcFollowup) unifies the legacy followUps[] /
 *    followUpSteps[] / nurtureTouchpoints[] triplet, discriminated by `kind`.
 *  - Derived legacy state is NOT stored: per-case financingOptions[] and
 *    nextFollowUpDate are recomputed, not persisted (legacy.ts documents the
 *    mapping/drop of every legacy field).
 */
import { z } from "zod";
import { EmailBlocks } from "./emailBlocks";

// ── Shared primitives ────────────────────────────────────────────────────────

export const OfficeId = z.enum(["roland", "valley"]);
export type OfficeId = z.infer<typeof OfficeId>;

/** Non-negative integer cents. The only money representation in the module. */
export const Cents = z.number().int().min(0);

export const Uuid = z.string().uuid();
const IsoTimestamp = z.string().datetime({ offset: true });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");
const ShortText = z.string().max(200);
const LongText = z.string().max(8000);

// ── Vocabulary enums (mirror the tc_* CHECK constraints exactly) ────────────

export const CaseCategory = z.enum([
  "single_tooth",
  "quadrant",
  "implant",
  "full_mouth_rehab",
  "full_arch",
  "cosmetic",
  "ortho",
]);
export const CaseStatus = z.enum([
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
]);
export const Urgency = z.enum(["high", "medium", "low", "elective"]);
export const NurtureCadence = z.enum(["light", "standard", "high_touch"]);
export const ContactPreference = z.enum(["phone", "text", "email"]);
export const LostReason = z.enum([
  "moved",
  "chose_another_provider",
  "declined_permanently",
  "unresponsive",
  "other",
]);
export const ReferralSource = z.enum([
  "google",
  "existing_patient",
  "doctor_referral",
  "social_media",
  "carein_call",
  "walk_in",
  "hygiene",
  "other",
]);

export const FollowupKind = z.enum(["followup", "nurture"]);
export const FollowupChannel = z.enum(["phone_call", "text", "email", "in_person"]);
export const FollowupStatus = z.enum(["pending", "completed", "skipped"]);
export const FollowupSource = z.enum(["auto", "manual", "legacy"]);
export const NurtureType = z.enum(["check_in", "seasonal", "life_event", "financing"]);

export const CaseEventType = z.enum([
  "status_change",
  "follow_up_completed",
  "objection_logged",
  "note_added",
  "case_created",
  "nurture_enrolled",
  "contact_attempt",
  /**
   * A voice call was handed to the TC module (POST /api/tc/cases/from-call).
   * Server-written only — the client-loggable event endpoint cannot emit it.
   * This event IS the durable artifact of the handoff: the voice module prunes
   * call rows on its own schedule, so everything TC needs to show the handoff
   * later (summary text, call id, deep link) is SNAPSHOT into this row. Nothing
   * in TC may dereference a voice-module record.
   */
  "voice_handoff",
]);

/**
 * Which statuses mean "this case is still open TC work".
 *
 * The partition is the attach-or-create law for the voice handoff endpoint: an
 * inbound call attaches to a patient's most recently active OPEN case, and
 * opens a new case when every existing one is terminal. Terminal = the patient
 * has decided (accepted / partially_accepted) or the case has left the TC's
 * pursuit queue (scheduled, started, completed, lost) — a new call at that
 * point is new business, not a continuation of the same conversation.
 * `nurture` is deliberately OPEN: a long-tail case is still being pursued, and
 * an inbound call is exactly the outcome the nurture campaign exists to get.
 *
 * The two `satisfies` clauses + the _statusPartition checks below make this a
 * TOTAL partition at compile time: adding a CaseStatus without classifying it
 * (or classifying it twice, or misspelling one) fails `tsc --noEmit`.
 */
export const OPEN_CASE_STATUSES = [
  "hygiene_review",
  "diagnosed",
  "pending_tc",
  "pending_pt",
  "presented",
  "considering",
  "financing_pending",
  "nurture",
] as const satisfies readonly z.infer<typeof CaseStatus>[];

export const TERMINAL_CASE_STATUSES = [
  "accepted",
  "partially_accepted",
  "scheduled",
  "started",
  "completed",
  "lost",
] as const satisfies readonly z.infer<typeof CaseStatus>[];

type OpenCaseStatus = (typeof OPEN_CASE_STATUSES)[number];
type TerminalCaseStatus = (typeof TERMINAL_CASE_STATUSES)[number];

/** Compile-time only: every status is classified, and none is classified twice. */
type Assert<T extends true> = T;
type _StatusPartitionCovers = Assert<
  [Exclude<z.infer<typeof CaseStatus>, OpenCaseStatus | TerminalCaseStatus>] extends [never]
    ? true
    : false
>;
type _StatusPartitionDisjoint = Assert<
  [Extract<OpenCaseStatus, TerminalCaseStatus>] extends [never] ? true : false
>;

export const PreauthType = z.enum(["treatment", "perio", "manual"]);
export const PreauthStatus = z.enum([
  "pending",
  "submitted",
  "in_review",
  "approved",
  "denied",
  "appealing",
  "expired",
]);

export const CommunicationStatus = z.enum(["sent", "stubbed", "error"]);
export const EmailTemplateCategory = z.enum([
  "consult_confirmation",
  "consult_followup",
  "financing_followup",
  "preauth_approved",
  "unscheduled_treatment",
  "treatment_presentation",
  "general",
]);

export const PerioStatus = z.enum([
  "healthy",
  "gingivitis",
  "early_perio",
  "moderate_perio",
  "advanced_perio",
  "unknown",
]);
export const RecallType = z.enum(["prophy", "perio_maint", "srp_needed", "d4346", "fmd", "none"]);
export const Radiograph = z.enum(["BWX", "PANO", "FMX", "PA", "none"]);
export const PatientInterestLevel = z.enum(["hot", "warm", "cold", "unknown"]);

// ── Case aggregate ───────────────────────────────────────────────────────────

export const TcCaseItem = z.object({
  itemId: Uuid,
  legacyItemId: z.string().max(60).nullable(),
  odProcNum: z.number().int().positive().nullable(),
  position: z.number().int().min(0),
  tooth: ShortText,
  procedureName: ShortText.min(1),
  patientDescription: LongText,
  feeCents: Cents,
  insuranceEstCents: Cents,
  patientPortionCents: Cents,
  urgency: Urgency,
  timeEstimate: ShortText,
  benefits: z.array(ShortText).max(20),
  risksOfDelay: z.array(ShortText).max(20),
  expectedOutcome: LongText,
});
export type TcCaseItem = z.infer<typeof TcCaseItem>;

export const TcCasePhase = z.object({
  phaseId: Uuid,
  position: z.number().int().min(0),
  name: ShortText.min(1),
  description: LongText,
  items: z.array(TcCaseItem).max(100),
});
export type TcCasePhase = z.infer<typeof TcCasePhase>;

export const TcObjection = z.object({
  objectionId: Uuid,
  category: ShortText.min(1),
  note: LongText,
  patientWords: LongText, // PHI — verbatim patient speech
  loggedAt: IsoTimestamp,
});
export type TcObjection = z.infer<typeof TcObjection>;

/**
 * THE unified outreach item. Replaces legacy followUps[] (no ids, boolean
 * completed), followUpSteps[] (current system) and nurtureTouchpoints[]
 * (campaign outreach): one queue, discriminated by `kind`.
 */
export const TcFollowup = z.object({
  followupId: Uuid,
  legacyId: z.string().max(60).nullable(),
  kind: FollowupKind,
  dueDate: IsoDate,
  channel: FollowupChannel,
  status: FollowupStatus,
  talkingPoint: LongText, // suggestedTalkingPoint | legacy note | nurture scriptTemplate
  outcomeNote: LongText,
  completedAt: IsoTimestamp.nullable(),
  completedBy: ShortText.nullable(), // nurture: TC name or 'system'
  source: FollowupSource,
  patientResponded: z.boolean().nullable(), // null = not recorded
  nurtureType: NurtureType.nullable(), // present iff kind === 'nurture'
});
export type TcFollowup = z.infer<typeof TcFollowup>;

/** Structured payload for contact_attempt events (legacy contactAttempts[]). */
export const ContactAttemptDetail = z.object({
  channel: z.enum(["call", "text", "email"]),
  outcome: z.enum(["reached", "voicemail", "no_answer"]),
});
export type ContactAttemptDetail = z.infer<typeof ContactAttemptDetail>;

/**
 * Structured payload for voice_handoff events — the SNAPSHOT, not a reference.
 *
 * `callSummary` is a copy of the voice module's summary text at handoff time;
 * `callUrl` is a deep link that MAY 404 once the voice side prunes the call
 * row (accepted — the summary above it is what carries the meaning). The call
 * id itself lives on TcCaseEvent.sourceCallId, which is the indexed idempotency
 * key, so it is deliberately not duplicated in here.
 */
export const VoiceHandoffDetail = z.object({
  callUrl: z.string().max(500).nullable(),
  callSummary: LongText.nullable(),
  /** True if the handoff attached to an existing open case, false if it created one. */
  attached: z.boolean(),
});
export type VoiceHandoffDetail = z.infer<typeof VoiceHandoffDetail>;

/**
 * Typed event payloads. A plain union, not a discriminated one: the discriminant
 * is the event's own `type`, and the two member shapes have no overlapping
 * required keys, so parse order is unambiguous. Narrow with the guards below.
 */
export const TcCaseEventDetail = z.union([ContactAttemptDetail, VoiceHandoffDetail]);
export type TcCaseEventDetail = z.infer<typeof TcCaseEventDetail>;

export function isContactAttemptDetail(
  detail: TcCaseEventDetail | null | undefined,
): detail is ContactAttemptDetail {
  return detail != null && "channel" in detail;
}

export function isVoiceHandoffDetail(
  detail: TcCaseEventDetail | null | undefined,
): detail is VoiceHandoffDetail {
  return detail != null && "attached" in detail;
}

export const TcCaseEvent = z.object({
  eventId: Uuid,
  legacyId: z.string().max(60).nullable(),
  ts: IsoTimestamp,
  type: CaseEventType,
  description: LongText,
  actor: ShortText.nullable(), // staff identity — never patient identity
  detail: TcCaseEventDetail.nullable(), // typed payload; contact_attempt + voice_handoff use it
  /**
   * Originating external call id for voice_handoff events, null on every other
   * type. Carries a UNIQUE (per tenant) guarantee in the schema — it is the
   * idempotency key that makes a repeated "Send to TC" a no-op instead of a
   * duplicate case. Defaulted so pre-existing construction sites stay valid.
   */
  sourceCallId: z.string().max(200).nullable().default(null),
});
export type TcCaseEvent = z.infer<typeof TcCaseEvent>;

export const TcHygieneIntake = z.object({
  /**
   * WHO WAS SIGNED IN. Audit identity, server-stamped from the SSO session —
   * never client-supplied, never edited.
   */
  submittedBy: ShortText.min(1),
  submittedByName: ShortText,
  /**
   * WHO ACTUALLY DID THE HYGIENE VISIT. Clinical attribution, chosen in the
   * intake form (Roles PR B).
   *
   * Separate from submittedBy on purpose. temp@carein.ai is one deliberately
   * shared, rotated account for temp hygienists, so `submittedBy` collapses
   * every temp's work into a single identity — useless for "show me Raegan's
   * handoffs" and worse than useless for a clinical question about a specific
   * visit. This field carries the name the person picked.
   *
   * A NAME SNAPSHOT, not a reference: it is the name as of the visit and does
   * not follow a later roster change, matching how this codebase snapshots
   * patient and provider names elsewhere.
   *
   * Defaulted to '' so every pre-PR-B construction site stays valid; the
   * migration backfills existing rows from submittedByName.
   */
  hygienistName: ShortText.default(""),
  submittedAt: IsoTimestamp,
  operatory: ShortText,
  visitDate: IsoDate.nullable(),
  providerSeen: ShortText,
  chiefConcern: LongText,
  perioStatus: PerioStatus,
  recallType: RecallType,
  radiographs: z.array(Radiograph).max(10),
  intraoralPhotosTaken: z.boolean(),
  areasOfConcern: LongText,
  suspectedTreatment: LongText,
  hygienistRecommendation: LongText,
  insuranceNoted: LongText,
  patientInterestLevel: PatientInterestLevel,
  flagUrgent: z.boolean(),
});
export type TcHygieneIntake = z.infer<typeof TcHygieneIntake>;

export const TcCase = z.object({
  caseId: Uuid,
  legacyId: z.string().max(60).nullable(),
  officeId: OfficeId,

  // Patient identity (PHI).
  patientName: ShortText.min(1),
  patientAge: z.number().int().min(0).max(130).nullable(),
  phone: ShortText.nullable(),
  email: ShortText.nullable(), // legacy data holds '' and non-emails; not z.email() by design
  odPatientId: z.number().int().positive().nullable(),

  // Classification.
  caseType: ShortText,
  category: CaseCategory,
  status: CaseStatus,
  urgency: Urgency,
  doctorName: ShortText, // display text (legacy free-text doctor)
  /**
   * Identity of the doctor selected at case entry (hygiene handoff or TC case
   * creation) — same identity convention as assignedTc / tc_legacy_user_map.
   * Null on imported legacy cases (legacy only had free-text doctorName).
   */
  diagnosingProvider: ShortText.nullable(),
  assignedTc: ShortText, // legacy slug/name; platform identity via tc_legacy_user_map

  // Value / readiness.
  caseValueCents: Cents,
  readinessScore: z.number().int().min(0).max(100),
  financingStatus: ShortText,
  preferredFinancingProvider: ShortText.nullable(),

  // Discovery / context (PHI).
  decisionMakers: ShortText,
  financialSituation: z.array(ShortText).max(20),
  keyMotivators: z.array(ShortText).max(20),
  contactPreference: ContactPreference.nullable(),
  bestTimeToReach: ShortText,
  notes: LongText,
  referralSource: ReferralSource.nullable(),
  lostReason: LostReason.nullable(),

  // Lifecycle.
  diagnosedDate: IsoDate.nullable(),
  statusChangedAt: IsoTimestamp.nullable(),

  // Nurture scalars (touchpoints are TcFollowup kind='nurture').
  nurtureCadence: NurtureCadence,
  inLongTailMode: z.boolean(),
  nurtureEnrolledAt: IsoTimestamp.nullable(),
  nurturePhaseChangedAt: IsoTimestamp.nullable(),
  nurturePhase1DaysOverride: z.number().int().min(0).max(365).nullable(),
  nurturePhase2DaysOverride: z.number().int().min(0).max(365).nullable(),
  nurtureUnsubscribed: z.boolean(),

  // Children.
  phases: z.array(TcCasePhase).max(20),
  objections: z.array(TcObjection).max(200),
  followups: z.array(TcFollowup).max(500),
  events: z.array(TcCaseEvent).max(2000),
  hygieneIntake: TcHygieneIntake.nullable(),
});
export type TcCase = z.infer<typeof TcCase>;

// ── Pre-auth ────────────────────────────────────────────────────────────────

export const TcPreauthCase = z.object({
  preauthId: Uuid,
  legacyId: z.string().max(60).nullable(),
  officeId: OfficeId,
  caseId: Uuid.nullable(),
  patientName: ShortText.min(1),
  phone: ShortText.nullable(),
  email: ShortText.nullable(),
  odPatientId: z.number().int().positive().nullable(),
  preauthType: PreauthType,
  description: LongText,
  insuranceCarrier: ShortText,
  status: PreauthStatus,
  doctorName: ShortText,
  createdAt: IsoTimestamp,
  submittedDate: IsoDate.nullable(),
  decisionDate: IsoDate.nullable(),
  referenceNumber: ShortText,
  notes: LongText,
});
export type TcPreauthCase = z.infer<typeof TcPreauthCase>;

// ── Email templates + communications ────────────────────────────────────────

export const TcEmailTemplate = z.object({
  templateId: Uuid,
  legacyId: z.string().max(60).nullable(),
  officeId: OfficeId,
  name: ShortText.min(1),
  category: EmailTemplateCategory,
  subject: z.string().min(1).max(160),
  preheader: z.string().max(160),
  blocks: EmailBlocks,
  isSeed: z.boolean(),
});
export type TcEmailTemplate = z.infer<typeof TcEmailTemplate>;

export const TcCommunication = z.object({
  commId: Uuid,
  legacyId: z.string().max(60).nullable(),
  officeId: OfficeId,
  caseId: Uuid.nullable(),
  templateId: Uuid.nullable(),
  templateName: ShortText,
  sender: ShortText.min(1), // legacy user slug; platform identity via tc_legacy_user_map
  senderName: ShortText,
  toEmail: ShortText.min(1), // PHI
  subject: ShortText, // PHI
  status: CommunicationStatus,
  providerMessageId: z.string().max(200).nullable(),
  error: z.string().max(2000).nullable(),
  sentAt: IsoTimestamp,
});
export type TcCommunication = z.infer<typeof TcCommunication>;

// ── Gallery + smile simulations (blob KEYS only — bytes live in Azure Blob) ─

export const TcGalleryCase = z.object({
  galleryId: Uuid,
  legacyId: z.string().max(60).nullable(),
  officeId: OfficeId,
  title: ShortText.min(1), // PHI — legacy titles embed patient names
  category: ShortText,
  description: LongText,
  doctorName: ShortText,
  beforeBlobKey: ShortText.min(1),
  afterBlobKey: ShortText.min(1),
  createdAt: IsoTimestamp,
});
export type TcGalleryCase = z.infer<typeof TcGalleryCase>;

export const TcSmileSimulation = z.object({
  simId: Uuid,
  legacyId: z.string().max(60).nullable(),
  officeId: OfficeId,
  caseId: Uuid.nullable(),
  treatmentType: ShortText.min(1), // open vocabulary — Beau adds types without migrations
  prompt: LongText,
  originalBlobKey: ShortText.min(1), // PHI by reference (face photo)
  resultBlobKey: ShortText.min(1),
  savedToGallery: z.boolean(),
  galleryId: Uuid.nullable(),
  createdBy: ShortText,
  createdAt: IsoTimestamp,
});
export type TcSmileSimulation = z.infer<typeof TcSmileSimulation>;

// ── Library config (server-owned, per office) ───────────────────────────────
// One schema per section; tc_library_config.value is validated by the section
// schema on write. financing_settings absorbs the legacy per-browser
// localStorage FinancingSettings — server truth from Slice 3 on.

export const LibraryStage = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(40),
  color: z.string().min(1).max(64),
  slaWarnDays: z.number().int().min(0).max(365),
  slaCriticalDays: z.number().int().min(0).max(365),
  order: z.number().int().min(0),
  system: z.boolean(),
});

export const LibraryTag = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  color: z.string().max(64).nullable(),
  archived: z.boolean(),
});

export const LibraryObjection = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  script: LongText,
  suggestedFollowUpDays: z.number().int().min(0).max(90),
});

export const LibraryTreatmentCategory = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  defaultFinancingProviderKey: z.string().max(60).nullable(),
});

export const LibraryFinancingProvider = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  logo: z.string().max(8),
  color: z.string().min(1).max(64),
  description: LongText,
  terms: z.array(z.number().int().min(1).max(120)).max(20),
  promoTerms: z.array(z.number().int().min(1).max(120)).max(20),
  minAmountCents: Cents,
  promoApr: z.number().min(0).max(100),
  regularApr: z.number().min(0).max(100),
  enabled: z.boolean(),
});

export const LibraryCrownPricing = z.object({
  economyCents: Cents,
  standardCents: Cents,
  premiumCents: Cents,
  implantCents: Cents,
});

export const LibraryFinancingConfig = z.object({
  serviceFeeEnabled: z.boolean(),
  serviceFeePercent: z.number().min(0).max(15),
  /**
   * Pay-in-full cash discount — server truth for the legacy hardcoded "5%
   * cash discount" (Slice 4 honesty-debt fix). Defaults keep pre-existing
   * stored sections parseable: disabled until an office turns it on.
   */
  cashDiscountEnabled: z.boolean().default(false),
  cashDiscountPercent: z.number().min(0).max(50).default(5),
});
export type LibraryFinancingConfig = z.infer<typeof LibraryFinancingConfig>;

export const LibraryCadenceTier = z.object({
  key: NurtureCadence,
  label: z.string().min(1).max(40),
  intervals: z.array(z.number().int().min(0).max(365)).min(1).max(12),
});

export const LibraryCadenceConfig = z.object({
  tiers: z.array(LibraryCadenceTier).length(3),
  thresholds: z.object({
    standardMinCents: Cents,
    highTouchMinCents: Cents,
  }),
  highUrgencyFirstDay: z.number().int().min(0).max(30),
  spouseFamilyMinFirstDay: z.number().int().min(0).max(30),
});

/** Absorbs the legacy per-browser localStorage FinancingSettings. */
export const LibraryFinancingSettings = z.object({
  enabledProviders: z.record(z.string().max(60), z.boolean()),
  serviceFeeEnabled: z.boolean(),
  serviceFeePercent: z.number().min(0).max(15),
  providerOverrides: z.record(
    z.string().max(60),
    z.object({
      promoEnabled: z.boolean(),
      promoApr: z.number().min(0).max(100),
      regularApr: z.number().min(0).max(100),
    }),
  ),
});

export const LibrarySectionSchemas = {
  stages: z.array(LibraryStage).max(50),
  objections: z.array(LibraryObjection).max(100),
  motivators: z.array(LibraryTag).max(100),
  lost_reasons: z.array(LibraryTag).max(100),
  referral_sources: z.array(LibraryTag).max(100),
  treatment_categories: z.array(LibraryTreatmentCategory).max(100),
  financing_providers: z.array(LibraryFinancingProvider).max(50),
  crown_pricing: LibraryCrownPricing,
  financing_config: LibraryFinancingConfig,
  cadence_config: LibraryCadenceConfig,
  financing_settings: LibraryFinancingSettings,
} as const;
export type LibrarySection = keyof typeof LibrarySectionSchemas;

// ── Legacy user map ─────────────────────────────────────────────────────────

export const TcLegacyUserMapEntry = z.object({
  legacyUserId: z.string().min(1).max(40),
  platformEmail: z.string().email(),
  displayName: ShortText,
  legacyRole: ShortText,
});
export type TcLegacyUserMapEntry = z.infer<typeof TcLegacyUserMapEntry>;
