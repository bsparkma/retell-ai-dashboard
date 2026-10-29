/**
 * Which lifecycle moves the Referrals hub's detail panel offers (R6.1).
 *
 * Pure. The shared transition table (referralNextStatus) decides what is
 * possible from a status; this only chooses which of those moves belong on the
 * hub for the person looking, and says, in a sentence, why any other one is
 * not here. The server re-checks everything at the click: the role gates, the
 * CAS on the status, and the table itself.
 *
 * Two kinds of move:
 *  - the TC side's (tc.full): submit, withdraw, reopen, the marks, cancel;
 *  - the doctor's (tc.referral_signoff): approve, decline, send back.
 *
 * SIGN-OFF IN THE HUB (Beau's ruling, reversing R6.1's "approve is never
 * offered on the hub"): the doctor's moves are offered on the hub to a
 * tc.referral_signoff holder — and ONLY to one — on a referral awaiting
 * sign-off. They call the existing sign-off routes. Approving can email the
 * referral (auto-send on approval), so the panel asks first wherever that may
 * happen (see SignoffActions). Everyone else sees "Waiting for the doctor's
 * sign-off" and no doctor's move. Send and the marks are unchanged.
 */
import {
  REFERRAL_MARK_LABELS,
  referralCanLogCorrespondence,
  referralChartMilestones,
  referralNextStatus,
  type TcReferralEvent,
  type TcReferralMoveVerb,
  type TcReferralStatus,
  type TcReferralVerb,
} from "@shared/tc/referrals";
import type { OfficeId } from "@shared/tc/contract";
import type { ReferralMark } from "./referralsApi";

/** The TC side's moves on the hub, in the order the panel draws them. */
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

/** The doctor's moves — offered only to a tc.referral_signoff holder. */
export const HUB_SIGNOFF_VERBS = ["approve", "decline", "return"] as const satisfies readonly TcReferralVerb[];
export type HubSignoffVerb = (typeof HUB_SIGNOFF_VERBS)[number];

/** What the viewer holds, as far as the hub cares. UX only: the server decides. */
export interface HubViewer {
  /** tc.full: every TC-side hub move. */
  tcFull: boolean;
  /** tc.referral_signoff: approve, decline, send back. */
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
  /** The TC side's moves. */
  actions: HubAction[];
  /** The doctor's moves, in the order the panel draws them. */
  signoff: HubSignoffVerb[];
  /** Why a move is not offered here, when one exists from this status. */
  notes: string[];
}

export const HUB_NOT_TC_FULL_COPY =
  "Only a treatment coordinator, office manager or admin can move a referral.";
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
  const signoffPossible = HUB_SIGNOFF_VERBS.filter((v) => target(status, v, signoffRequired) !== undefined);
  const signoff = viewer.signoff ? signoffPossible : [];
  const notes: string[] = [];
  if (signoffPossible.length > 0 && !viewer.signoff) notes.push(HUB_SIGNOFF_WAITING_COPY);
  if (!viewer.tcFull) {
    // A signer with nothing else to do here needs no lecture about the TC's moves.
    if (possible.length > 0 && signoff.length === 0) notes.unshift(HUB_NOT_TC_FULL_COPY);
    return { actions: [], signoff, notes };
  }
  return { actions: possible, signoff, notes };
}

/**
 * R6.9a: the TC staff upload window — the server's rule (routes/tc/referrals.js
 * TC_STAFF_ATTACHABLE_STATUSES), mirrored for the UI only. The server decides.
 * Approved (not yet sent), closed, declined and cancelled stay shut.
 */
export const HUB_STAFF_ATTACHABLE_STATUSES: readonly TcReferralStatus[] = [
  "draft",
  "pending_signoff",
  "sent",
  "acknowledged",
  "patient_seen",
];

/**
 * R6.9a: is the standalone "Add files" box drawn? To a tc.full viewer (the
 * route is tc.full) once the referral went out — for the specialist's returned
 * report or fax. A draft or a referral awaiting sign-off takes files through
 * Edit, as before.
 */
export function hubCanAddFilesAfterSend(status: TcReferralStatus, viewer: HubViewer): boolean {
  return (
    viewer.tcFull &&
    HUB_STAFF_ATTACHABLE_STATUSES.includes(status) &&
    status !== "draft" &&
    status !== "pending_signoff"
  );
}

/**
 * R6.9: is "Log correspondence" offered? To a tc.full viewer (the route is
 * tc.full), on any status but a draft — the shared rule the server applies.
 * Not a move: it is outside the plan above and never changes the status.
 */
export function hubCanLogCorrespondence(status: TcReferralStatus, viewer: HubViewer): boolean {
  return viewer.tcFull && referralCanLogCorrespondence(status);
}

/**
 * R6.10: is the "Chart note" section drawn? To a tc.full viewer (the route is
 * tc.full) when the referral has reached at least one milestone — the shared
 * rule the server applies. Whether the office can take a note at all is the
 * section's own disabled state (TcReferral.chartNotes), not a reason to hide it.
 */
export function hubCanWriteChartNotes(events: readonly TcReferralEvent[] | undefined, viewer: HubViewer): boolean {
  return viewer.tcFull && referralChartMilestones(events).length > 0;
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

/**
 * The hub's sign-off view — where the doctor lands, where the sign-off alert
 * points, and where the old /tc/referrals/signoff path now redirects. With an
 * office and a referral it opens that one (the office is checked against the
 * viewer's scope there, never trusted).
 */
export function signoffViewHref(office?: OfficeId | null, referralId?: string | null): string {
  const q = new URLSearchParams({ view: "signoff" });
  if (office && referralId) {
    q.set("office", office);
    q.set("referral", referralId);
  }
  return `/tc/referrals?${q.toString()}`;
}
