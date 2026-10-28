/**
 * R6.10: referral chart notes.
 *
 *   1. The shared pieces: which history rows reach which milestone (and which
 *      chart note answers it); the drafted wording; the OD-safe text; the verb
 *      is a non-move; the request is strict.
 *   2. The timeline names the milestone and the Open Dental note number.
 *   3. Who sees the section, where: tc.full through the hub's routes, once a
 *      milestone is reached — never through sign-off, never to a doctor. An
 *      office that cannot take a note shows the button disabled with the
 *      server's named reason.
 *   4. Writing: the drafted note, edited; the FINAL text immediately above
 *      "Write to chart" is exactly what is sent; the read-back is shown; a
 *      refusal shows the server's sentence and nothing reads as written.
 *   5. NOTHING WRITES ON ITS OWN: opening, re-reading or a status change never
 *      calls the write; only the click does.
 *
 * No PHI: the patient is the synthetic Roland fixture (12827).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferral: vi.fn(),
    getSignoffReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    listDirectory: vi.fn(),
    editReferralFields: vi.fn(),
    reopenReferral: vi.fn(),
    markReferral: vi.fn(),
    referralVerb: vi.fn(),
    sendReferralEmail: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    returnReferral: vi.fn(),
    getReferralsStatus: vi.fn(),
    getReferralSettings: vi.fn(),
    listHub: vi.fn(),
    listReferrals: vi.fn(),
    logReferralCorrespondence: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    writeReferralChartNote: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { HubDetail } from "@/pages/tc/TcReferralsHub";
import { ReferralTimeline } from "@/features/tc/referrals/ReferralTimeline";
import { hubCanWriteChartNotes, type HubViewer } from "@/features/tc/referrals/hubActions";
import { CHART_NOTES_UNKNOWN_COPY, chartNoteFinalText } from "@/features/tc/referrals/ChartNotes";
import { TcApiError } from "@/features/tc/api";
import {
  TC_REFERRAL_ALL_EVENT_VERBS,
  TC_REFERRAL_CHART_MILESTONES,
  TC_REFERRAL_R69_EVENT_VERBS,
  TcReferral as TcReferralSchema,
  TcReferralChartNoteRequest,
  referralChartMilestones,
  referralChartNoteDraft,
  referralChartNoteOdSafe,
  referralLastReturn,
  referralLastSendProblem,
  type TcReferral,
  type TcReferralEvent,
} from "@shared/tc/referrals";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const CASE_ID = "1b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const TC: HubViewer = { tcFull: true, signoff: false };
const DOCTOR: HubViewer = { tcFull: false, signoff: true };

let n = 0;
function ev(over: Partial<TcReferralEvent>): TcReferralEvent {
  n += 1;
  return {
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    fromStatus: "sent",
    toStatus: "sent",
    actor: "tc@carein.ai",
    at: `2026-10-27T15:${String(n % 60).padStart(2, "0")}:00.000Z`,
    note: "",
    verb: null,
    ...over,
  };
}
const SENT = (over: Partial<TcReferralEvent> = {}) =>
  ev({ verb: "mark_sent", fromStatus: "approved", toStatus: "sent", note: "Sent outside the app: Faxed", ...over });
const ACK = () => ev({ verb: "mark_acknowledged", fromStatus: "sent", toStatus: "acknowledged" });
const WRITTEN = (milestone: "sent" | "received", commLogNum = 50001) =>
  ev({
    verb: "chart_note_written",
    note: "Referral sent to Dr. Example at River Endodontics for possible cracked tooth.",
    chartNote: { milestone, commLogNum, commType: 491 },
  });

const AVAILABLE = { available: true, code: null, reason: null };

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return TcReferralSchema.parse({
    referralId: RID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: CASE_ID,
    sourceKind: "case",
    sourceRef: CASE_ID,
    referringProvider: "",
    directoryEntryId: null,
    practiceName: "River Endodontics",
    specialistName: "Dr. Example",
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
    events: [SENT()],
    chartNotes: AVAILABLE,
    ...over,
  });
}

const DRAFT_SENT = "Referral sent to Dr. Example at River Endodontics for possible cracked tooth.";

beforeEach(() => {
  vi.clearAllMocks();
  ref.listReferralAttachments.mockResolvedValue([]);
  ref.listDirectory.mockResolvedValue([]);
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
});
afterEach(() => cleanup());

// ── 1: the shared pieces ────────────────────────────────────────────────────

describe("1: the shared pieces", () => {
  it("each milestone is reached by its own rows — the app's send or a mark, the link, the doctor — latest wins", () => {
    expect(referralChartMilestones(undefined)).toEqual([]);
    expect(referralChartMilestones([ev({ verb: "create", fromStatus: null, toStatus: "draft" })])).toEqual([]);
    const email = ev({ verb: "send", fromStatus: "approved", toStatus: "sent" });
    expect(referralChartMilestones([email]).map((m) => [m.milestone, m.at])).toEqual([["sent", email.at]]);
    const scheduled = ev({ verb: "patient_scheduled", toStatus: "acknowledged", fromStatus: "acknowledged" });
    const seen = ev({ verb: "mark_patient_seen", fromStatus: "acknowledged", toStatus: "patient_seen" });
    const closed = ev({ verb: "close", fromStatus: "patient_seen", toStatus: "closed", note: "Treatment complete" });
    const all = referralChartMilestones([SENT(), ACK(), scheduled, seen, closed]);
    expect(all.map((m) => m.milestone)).toEqual(["sent", "received", "scheduled", "seen", "closed"]);
    expect(all.find((m) => m.milestone === "closed")?.eventNote).toBe("Treatment complete");
    const declined = ev({ verb: "decline", fromStatus: "pending_signoff", toStatus: "declined", note: "Not needed yet" });
    expect(referralChartMilestones([declined]).map((m) => [m.milestone, m.eventNote])).toEqual([["declined", "Not needed yet"]]);
    // Pre-R6 rows carry no verb: the status move itself says so.
    expect(referralChartMilestones([ev({ verb: null, fromStatus: "approved", toStatus: "sent" })]).map((m) => m.milestone)).toEqual([
      "sent",
    ]);
    expect([...TC_REFERRAL_CHART_MILESTONES]).toEqual(["sent", "received", "scheduled", "seen", "declined", "closed"]);
  });

  it("a chart_note_written row answers its milestone: when, by whom, the note number, the exact words", () => {
    const w = WRITTEN("sent", 50007);
    const [sent, received] = referralChartMilestones([SENT(), ACK(), w]);
    expect(sent.written).toEqual({ at: w.at, actor: "tc@carein.ai", commLogNum: 50007, note: w.note });
    expect(received.written).toBeNull();
  });

  it("the drafts — the clinical reason, the specialist and practice, the date, the doctor's reason", () => {
    const facts = { practiceName: "River Endodontics", specialistName: "Dr. Example", specialty: "Endodontics", reason: "Possible cracked tooth." };
    expect(referralChartNoteDraft("sent", facts)).toBe(DRAFT_SENT);
    expect(referralChartNoteDraft("received", facts)).toBe(
      "Dr. Example at River Endodontics confirmed receipt of the referral for possible cracked tooth.",
    );
    expect(referralChartNoteDraft("scheduled", { ...facts, scheduledDate: "2026-11-03" })).toBe(
      "Patient scheduled with Dr. Example at River Endodontics on Tue, Nov 3, 2026.",
    );
    expect(referralChartNoteDraft("scheduled", { ...facts, scheduledDate: null })).toBe(
      "Patient scheduled with Dr. Example at River Endodontics (no date given).",
    );
    expect(referralChartNoteDraft("seen", facts)).toBe("Patient seen by Dr. Example at River Endodontics for possible cracked tooth.");
    expect(referralChartNoteDraft("declined", facts, "Not needed yet")).toBe(
      "Referral to Dr. Example at River Endodontics declined by the doctor: Not needed yet.",
    );
    expect(referralChartNoteDraft("closed", facts, "")).toBe("Referral to Dr. Example at River Endodontics closed.");
    // Fewer facts, still a sentence.
    expect(referralChartNoteDraft("sent", { practiceName: null, specialistName: null, specialty: "Endodontics", reason: "" })).toBe(
      "Referral sent to an endodontics specialist.",
    );
    expect(referralChartNoteDraft("sent", { practiceName: null, specialty: "", reason: "Implant consult" })).toBe(
      "Referral sent to the specialist for implant consult.",
    );
  });

  it("drafts and the final text are OD-safe: what is shown is what Open Dental stores", () => {
    expect(referralChartNoteOdSafe("O’Neil — “urgent”…")).toBe("O'Neil -- \"urgent\"...");
    expect(referralChartNoteDraft("sent", { practiceName: "O’Neil Oral Surgery", specialty: "", reason: "" })).toBe(
      "Referral sent to O'Neil Oral Surgery.",
    );
    expect(chartNoteFinalText("  Called — booked.  ")).toBe("Called -- booked.");
  });

  it("the verb is the last event verb and never a move: it hides no return and clears no failed send", () => {
    expect([...TC_REFERRAL_ALL_EVENT_VERBS]).toEqual([...TC_REFERRAL_R69_EVENT_VERBS, "chart_note_written"]);
    const ret = [ev({ verb: "return", fromStatus: "pending_signoff", toStatus: "draft", note: "Which tooth?" })];
    const chart = ev({ verb: "chart_note_written", chartNote: { milestone: "sent", commLogNum: 1, commType: 491 } });
    expect(referralLastReturn([...ret, chart])).toEqual(referralLastReturn(ret));
    const failed = [ev({ verb: "send_failed", fromStatus: "approved", toStatus: "approved", note: "ACS down" })];
    expect(referralLastSendProblem([...failed, chart])).toEqual(referralLastSendProblem(failed));
  });

  it("the request is strict: the milestone and the words, nothing else", () => {
    expect(TcReferralChartNoteRequest.safeParse({ milestone: "sent", note: "x" }).success).toBe(true);
    for (const extra of [{ patNum: 7115 }, { office: "valley" }, { commType: 486 }, { at: "2020-01-01" }]) {
      expect(TcReferralChartNoteRequest.safeParse({ milestone: "sent", note: "x", ...extra }).success).toBe(false);
    }
    expect(TcReferralChartNoteRequest.safeParse({ milestone: "cancelled", note: "x" }).success).toBe(false);
    expect(TcReferralChartNoteRequest.safeParse({ milestone: "sent", note: "   " }).success).toBe(false);
  });
});

// ── 2: the timeline ─────────────────────────────────────────────────────────

describe("2: the timeline", () => {
  it("names the milestone and the Open Dental note number, with the words written", () => {
    render(<ReferralTimeline events={[SENT(), WRITTEN("sent", 50001)]} />);
    const tl = screen.getByTestId("referral-timeline");
    expect(within(tl).getByText("Chart note written: Referral sent (Open Dental note 50001)")).toBeTruthy();
    expect(within(tl).getByText(/for possible cracked tooth\./)).toBeTruthy();
  });
});

// ── 3: who sees it, where ───────────────────────────────────────────────────

async function openDetail(detail: TcReferral, opts: { viewer?: HubViewer; reader?: "hub" | "signoff" } = {}) {
  ref.getReferral.mockResolvedValue(detail);
  ref.getSignoffReferral.mockResolvedValue(detail);
  const onChanged = vi.fn();
  const view = render(
    <HubDetail
      office="roland"
      referralId={detail.referralId}
      onClose={() => undefined}
      onChanged={onChanged}
      viewer={opts.viewer ?? TC}
      reader={opts.reader ?? "hub"}
      signoffRequired
    />,
  );
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByText("History");
  return { panel, onChanged, view };
}

describe("3: who sees the section, where", () => {
  it("tc.full, through the hub's routes, once a milestone is reached", async () => {
    expect(hubCanWriteChartNotes([SENT()], TC)).toBe(true);
    expect(hubCanWriteChartNotes([], TC)).toBe(false);
    expect(hubCanWriteChartNotes([SENT()], DOCTOR)).toBe(false);
    const { panel } = await openDetail(referral());
    expect(within(panel).getByTestId("tc-chart-notes")).toBeTruthy();
    expect(within(panel).getByTestId("tc-chart-note-sent")).toBeTruthy();
  });

  it("not on a referral that has reached nothing (a draft)", async () => {
    const { panel } = await openDetail(
      referral({ status: "draft", events: [ev({ verb: "create", fromStatus: null, toStatus: "draft" })] }),
    );
    expect(within(panel).queryByTestId("tc-chart-notes")).toBeNull();
  });

  it("never through the sign-off routes, and never for a doctor", async () => {
    const a = await openDetail(referral(), { reader: "signoff", viewer: { tcFull: true, signoff: true } });
    expect(within(a.panel).queryByTestId("tc-chart-notes")).toBeNull();
    cleanup();
    const b = await openDetail(referral(), { viewer: DOCTOR });
    expect(within(b.panel).queryByTestId("tc-chart-notes")).toBeNull();
  });

  it("an office that cannot take a note: the button is disabled and the server's reason is beside it", async () => {
    const reason = 'No "Referral" chart note type is configured for Roland Family Dental, so nothing can be written to its charts';
    const { panel } = await openDetail(
      referral({ chartNotes: { available: false, code: "REFERRAL_COMMTYPE_NOT_CONFIGURED", reason } }),
    );
    fireEvent.click(within(panel).getByTestId("tc-chart-note-sent-review"));
    expect((within(panel).getByTestId("tc-chart-note-sent-write") as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).getByTestId("tc-chart-note-sent-blocked").textContent).toBe(reason);
  });

  it("a detail read that does not say: disabled, fail closed", async () => {
    const { panel } = await openDetail(referral({ chartNotes: undefined }));
    fireEvent.click(within(panel).getByTestId("tc-chart-note-sent-review"));
    expect((within(panel).getByTestId("tc-chart-note-sent-write") as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).getByTestId("tc-chart-note-sent-blocked").textContent).toBe(CHART_NOTES_UNKNOWN_COPY);
  });

  it("a written milestone shows when, by whom and the note — and no button", async () => {
    const { panel } = await openDetail(referral({ status: "acknowledged", events: [SENT(), ACK(), WRITTEN("sent", 50001)] }));
    const written = within(panel).getByTestId("tc-chart-note-written-sent");
    expect(written.textContent).toMatch(/Open Dental note 50001/);
    expect(written.textContent).toMatch(/tc@carein\.ai/);
    expect(within(panel).queryByTestId("tc-chart-note-sent-write")).toBeNull();
    expect(within(panel).getByTestId("tc-chart-note-received")).toBeTruthy();
  });
});

// ── 4: writing ──────────────────────────────────────────────────────────────

describe("4: writing", () => {
  it("the draft, edited; the final text above the button is exactly what is sent; the read-back is shown", async () => {
    const after = referral({ events: [SENT(), WRITTEN("sent", 50001)] });
    ref.writeReferralChartNote.mockResolvedValue({ referral: after, commLogNum: 50001 });
    const { panel, onChanged } = await openDetail(referral());
    fireEvent.click(within(panel).getByTestId("tc-chart-note-sent-review"));
    const box = within(panel).getByTestId("tc-chart-note-sent-text") as HTMLTextAreaElement;
    expect(box.value).toBe(DRAFT_SENT);
    expect(within(panel).getByTestId("tc-chart-note-sent-final").textContent).toBe(DRAFT_SENT);

    // A typed curly quote and dash: the final text shows what Open Dental will store.
    fireEvent.change(box, { target: { value: `${DRAFT_SENT} Patient’s copy faxed — Oct 27.  ` } });
    const final = `${DRAFT_SENT} Patient's copy faxed -- Oct 27.`;
    const shown = within(panel).getByTestId("tc-chart-note-sent-final");
    expect(shown.textContent).toBe(final);
    // Immediately above the button.
    const write = within(panel).getByTestId("tc-chart-note-sent-write");
    expect(shown.compareDocumentPosition(write) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(write);
    await waitFor(() => expect(ref.writeReferralChartNote).toHaveBeenCalledTimes(1));
    expect(ref.writeReferralChartNote).toHaveBeenCalledWith("roland", RID, { milestone: "sent", note: final });
    await within(panel).findByTestId("tc-chart-note-written-sent");
    expect(onChanged).toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith("Written to the chart (Open Dental note 50001)");
    // Nothing else was asked of the server.
    for (const fn of [ref.logReferralCorrespondence, ref.markReferral, ref.referralVerb, ref.sendReferralEmail, ref.editReferralFields]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("a refusal shows the server's sentence, keeps the text, and nothing reads as written", async () => {
    ref.writeReferralChartNote.mockRejectedValue(
      new TcApiError(
        "Open Dental made note 50001, but it could not be read back as written. Check the patient's chart before trying again.",
        502,
        "CHART_NOTE_UNCONFIRMED",
        null,
        [],
      ),
    );
    const { panel, onChanged } = await openDetail(referral());
    fireEvent.click(within(panel).getByTestId("tc-chart-note-sent-review"));
    fireEvent.click(within(panel).getByTestId("tc-chart-note-sent-write"));
    const err = await within(panel).findByTestId("tc-chart-note-sent-error");
    expect(err.textContent).toMatch(/could not be read back/);
    expect(within(panel).queryByTestId("tc-chart-note-written-sent")).toBeNull();
    expect((within(panel).getByTestId("tc-chart-note-sent-text") as HTMLTextAreaElement).value).toBe(DRAFT_SENT);
    expect(onChanged).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("an emptied note cannot be written", async () => {
    const { panel } = await openDetail(referral());
    fireEvent.click(within(panel).getByTestId("tc-chart-note-sent-review"));
    fireEvent.change(within(panel).getByTestId("tc-chart-note-sent-text"), { target: { value: "   " } });
    expect((within(panel).getByTestId("tc-chart-note-sent-write") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── 5: nothing writes on its own ────────────────────────────────────────────

describe("5: nothing writes on its own", () => {
  it("opening, reviewing, a re-read and a status change never call the write — only the click does", async () => {
    const { panel, view } = await openDetail(referral());
    fireEvent.click(within(panel).getByTestId("tc-chart-note-sent-review"));
    // A milestone is reached while the panel is open: still nothing written.
    ref.getReferral.mockResolvedValue(referral({ status: "acknowledged", events: [SENT(), ACK()] }));
    view.rerender(
      <HubDetail
        office="roland"
        referralId={RID}
        onClose={() => undefined}
        onChanged={() => undefined}
        viewer={TC}
        reader="hub"
        signoffRequired={false}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(ref.writeReferralChartNote).not.toHaveBeenCalled();
  });
});
