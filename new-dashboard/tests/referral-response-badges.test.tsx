/**
 * Referral response badges: the responses we collect, shown on the hub's
 * cards and the case / checkout surfaces without opening the detail.
 *
 *   1. referralResponses(events): per event combination — none, staff mark,
 *      link mark, legacy (no-verb) rows, a re-send starting clean, each
 *      patient-email outcome, the latest one winning.
 *   2. referralResponseBadges(r): the two badges and the quiet line.
 *   3. referralChipFor: the REAL status past approval (the logged nit: sent
 *      and beyond used to read "Approved").
 *   4. The surfaces render them: HubCard, the case row, the checkout chip.
 *
 * No PHI: the patients are the synthetic fixtures.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const ref = vi.hoisted(() => ({
  getReferralsStatus: vi.fn(),
  listReferrals: vi.fn(),
  listDirectory: vi.fn(),
  listReferralAttachments: vi.fn(),
}));
vi.mock("@/features/tc/referrals/referralsApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/referrals/referralsApi")>();
  return { ...real, ...ref };
});

import {
  REFERRAL_LINK_ACTORS,
  TC_REFERRAL_CHIP_LABELS,
  TcReferral as TcReferralSchema,
  referralChipFor,
  referralResponseBadges,
  referralResponses,
  type TcReferral,
  type TcReferralEvent,
  type TcReferralStatus,
} from "@shared/tc/referrals";
import { HubCard } from "@/pages/tc/TcReferralsHub";
import { ReferralsPanel } from "@/features/tc/referrals/ReferralsPanel";

let n = 0;
function ev(over: Partial<TcReferralEvent>): TcReferralEvent {
  n += 1;
  return {
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    fromStatus: "sent",
    toStatus: "sent",
    actor: "tc@carein.ai",
    at: `2026-10-20T15:${String(n % 60).padStart(2, "0")}:00.000Z`,
    note: "",
    verb: null,
    ...over,
  };
}

const SEND = () => ev({ fromStatus: "approved", toStatus: "sent", verb: "send" });
const ACK_LINK = () =>
  ev({ fromStatus: "sent", toStatus: "acknowledged", verb: "mark_acknowledged", actor: REFERRAL_LINK_ACTORS.specialist });
const ACK_STAFF = () => ev({ fromStatus: "sent", toStatus: "acknowledged", verb: "mark_acknowledged", actor: "tc@carein.ai" });
const MAIL_SENT = () => ev({ verb: "patient_email_sent", note: "Patient emailed at the address on file in Open Dental." });
const MAIL_SKIP = () =>
  ev({ verb: "patient_email_skipped", note: "Patient not emailed: the patient has no email on file in Open Dental." });
const MAIL_FAIL = () => ev({ verb: "patient_email_failed", note: "Patient email not sent: the email service refused it." });

describe("1: referralResponses, per event combination", () => {
  it("no events, or a send alone: nothing collected", () => {
    expect(referralResponses(undefined)).toEqual({ received: null, patientEmail: null });
    expect(referralResponses([SEND()])).toEqual({ received: null, patientEmail: null });
  });

  it("the specialist's link: received via link", () => {
    const ack = ACK_LINK();
    expect(referralResponses([SEND(), ack]).received).toEqual({ at: ack.at, via: "link" });
  });

  it("staff marked it: received via staff — also after a manual mark-sent", () => {
    expect(referralResponses([SEND(), ACK_STAFF()]).received?.via).toBe("staff");
    expect(
      referralResponses([ev({ fromStatus: "approved", toStatus: "sent", verb: "mark_sent" }), ACK_STAFF()]).received?.via,
    ).toBe("staff");
  });

  it("rows written before R6 (no verb): a sent → acknowledged move is the receipt", () => {
    const legacy = [ev({ fromStatus: "approved", toStatus: "sent" }), ev({ fromStatus: "sent", toStatus: "acknowledged" })];
    expect(referralResponses(legacy).received?.via).toBe("staff");
  });

  it("a later re-send starts clean: the earlier receipt and patient email no longer count", () => {
    const r = referralResponses([SEND(), MAIL_SENT(), ACK_LINK(), ev({ fromStatus: "acknowledged", toStatus: "approved", verb: "reopen" }), SEND()]);
    expect(r).toEqual({ received: null, patientEmail: null });
  });

  it("each patient-email outcome, with the history's own note", () => {
    expect(referralResponses([SEND(), MAIL_SENT()]).patientEmail?.status).toBe("sent");
    expect(referralResponses([SEND(), MAIL_SKIP()]).patientEmail).toMatchObject({
      status: "skipped",
      note: "Patient not emailed: the patient has no email on file in Open Dental.",
    });
    expect(referralResponses([SEND(), MAIL_FAIL()]).patientEmail?.status).toBe("failed");
  });

  it("the latest patient-email outcome wins, and receipt and email are independent", () => {
    const r = referralResponses([SEND(), MAIL_FAIL(), MAIL_SENT(), ACK_LINK()]);
    expect(r.patientEmail?.status).toBe("sent");
    expect(r.received?.via).toBe("link");
  });

  it("a patient_scheduled event alone is not a receipt (the date rides scheduledDate)", () => {
    expect(referralResponses([SEND(), ev({ verb: "patient_scheduled", actor: REFERRAL_LINK_ACTORS.patient })]).received).toBeNull();
  });
});

describe("2: referralResponseBadges", () => {
  it("nothing collected: no badges, no line", () => {
    expect(referralResponseBadges({})).toEqual({ received: null, receivedTitle: null, scheduled: null, patientEmail: null });
  });

  it("received via link / via staff — same badge, a different title", () => {
    const link = referralResponseBadges({ received: { at: "x", via: "link" } });
    const staff = referralResponseBadges({ received: { at: "x", via: "staff" } });
    expect([link.received, staff.received]).toEqual(["Received", "Received"]);
    expect(link.receivedTitle).toMatch(/email link/);
    expect(staff.receivedTitle).toMatch(/staff/);
  });

  it("a scheduled date, whoever gave it: 'Patient scheduled <date>'", () => {
    expect(referralResponseBadges({ scheduledDate: "2026-11-03" }).scheduled).toBe("Patient scheduled Tue, Nov 3, 2026");
  });

  it("the quiet line: 'Patient emailed.' when sent; the note itself when skipped or failed", () => {
    expect(referralResponseBadges({ patientEmail: { status: "sent", note: "long note", at: "x" } }).patientEmail).toBe(
      "Patient emailed.",
    );
    expect(
      referralResponseBadges({
        patientEmail: { status: "skipped", note: "Patient not emailed: patient email is off for this office.", at: "x" },
      }).patientEmail,
    ).toBe("Patient not emailed: patient email is off for this office.");
  });

  it("all three together", () => {
    const b = referralResponseBadges({
      received: { at: "x", via: "link" },
      scheduledDate: "2026-11-03",
      patientEmail: { status: "sent", note: "", at: "x" },
    });
    expect([b.received, b.scheduled, b.patientEmail]).toEqual(["Received", "Patient scheduled Tue, Nov 3, 2026", "Patient emailed."]);
  });
});

describe("3: the chip names the real status", () => {
  const one = (status: TcReferralStatus) => [{ status, createdAt: "2026-10-20T15:00:00.000Z" }];
  it.each([
    ["draft", "Staged"],
    ["pending_signoff", "Pending Dr. sign-off"],
    ["approved", "Approved"],
    ["sent", "Sent"],
    ["acknowledged", "Acknowledged"],
    ["patient_seen", "Patient seen"],
    ["closed", "Closed"],
    ["declined", "Declined"],
  ] as const)("%s → %s", (status, label) => {
    expect(TC_REFERRAL_CHIP_LABELS[referralChipFor(one(status))]).toBe(label);
  });

  it("cancelled ones are ignored and the newest live one wins", () => {
    expect(referralChipFor(one("cancelled"))).toBe("none");
    expect(
      referralChipFor([
        { status: "sent", createdAt: "2026-10-21T15:00:00.000Z" },
        { status: "draft", createdAt: "2026-10-20T15:00:00.000Z" },
        { status: "cancelled", createdAt: "2026-10-22T15:00:00.000Z" },
      ]),
    ).toBe("sent");
  });
});

// ── 4: the surfaces ─────────────────────────────────────────────────────────

const CASE_ID = "1b1c2d3e-4f50-4a61-8b72-938495a6b7c8";

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return TcReferralSchema.parse({
    referralId: "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: CASE_ID,
    sourceKind: "case",
    sourceRef: CASE_ID,
    referringProvider: "DOC1",
    directoryEntryId: null,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "",
    status: "sent",
    statusChangedAt: "2026-10-20T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-20T14:00:00.000Z",
    updatedAt: "2026-10-20T15:00:00.000Z",
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listDirectory.mockResolvedValue([]);
  ref.listReferralAttachments.mockResolvedValue([]);
});
afterEach(cleanup);

describe("4: HubCard shows the responses without opening the drawer", () => {
  const NOW = new Date("2026-10-22T15:00:00.000Z");

  it("received + scheduled badges, and the patient-email outcome as a quiet line", () => {
    render(
      <HubCard
        referral={referral({
          // Past "acknowledged" (on an acknowledged card the age line already
          // says so, and "Received" is not repeated — sign-off-in-hub fold-in).
          status: "patient_seen",
          received: { at: "2026-10-21T15:00:00.000Z", via: "link" },
          scheduledDate: "2026-11-03",
          patientEmail: { status: "skipped", note: "Patient not emailed: the patient has no email on file in Open Dental.", at: "x" },
        })}
        now={NOW}
        onOpen={() => {}}
      />,
    );
    const card = screen.getByTestId("tc-hub-card");
    expect(within(card).getByTestId("referral-response-received").textContent).toBe("Received");
    expect(within(card).getByTestId("referral-response-received").getAttribute("title")).toMatch(/email link/);
    expect(within(card).getByTestId("referral-response-scheduled").textContent).toBe("Patient scheduled Tue, Nov 3, 2026");
    const line = within(card).getByTestId("referral-response-patient-email");
    expect(line.textContent).toBe("Patient not emailed: the patient has no email on file in Open Dental.");
    // Quiet: a line, not a badge.
    expect(line.tagName).toBe("P");
  });

  it("nothing collected: no badges, no line", () => {
    render(<HubCard referral={referral()} now={NOW} onOpen={() => {}} />);
    expect(screen.queryByTestId("referral-response-received")).toBeNull();
    expect(screen.queryByTestId("referral-response-scheduled")).toBeNull();
    expect(screen.queryByTestId("referral-response-patient-email")).toBeNull();
  });

  it("a scheduled date with no receipt (the patient's own button): only the scheduled badge", () => {
    render(<HubCard referral={referral({ scheduledDate: "2026-11-03" })} now={NOW} onOpen={() => {}} />);
    expect(screen.queryByTestId("referral-response-received")).toBeNull();
    expect(screen.getByTestId("referral-response-scheduled")).toBeTruthy();
  });
});

describe("4: the checkout chip and the case rows", () => {
  it("checkout: the chip says Sent (not Approved), with the scheduled badge beside it", async () => {
    ref.listReferrals.mockResolvedValue([referral({ status: "sent", scheduledDate: "2026-11-03" })]);
    render(<ReferralsPanel office="roland" source={{ handoffId: CASE_ID }} compact />);
    await waitFor(() => expect(screen.getByTestId("checkout-referral-chip").textContent).toBe("Sent"));
    expect(screen.getByTestId("referral-response-scheduled").textContent).toBe("Patient scheduled Tue, Nov 3, 2026");
  });

  it("checkout: an acknowledged referral says Acknowledged — no second 'Received' badge", async () => {
    ref.listReferrals.mockResolvedValue([referral({ status: "acknowledged", received: { at: "x", via: "link" } })]);
    render(<ReferralsPanel office="roland" source={{ handoffId: CASE_ID }} compact />);
    await waitFor(() => expect(screen.getByTestId("checkout-referral-chip").textContent).toBe("Acknowledged"));
    expect(screen.queryByTestId("referral-response-received")).toBeNull();
  });

  it("case: a patient_seen row still says it was received, and the patient-email line", async () => {
    ref.listReferrals.mockResolvedValue([
      referral({
        status: "patient_seen",
        received: { at: "x", via: "staff" },
        patientEmail: { status: "sent", note: "", at: "x" },
      }),
    ]);
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    const row = await screen.findByTestId("tc-referral-row");
    expect(within(row).getByTestId("referral-response-received").textContent).toBe("Received");
    expect(within(row).getByTestId("referral-response-patient-email").textContent).toBe("Patient emailed.");
  });
});
