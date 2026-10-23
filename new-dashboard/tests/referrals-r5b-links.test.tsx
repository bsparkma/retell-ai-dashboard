/**
 * Referrals R5b (closing the loop), the client side — pure pieces only:
 *
 *  - the four new history verbs have labels, and an acknowledgment made by the
 *    SPECIALIST'S LINK reads as such (not "outside the app");
 *  - the send toast says what happened to the patient's email, in the
 *    server's words;
 *  - the appointment date the link gave reads as a date;
 *  - the contract: the new verbs are non-moves (the return / send-problem
 *    readers see through them), scheduledDate parses, no new status.
 *
 * NO NETWORK, NO BACKEND, NO PHI (test patient 12827).
 */
import * as React from "react";
import { describe, expect, it } from "vitest";
import {
  REFERRAL_LINK_ACTORS,
  TC_REFERRAL_LINK_EVENT_VERBS,
  TcReferralSendOutcome,
  TcReferralStatus,
  referralLastReturn,
  referralLastSendProblem,
  type TcReferralEvent,
} from "@shared/tc/referrals";
import { REFERRAL_ACKNOWLEDGED_BY_LINK_LABEL, referralEventLabel } from "@/features/tc/referrals/ReferralTimeline";
import { scheduledDateLabel, sendOutcomeLine } from "@/pages/tc/TcReferralsHub";

(globalThis as Record<string, unknown>).React = React;

const ev = (over: Partial<TcReferralEvent>): TcReferralEvent => ({
  eventId: "00000000-0000-4000-8000-000000000001",
  fromStatus: "sent",
  toStatus: "sent",
  actor: "tc@carein.ai",
  at: "2026-10-22T15:00:00.000Z",
  note: "",
  verb: null,
  ...over,
});

describe("R5b history labels", () => {
  it("labels the four new verbs", () => {
    expect(referralEventLabel(ev({ verb: "patient_scheduled" }))).toBe("Patient scheduled with the specialist");
    expect(referralEventLabel(ev({ verb: "patient_email_sent" }))).toBe("Patient emailed");
    expect(referralEventLabel(ev({ verb: "patient_email_skipped" }))).toBe("Patient not emailed");
    expect(referralEventLabel(ev({ verb: "patient_email_failed" }))).toBe("Patient email not sent");
  });

  it("an acknowledgment from the specialist's link is not 'outside the app'; a person's still is", () => {
    const byLink = ev({ verb: "mark_acknowledged", toStatus: "acknowledged", actor: REFERRAL_LINK_ACTORS.specialist });
    expect(referralEventLabel(byLink)).toBe(REFERRAL_ACKNOWLEDGED_BY_LINK_LABEL);
    expect(referralEventLabel({ ...byLink, actor: "tc@carein.ai" })).toBe("Marked acknowledged by the specialist (outside the app)");
  });
});

describe("R5b send toast", () => {
  it("adds the patient email's sentence after the send's, and is unchanged without one", () => {
    const base = { status: "sent" as const, message: "Emailed to River Endodontics — no files attached.", code: null };
    expect(sendOutcomeLine(base)).toBe(base.message);
    const withPatient = TcReferralSendOutcome.parse({
      ...base,
      patientEmail: { status: "skipped", message: "The patient has no email on file, so no patient email was sent." },
    });
    expect(sendOutcomeLine(withPatient)).toBe(
      "Emailed to River Endodontics — no files attached. The patient has no email on file, so no patient email was sent.",
    );
  });
});

describe("R5b appointment date", () => {
  it("reads a YYYY-MM-DD as a date, without shifting a day", () => {
    expect(scheduledDateLabel("2026-11-03")).toBe("Tue, Nov 3, 2026");
    expect(scheduledDateLabel("not a date")).toBe("not a date");
  });
});

describe("R5b contract", () => {
  it("the new verbs move nothing: a return and a send problem are found through them", () => {
    const events = [
      ev({ verb: "return", fromStatus: "pending_signoff", toStatus: "draft", note: "Which tooth?" }),
      ...TC_REFERRAL_LINK_EVENT_VERBS.map((verb) => ev({ verb, fromStatus: "draft", toStatus: "draft" })),
    ];
    expect(referralLastReturn(events)?.note).toBe("Which tooth?");
    const failed = [ev({ verb: "approve", toStatus: "approved" }), ev({ verb: "send_failed", toStatus: "approved" }), ev({ verb: "patient_email_skipped", toStatus: "approved" })];
    expect(referralLastSendProblem(failed)?.kind).toBe("failed");
  });

  it("adds no referral status", () => {
    expect(TcReferralStatus.options).toHaveLength(9);
  });
});
