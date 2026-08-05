/**
 * Post-consult outcome → mutation plan.
 *
 * planConsultOutcome is PURE: it turns the outcome form state into an ordered
 * list of mutation steps (objection log → status transition → follow-ups) with
 * no network, no clock, no randomness — `today` is always passed in. The tests
 * in tests/tc-consult.test.ts cover it exhaustively.
 *
 * executeConsultPlan then applies the steps SEQUENTIALLY through the TC API
 * (confirmed-save rule: each step awaits the server row). On a failure it
 * stops and reports exactly which step failed and which steps already
 * committed, so the page can surface partial failure honestly and keep the
 * form open.
 *
 * Platform adaptations vs legacy DentaFlow PostConsult:
 *  - accepted_phased maps to the platform's `partially_accepted` status when a
 *    subset of phases is kept (all phases → `accepted`). The contract has no
 *    per-phase accepted flag, so the kept-phase list is recorded in the
 *    transition note.
 *  - declined "other / not now" transitions to the platform's dedicated
 *    `nurture` status (legacy set lost+lostReason:"other"+nurture cadence).
 *    validateTransition allows any target except lost-without-reason, so
 *    presented → nurture is legal. Nurture touchpoint generation belongs to
 *    the nurture module, not this flow.
 *  - Follow-up cadence intervals come from the server library cadence_config
 *    section when present; the legacy hardcoded schedule is the fallback.
 */
import type { z } from "zod";
import type {
  ContactPreference,
  FollowupChannel,
  LibraryCadenceConfig,
  TcCase,
} from "@shared/tc/contract";
import type { CaseStatusId, LostReasonId, UrgencyId } from "../status";
import { validateTransition } from "../status";
import { getCadenceTier } from "../lib/followups";
import { addObjection, createFollowup, transitionCase, type TcQueueFollowup } from "../api";
import { objectionLabel } from "./objectionScripts";
import type { OfficeId } from "@shared/tc/contract";

export type ConsultOutcome =
  | "accepted_full"
  | "accepted_phased"
  | "thinking_objection"
  | "thinking_no_objection"
  | "declined";

type CadenceConfig = z.infer<typeof LibraryCadenceConfig>;
type ContactPreferenceId = z.infer<typeof ContactPreference>;
type FollowupChannelId = z.infer<typeof FollowupChannel>;

/** Legacy DEFAULT_CADENCE_CONFIG, dollars → cents. Fallback when the office
 *  has no cadence_config library section. */
export const DEFAULT_CADENCE: CadenceConfig = {
  tiers: [
    { key: "light", label: "Light (under $1k)", intervals: [2, 10, 21] },
    { key: "standard", label: "Standard ($1k–$5k)", intervals: [2, 7, 14, 28, 42] },
    { key: "high_touch", label: "High touch (over $5k)", intervals: [2, 5, 10, 17, 28, 42, 63, 90] },
  ],
  thresholds: { standardMinCents: 100_000, highTouchMinCents: 500_000 },
  highUrgencyFirstDay: 1,
  spouseFamilyMinFirstDay: 4,
};

/** Standard check-in offsets when the patient had no specific concern
 *  (legacy PostConsult copy: "first check-in in 5 days, then at 12 and 21"). */
export const NO_OBJECTION_OFFSETS: readonly number[] = [5, 12, 21];

// ── Inputs ──────────────────────────────────────────────────────────────────

/** The slice of TcCase the planner needs — tests build this directly. */
export interface ConsultCaseInfo {
  caseId: string;
  caseValueCents: number;
  urgency: UrgencyId;
  contactPreference: ContactPreferenceId | null;
  phases: { phaseId: string; name: string }[];
}

export function consultCaseInfo(c: TcCase): ConsultCaseInfo {
  return {
    caseId: c.caseId,
    caseValueCents: c.caseValueCents,
    urgency: c.urgency,
    contactPreference: c.contactPreference,
    phases: c.phases.map((p) => ({ phaseId: p.phaseId, name: p.name })),
  };
}

export interface ConsultInput {
  outcome: ConsultOutcome;
  tcCase: ConsultCaseInfo;
  /** Local YYYY-MM-DD — the planner never reads the clock. */
  today: string;
  /** Quick note (all outcomes; optional). */
  note: string;
  /** thinking_objection only. */
  objectionCategory: string | null;
  objectionWords: string;
  /** accepted_phased only — phaseIds the patient committed to. */
  acceptedPhaseIds: string[];
  /** declined only — platform LostReason id. */
  declineReason: LostReasonId | null;
  /** Server cadence_config library section; null → DEFAULT_CADENCE. */
  cadence: CadenceConfig | null;
}

// ── Plan shape ──────────────────────────────────────────────────────────────

