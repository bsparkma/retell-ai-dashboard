/**
 * EL-2c fixtures: one patient email library campaign (Warm Follow-Up, Dental
 * Crown, Warm) for the roland test patient "Test 2, Stedi" (PatNum 12827).
 *
 * The ten emails in tc-nurture-crown-campaign.json are the library's OWN
 * composed text (backend renderLibraryEmail, default answers), merged with the
 * test patient's first name, the office's name, a 555-01xx phone and a
 * synthetic staff name, and planned by the real planner from Mon 2026-11-30.
 * No PHI.
 */
import emails from "./tc-nurture-crown-campaign.json";
import type { TcMessage } from "@shared/tc/messaging";
import type {
  NurtureCampaignEmail,
  NurtureCampaignResponse,
  NurtureOutboxResponse,
  TcNurtureEnrollment,
} from "@shared/tc/nurture";
import { renderEmail } from "@shared/tc/emailRender";

export const CASE_A = "11111111-1111-4111-8111-111111111111";
export const CASE_B = "66666666-6666-4666-8666-666666666666";
export const ENR_A = "22222222-2222-4222-8222-222222222222";
export const ENR_B = "77777777-7777-4777-8777-777777777777";

type Composed = { stage: string; label: string; subject: string; preheader: string; body: string; at: string };
export const COMPOSED = emails as Composed[];

export const STAGES = COMPOSED.map((e) => ({ id: e.stage, label: e.label, phase: "", use: "", inUse: true }));

const proc = (id: string, name: string, category: string) => ({ id, name, category, audience: "adult" });
const PROCEDURES = [proc("crown", "Dental Crown", "Restorative"), proc("implant", "Dental Implant", "Implants")];
export const CATALOG = {
  success: true,
  office: "roland",
  libraryVersion: "1.3.0",
  clinicallyApproved: true,
  status: "",
  rulesOfUse: [],
  procedures: PROCEDURES,
  allProcedures: PROCEDURES,
  stages: STAGES,
  variants: { A: "Warm and personal", B: "Short and direct", C: "Educational" },
  sequences: [],
  questions: [],
  emailCount: 0,
};

const uuid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

export function message(i: number, over: Partial<TcMessage> = {}): TcMessage {
  const e = COMPOSED[i];
  return {
    messageId: uuid(i + 1),
    officeId: "roland",
    caseId: CASE_A,
    direction: "outbound",
    channel: "email",
    toAddress: "stedi.test2@example.com",
    fromAddress: null,
    body: e.body,
    subject: e.subject,
    templateId: `library.crown.${e.stage}.A`,
    status: "draft",
    provider: null,
    providerMessageId: null,
    error: null,
    createdBy: "system:nurture",
    sentBy: null,
    createdAt: "2026-11-30T16:00:00.000Z",
    sentAt: null,
    emailTemplated: true,
    scheduledFor: e.at,
    approvedBy: null,
    approvedAt: null,
    skipReason: null,
    ...over,
  };
}

/** The ten emails, the first three approved by a synthetic TC. */
export function campaignEmails(overrides: Record<number, Partial<TcMessage>> = {}): NurtureCampaignEmail[] {
  return COMPOSED.map((e, i) => ({
    message: message(i, {
      ...(i < 3 ? { status: "scheduled", approvedBy: "tc@carein.ai", approvedAt: "2026-11-30T17:00:00.000Z" } : {}),
      ...(overrides[i] ?? {}),
    }),
    stage: e.stage,
    stepIndex: i,
    consentBlockedHint: null,
  }));
}

export function libraryEnrollment(over: Partial<TcNurtureEnrollment> = {}): TcNurtureEnrollment {
  return {
    enrollmentId: ENR_A,
    caseId: CASE_A,
    officeId: "roland",
    trackKey: "warm_followup",
    intensityAtEnroll: "standard",
    status: "active",
    stopReason: null,
    nextTouchIndex: 10,
    nextTouchDueAt: null,
    lastTouchAt: "2026-11-30T16:00:00.000Z",
    nextTouchKey: "tp_recap",
    touchCount: 10,
    createdBy: "tc@carein.ai",
    createdAt: "2026-11-30T16:00:00.000Z",
    updatedAt: "2026-11-30T17:00:00.000Z",
    libraryProcedureId: "crown",
    libraryVariant: "A",
    stepCount: 10,
    approvedCount: 3,
    sentCount: 0,
    skippedCount: 0,
    nextSendAt: COMPOSED[0].at,
    ...over,
  };
}

export function campaignResponse(over: Partial<NurtureCampaignResponse> = {}): NurtureCampaignResponse {
  return {
    enrollment: libraryEnrollment(),
    patientName: "Test 2, Stedi",
    emails: campaignEmails(),
    automaticSending: false,
    ...over,
  };
}

/** The server's renderer output for one composed email (what Show email displays). */
export function rendered(i: number) {
  const e = COMPOSED[i];
  return renderEmail({
    subject: e.subject,
    preheader: e.preheader,
    content: { kind: "text", body: e.body, literal: true },
    values: {},
    footer: {
      practiceName: "Roland Family Dental",
      practicePhone: "(918) 555-0100",
      unsubscribeUrl: null,
    },
  });
}

/** An outbox with two library campaigns (per case) and one hand-written text draft. */
export function outboxWithCampaigns(): NurtureOutboxResponse {
  const a = campaignEmails().slice(0);
  const b = COMPOSED.slice(0, 5).map((e, i) => ({
    message: message(i, {
      messageId: `44444444-4444-4444-8444-${String(i + 1).padStart(12, "0")}`,
      caseId: CASE_B,
      toAddress: "stedi.testb@example.com",
      templateId: `library.implant.${e.stage}.B`,
      scheduledFor: new Date(Date.parse(e.at) + 7 * 86400000).toISOString(),
    }),
    stage: e.stage,
    stepIndex: i,
    consentBlockedHint: null,
  }));
  return {
    enabled: true,
    channels: [
      { channel: "sms", enabled: true, reason: null },
      { channel: "email", enabled: true, reason: null },
    ],
    automaticSending: false,
    campaigns: [
      { enrollment: libraryEnrollment(), patientName: "Test 2, Stedi", needsApproval: 7, emails: a },
      {
        enrollment: libraryEnrollment({
          enrollmentId: ENR_B,
          caseId: CASE_B,
          trackKey: "large_case",
          libraryProcedureId: "implant",
          libraryVariant: "B",
          stepCount: 5,
          approvedCount: 0,
          nextSendAt: b[0].message.scheduledFor,
        }),
        patientName: "Test 2, Stedi",
        needsApproval: 5,
        emails: b,
      },
    ],
    groups: [
      {
        trackKey: "no_show_recovery",
        label: "No-Show Recovery",
        drafts: [
          {
            message: message(0, {
              messageId: "55555555-5555-4555-8555-555555555555",
              channel: "sms",
              toAddress: "+19185550142",
              subject: null,
              emailTemplated: false,
              templateId: "nurture.no_show_recovery.ns1",
              scheduledFor: null,
              body: "Hi Stedi, we missed you at Roland Family Dental! Life happens - reply here or call (918) 555-0100 and we'll find a time that works better. Reply STOP to opt out.",
            }),
            enrollmentId: "88888888-8888-4888-8888-888888888888",
            caseId: CASE_A,
            patientName: "Test 2, Stedi",
            touchKey: "ns1",
            consentBlockedHint: null,
          },
        ],
      },
    ],
  };
}
