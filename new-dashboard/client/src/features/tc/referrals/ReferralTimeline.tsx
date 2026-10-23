/**
 * A referral's history, oldest first (queue item 56, R6) — every status move
 * and every edit, who, when, and the note. Rows written before R6 carry no
 * verb; they read by the status they moved to, as they always did.
 */
import {
  REFERRAL_LINK_ACTORS,
  TC_REFERRAL_STATUS_LABELS,
  type TcReferralEvent,
  type TcReferralEventVerb,
} from "@shared/tc/referrals";

export const REFERRAL_EVENT_LABELS: Record<TcReferralEventVerb, string> = {
  create: "Started",
  edit: "Edited",
  doctor_edit: "Edited by the doctor",
  submit: "Sent for the doctor's sign-off",
  withdraw: "Withdrawn to edit",
  cancel: "Cancelled",
  approve: "Approved",
  decline: "Declined",
  reopen: "Reopened — needs re-approval",
  return: "Returned by Dr.",
  mark_sent: "Marked sent (outside the app)",
  mark_acknowledged: "Marked acknowledged by the specialist (outside the app)",
  mark_patient_seen: "Marked patient seen by the specialist",
  close: "Closed",
  send: "Emailed to the specialist",
  send_failed: "Email not sent",
  send_conflict: "Emailed — but could not be marked sent",
  // R5b: from the links in the emails, and the patient's notice.
  patient_scheduled: "Patient scheduled with the specialist",
  patient_email_sent: "Patient emailed",
  patient_email_skipped: "Patient not emailed",
  patient_email_failed: "Patient email not sent",
};

/** R5b: the same move, when the specialist's link made it rather than a person. */
export const REFERRAL_ACKNOWLEDGED_BY_LINK_LABEL = "Specialist confirmed receipt (from the email link)";

/** One history line's label. Pure. */
export function referralEventLabel(e: TcReferralEvent): string {
  if (e.verb === "mark_acknowledged" && e.actor === REFERRAL_LINK_ACTORS.specialist) {
    return REFERRAL_ACKNOWLEDGED_BY_LINK_LABEL;
  }
  if (e.verb) return REFERRAL_EVENT_LABELS[e.verb];
  return TC_REFERRAL_STATUS_LABELS[e.toStatus];
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ReferralTimeline({ events }: { events: readonly TcReferralEvent[] | undefined }) {
  if (!events || events.length === 0) return null;
  return (
    <ol className="space-y-1.5 border-l border-border pl-3 text-xs" data-testid="referral-timeline">
      {events.map((e) => (
        <li key={e.eventId} className="relative">
          <span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-muted-foreground/50" aria-hidden />
          <span className="font-medium text-foreground">{referralEventLabel(e)}</span>
          <span className="text-muted-foreground">
            {" "}
            · {when(e.at)} · {e.actor}
          </span>
          {e.note && <p className="text-muted-foreground whitespace-pre-wrap">{e.note}</p>}
        </li>
      ))}
    </ol>
  );
}