export type ConsultStep =
  | { kind: "objection"; category: string; note: string; patientWords: string }
  | { kind: "transition"; status: CaseStatusId; lostReason: LostReasonId | null; note: string }
  | { kind: "followup"; dueDate: string; channel: FollowupChannelId; talkingPoint: string };

export type ConsultPlan =
  | {
      ok: true;
      steps: ConsultStep[];
      successMessage: string;
      /** Days until the first scheduled touch, when follow-ups were planned. */
      firstTouchDays: number | null;
    }
  | { ok: false; message: string };

// ── Date + channel helpers (pure) ───────────────────────────────────────────

/** YYYY-MM-DD + n days, UTC-safe (no DST drift). */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days);
  return new Date(t).toISOString().slice(0, 10);
}

/** Legacy resolveStepType: first touch is always a call; later touches follow
 *  the patient's contact preference, alternating call/text when unknown. */
export function channelForStep(
  contactPreference: ContactPreferenceId | null,
  stepIndex: number,
): FollowupChannelId {
  if (stepIndex === 0) return "phone_call";
  switch (contactPreference) {
    case "text":
      return "text";
    case "email":
      return "email";
    case "phone":
      return "phone_call";
    default:
      return stepIndex % 2 === 0 ? "phone_call" : "text";
  }
}

/**
 * Follow-up day offsets for a considering patient: library cadence tier by
 * case value, first interval compressed for high urgency (legacy 1 day) and
 * stretched for spouse_family (legacy 4 days — give the family conversation
 * time). Everything else lands on the tier's configured days (default first
 * touch: 2 days).
 */
export function cadenceOffsets(
  caseValueCents: number,
  urgency: UrgencyId,
  objectionCategory: string | null,
  cadence: CadenceConfig | null,
): number[] {
  const config = cadence ?? DEFAULT_CADENCE;
  const tier = getCadenceTier(caseValueCents, config.thresholds);
  const found = config.tiers.find((t) => t.key === tier) ??
    DEFAULT_CADENCE.tiers.find((t) => t.key === tier);
  const intervals = found ? [...found.intervals] : [];
  if (intervals.length === 0) return intervals;
  const first = intervals[0] ?? 0;
  if (urgency === "high") intervals[0] = Math.min(first, config.highUrgencyFirstDay);
  if (objectionCategory === "spouse_family") {
    intervals[0] = Math.max(intervals[0] ?? first, config.spouseFamilyMinFirstDay);
  }
  return intervals;
}

function followupSteps(
  offsets: readonly number[],
  input: Pick<ConsultInput, "today" | "tcCase">,
  talkingPointFor: (stepNumber: number) => string,
): ConsultStep[] {
  return offsets.map((dayOffset, idx) => ({
    kind: "followup" as const,
    dueDate: addDaysIso(input.today, dayOffset),
    channel: channelForStep(input.tcCase.contactPreference, idx),
    talkingPoint: talkingPointFor(idx + 1),
  }));
}

function joinNote(base: string, quickNote: string): string {
  const trimmed = quickNote.trim();
  return trimmed ? `${base} ${trimmed}` : base;
}

// ── The planner ─────────────────────────────────────────────────────────────

