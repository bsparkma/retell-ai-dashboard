/**
 * Which lifecycle moves the Referrals hub's detail panel offers (R6.1).
 *
 * Pure. The shared transition table (referralNextStatus) decides what is
 * possible from a status; this only chooses which of those moves belong on the
 * hub and says, in a sentence, why any other one is not here. The server
 * re-checks everything at the click: the role gates, the CAS on the status, and
 * the table itself.
 *
 * The hub is the TC side (tc.full). The doctor's verbs — approve, decline,
 * send back — stay on Awaiting sign-off: approving can email the referral
 * (auto-send on approval), and nothing on the hub sends except its own Send
 * box. So for a referral awaiting sign-off the hub names where to act instead
 * of drawing those buttons.
 */
import {
  REFERRAL_MARK_LABELS,
  referralNextStatus,
  type TcReferralMoveVerb,
  type TcReferralStatus,
  type TcReferralVerb,
} from "@shared/tc/referrals";
import type { ReferralMark } from "./referralsApi";

/** The moves the hub itself performs, in the order the panel draws them. */
export const HUB_VERBS = [
  "submit",
  "withdraw",
  "reopen",
  "mark_sent",
  "mark_acknowledged",
  "mark_patient_seen",
  "close",
  "cancel",
] as const satisfies readonly TcReferralVerb[];
export type HubVerb = (typeof HUB_VERBS)[number];

/** The marks: a person recording what happened outside the app. */
export const HUB_MARK_VERBS: readonly ReferralMark[] = ["mark_sent", "mark_acknowledged", "mark_patient_seen", "close"];

export function isMarkVerb(verb: HubVerb): verb is ReferralMark {
  return (HUB_MARK_VERBS as readonly string[]).includes(verb);
}

/** The doctor's moves, which the hub points to rather than performs. */
const SIGNOFF_VERBS = ["approve", "decline", "return"] as const satisfies readonly TcReferralVerb[];

/** What the viewer holds, as far as the hub cares. UX only: the server decides. */
export interface HubViewer {
  /** tc.full: every hub move. */
  tcFull: boolean;
  /** tc.referral_signoff: may act on Awaiting sign-off. */
  signoff: boolean;
}

export interface HubAction {
  verb: HubVerb;
  /**
   * Where the move leads. null when that depends on an office policy this
   * page could not read (submit: sign-off required or not).
   */
  to: TcReferralStatus | null;
}

export interface HubActionPlan {
  actions: HubAction[];
  /** Why a move is not offered here, when one exists from this status. */
  notes: string[];
  /** Point to Awaiting sign-off (the viewer may act there). */
  signoffLink: boolean;
}

export const HUB_NOT_TC_FULL_COPY =
  "Only a treatment coordinator, office manager or admin can move a referral.";
export const HUB_SIGNOFF_HERE_COPY = "Approve, decline or send it back from Awaiting sign-off.";
export const HUB_SIGNOFF_WAITING_COPY = "Waiting for the doctor's sign-off.";

/** Where `verb` leads from `status`, or undefined when it is not a move from here. */
function target(status: TcReferralStatus, verb: TcReferralMoveVerb, signoffRequired: boolean | null): TcReferralStatus | null | undefined {
  const known = signoffRequired ?? true;
  const to = referralNextStatus(status, verb, { signoffRequired: known });
  if (to === null) return undefined;
  if (signoffRequired !== null) return to;
  const other = referralNextStatus(status, verb, { signoffRequired: !known });
  return other === to ? to : null;
}

/**
 * The plan for one referral. `signoffRequired` is the office's policy, or null
 * when it could not be read; it changes only where submit leads, never whether
 * it is offered.
 */
export function hubActionPlan(
  status: TcReferralStatus,
  viewer: HubViewer,
  signoffRequired: boolean | null,
): HubActionPlan {
  const possible: HubAction[] = [];
  for (const verb of HUB_VERBS) {
    const to = target(status, verb, signoffRequired);
    if (to !== undefined) possible.push({ verb, to });
  }
  const notes: string[] = [];
  const signoffPending = SIGNOFF_VERBS.some((v) => target(status, v, signoffRequired) !== undefined);
  if (signoffPending) notes.push(viewer.signoff ? HUB_SIGNOFF_HERE_COPY : HUB_SIGNOFF_WAITING_COPY);
  if (!viewer.tcFull) {
    if (possible.length > 0) notes.unshift(HUB_NOT_TC_FULL_COPY);
    return { actions: [], notes, signoffLink: signoffPending && viewer.signoff };
  }
  return { actions: possible, notes, signoffLink: signoffPending && viewer.signoff };
}

/** The button's words. Submit names where it goes when the policy is known. */
export function hubActionLabel(action: HubAction): string {
  switch (action.verb) {
    case "submit":
      if (action.to === "pending_signoff") return "Submit for sign-off";
      if (action.to === "approved") return "Submit (sign-off not required — approves it)";
      return "Submit";
    case "withdraw":
      return "Withdraw to edit";
    case "cancel":
      return "Cancel referral";
    case "reopen":
      return "Edit (re-approval needed)";
    default:
      return REFERRAL_MARK_LABELS[action.verb];
  }
}