export function planConsultOutcome(input: ConsultInput): ConsultPlan {
  const { outcome, tcCase, note } = input;

  switch (outcome) {
    case "accepted_full": {
      return {
        ok: true,
        steps: [
          {
            kind: "transition",
            status: "accepted",
            lostReason: null,
            note: joinNote("Accepted the full plan at consult.", note),
          },
        ],
        successMessage: "Case accepted! Time to schedule.",
        firstTouchDays: null,
      };
    }

    case "accepted_phased": {
      const kept = tcCase.phases.filter((p) => input.acceptedPhaseIds.includes(p.phaseId));
      if (kept.length === 0) {
        return { ok: false, message: "Select at least one phase." };
      }
      const all = kept.length === tcCase.phases.length;
      const status: CaseStatusId = all ? "accepted" : "partially_accepted";
      const deferred = tcCase.phases.filter(
        (p) => !input.acceptedPhaseIds.includes(p.phaseId),
      );
      const base = all
        ? `Accepted all ${kept.length} phase${kept.length === 1 ? "" : "s"} at consult.`
        : `Accepted phase${kept.length === 1 ? "" : "s"} at consult: ${kept
            .map((p) => p.name)
            .join(", ")}. Deferred: ${deferred.map((p) => p.name).join(", ")}.`;
      return {
        ok: true,
        steps: [
          { kind: "transition", status, lostReason: null, note: joinNote(base, note) },
        ],
        successMessage: all
          ? "Full plan accepted!"
          : `${kept.length} phase${kept.length === 1 ? "" : "s"} accepted — deferred phases recorded on the case`,
        firstTouchDays: null,
      };
    }

    case "thinking_objection": {
      const category = input.objectionCategory;
      if (!category) {
        return { ok: false, message: "Select an objection category." };
      }
      const label = objectionLabel(category);
      const offsets = cadenceOffsets(
        tcCase.caseValueCents,
        tcCase.urgency,
        category,
        input.cadence,
      );
      const steps: ConsultStep[] = [
        {
          kind: "objection",
          category,
          note: note.trim() || input.objectionWords.trim(),
          patientWords: input.objectionWords.trim(),
        },
        {
          kind: "transition",
          status: "considering",
          lostReason: null,
          note: joinNote(`Thinking it over — objection: ${label}.`, note),
        },
        ...followupSteps(offsets, input, (n) =>
          n === 1
            ? `First check-in after consult — address "${label}".`
            : `Follow-up ${n} — continue working "${label}".`,
        ),
      ];
      return {
        ok: true,
        steps,
        successMessage: "Objection logged — follow-up cadence generated",
        firstTouchDays: offsets[0] ?? null,
      };
    }

    case "thinking_no_objection": {
      const steps: ConsultStep[] = [
        {
          kind: "transition",
          status: "considering",
          lostReason: null,
          note: joinNote("Thinking it over — no specific concern raised.", note),
        },
        ...followupSteps(NO_OBJECTION_OFFSETS, input, (n) =>
          n === 1
            ? "First check-in after consult — how are they feeling about the plan?"
            : `Check-in ${n} — keep the plan warm, ask what would help them decide.`,
        ),
      ];
      return {
        ok: true,
        steps,
        successMessage: "Follow-up cadence generated — first check-in in 5 days",
        firstTouchDays: NO_OBJECTION_OFFSETS[0] ?? null,
      };
    }

    case "declined": {
      const reason = input.declineReason;
      if (!reason) {
        return { ok: false, message: "Select what happened." };
      }
      if (reason === "other") {
        // "Not now — may return": the platform's nurture track, not lost.
        return {
          ok: true,
          steps: [
            {
              kind: "transition",
              status: "nurture",
              lostReason: null,
              note: joinNote("Not moving forward now — moved to the nurture track.", note),
            },
          ],
          successMessage: "Moved to nurture track — they won't be forgotten",
          firstTouchDays: null,
        };
      }
      const check = validateTransition("lost", reason);
      if (!check.ok) return { ok: false, message: check.message };
      return {
        ok: true,
        steps: [
          {
            kind: "transition",
            status: "lost",
            lostReason: reason,
            note: joinNote("Declined at consult.", note),
          },
        ],
        successMessage: "Case closed",
        firstTouchDays: null,
      };
    }
  }
}

// ── The executor ────────────────────────────────────────────────────────────

/** Human label for partial-failure toasts. */
export function consultStepLabel(step: ConsultStep): string {
  switch (step.kind) {
    case "objection":
      return "logging the objection";
    case "transition":
      return "updating the case status";
    case "followup":
      return `scheduling the follow-up due ${step.dueDate}`;
  }
}

export type ConsultExecResult =
  | { ok: true; case: TcCase | null; followups: TcQueueFollowup[] }
  | {
      ok: false;
      /** Index of the step that failed (steps before it committed). */
      failedIndex: number;
      failedLabel: string;
      completedCount: number;
      error: unknown;
    };

/**
 * Apply plan steps in order through the TC API. Each mutation awaits the
 * server's persisted row before the next starts (confirmed-save). Stops on
 * first failure — already-committed steps are reported, never rolled back
 * (the API has no transaction across these endpoints).
 */
export async function executeConsultPlan(
  office: OfficeId,
  caseId: string,
  steps: ConsultStep[],
): Promise<ConsultExecResult> {
  let updatedCase: TcCase | null = null;
  const followups: TcQueueFollowup[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    try {
      if (step.kind === "objection") {
        await addObjection(office, caseId, {
          category: step.category,
          note: step.note,
          patientWords: step.patientWords,
        });
      } else if (step.kind === "transition") {
        const res = await transitionCase(office, caseId, {
          status: step.status,
          lostReason: step.lostReason,
          note: step.note,
        });
        updatedCase = res.case;
      } else {
        followups.push(
          await createFollowup(office, {
            caseId,
            kind: "followup",
            dueDate: step.dueDate,
            channel: step.channel,
            talkingPoint: step.talkingPoint,
            source: "auto",
          }),
        );
      }
    } catch (error) {
      return {
        ok: false,
        failedIndex: i,
        failedLabel: consultStepLabel(step),
        completedCount: i,
        error,
      };
    }
  }
  return { ok: true, case: updatedCase, followups };
}
