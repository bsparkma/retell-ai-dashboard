/**
 * R6.9: the correspondence log.
 *
 *   1. The shared pieces: the verb is a non-move; the label ("Phone call from
 *      specialist's office"); the latest wins; the card line ("Last contact:
 *      phone from specialist, Oct 27"); per-status availability.
 *   2. The timeline renders a correspondence row by direction / party /
 *      channel, with its note.
 *   3. The hub panel offers "Log correspondence" to tc.full on every status
 *      but a draft — never through the sign-off routes, never to a doctor.
 *   4. Logging: the body sent, the read-back shown, the status unchanged; a
 *      refusal keeps the form and attempts no file.
 *   5. A file with it goes through R4 unchanged: where R4 would refuse (after
 *      sign-off, or at the cap of 5) the form says so instead of offering one;
 *      where R4 refuses anyway, its own words show and the contact stays logged.
 *   6. The card line on the hub card and the case row.
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
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { HubCard, HubDetail } from "@/pages/tc/TcReferralsHub";
import { ReferralsPanel } from "@/features/tc/referrals/ReferralsPanel";
import { ReferralTimeline } from "@/features/tc/referrals/ReferralTimeline";
import { hubCanLogCorrespondence, type HubViewer } from "@/features/tc/referrals/hubActions";
import {
  CORRESPONDENCE_FILE_FULL_COPY,
  CORRESPONDENCE_FILE_LOCKED_COPY,
} from "@/features/tc/referrals/LogCorrespondence";
import { TcApiError } from "@/features/tc/api";
import {
  REFERRAL_CORRESPONDENCE_STATUSES,
  TC_REFERRAL_CORRESPONDENCE_NOTE_MAX,
  TcReferral as TcReferralSchema,
  TcReferralCorrespondenceRequest,
  TcReferralStatus as StatusEnum,
  referralCanLogCorrespondence,
  referralCorrespondenceLabel,
  referralLastContactLine,
  referralLastCorrespondence,
  referralLastReturn,
  referralLastSendProblem,
  type TcReferral,
  type TcReferralEvent,
  type TcReferralStatus,
} from "@shared/tc/referrals";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const CASE_ID = "1b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const TC: HubViewer = { tcFull: true, signoff: false };
const ADMIN: HubViewer = { tcFull: true, signoff: true };
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
const CORR = (over: Partial<TcReferralEvent> = {}) =>
  ev({
    verb: "correspondence",
    note: "Front desk called: booked for Nov 3.",
    correspondence: { direction: "from", party: "specialist", channel: "phone" },
    ...over,
  });

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
    events: [],
    ...over,
  });
}

const attachment = (i: number) => ({
  attachmentId: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
  referralId: RID,
  fileName: `x${i}.png`,
  contentType: "image/png",
  sizeBytes: 100,
  uploadedBy: "tc@carein.ai",
  uploadedAt: "2026-10-20T15:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  ref.listReferralAttachments.mockResolvedValue([]);
  ref.listDirectory.mockResolvedValue([]);
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
});
afterEach(() => cleanup());

// ── 1: the shared pieces ────────────────────────────────────────────────────

describe("1: the shared pieces", () => {
  it("the label names channel, direction and party", () => {
    expect(referralCorrespondenceLabel({ direction: "from", party: "specialist", channel: "phone" })).toBe(
      "Phone call from specialist's office",
    );
    expect(referralCorrespondenceLabel({ direction: "to", party: "patient", channel: "email" })).toBe("Email to the patient");
    expect(referralCorrespondenceLabel({ direction: "to", party: "specialist", channel: "fax" })).toBe("Fax to specialist's office");
    expect(referralCorrespondenceLabel({ direction: "from", party: "patient", channel: "other" })).toBe("Contact from the patient");
  });

  it("the latest correspondence wins; other rows are ignored; none = null", () => {
    expect(referralLastCorrespondence(undefined)).toBeNull();
    expect(referralLastCorrespondence([ev({ verb: "mark_sent", fromStatus: "approved" })])).toBeNull();
    const later = CORR({ note: "Emailed the patient the map", correspondence: { direction: "to", party: "patient", channel: "email" } });
    expect(referralLastCorrespondence([CORR(), ev({ verb: "mark_acknowledged", toStatus: "acknowledged" }), later])).toEqual({
      direction: "to",
      party: "patient",
      channel: "email",
      note: "Emailed the patient the map",
      actor: "tc@carein.ai",
      at: later.at,
    });
  });

  it("the card line: 'Last contact: phone from specialist, Oct 27'; nothing when none", () => {
    expect(referralLastContactLine(referralLastCorrespondence([CORR()]), "America/Chicago")).toBe(
      "Last contact: phone from specialist, Oct 27",
    );
    expect(referralLastContactLine(null)).toBeNull();
  });

  it("a correspondence row is NOT a move: it neither hides a return nor resets a send problem", () => {
    const ret = ev({ fromStatus: "pending_signoff", toStatus: "draft", verb: "return", note: "Which tooth?" });
    expect(referralLastReturn([ret, CORR({ fromStatus: "draft", toStatus: "draft" })])?.note).toBe("Which tooth?");
    const failed = ev({ fromStatus: "approved", toStatus: "approved", verb: "send_failed", note: "Mailbox full." });
    expect(referralLastSendProblem([failed, CORR({ fromStatus: "approved", toStatus: "approved" })])?.kind).toBe("failed");
  });

  it("per status: every status but a draft", () => {
    expect([...REFERRAL_CORRESPONDENCE_STATUSES]).toEqual(StatusEnum.options.filter((s) => s !== "draft"));
    for (const s of StatusEnum.options) {
      expect(referralCanLogCorrespondence(s), s).toBe(s !== "draft");
      expect(hubCanLogCorrespondence(s, TC), s).toBe(s !== "draft");
      expect(hubCanLogCorrespondence(s, ADMIN), s).toBe(s !== "draft");
      expect(hubCanLogCorrespondence(s, DOCTOR), s).toBe(false);
    }
  });

  it("the request is strict and capped", () => {
    const ok = { direction: "from", party: "specialist", channel: "phone", note: "Called" };
    expect(TcReferralCorrespondenceRequest.safeParse(ok).success).toBe(true);
    expect(TcReferralCorrespondenceRequest.safeParse({ ...ok, office: "valley" }).success).toBe(false);
    expect(TcReferralCorrespondenceRequest.safeParse({ ...ok, note: "  " }).success).toBe(false);
    expect(TcReferralCorrespondenceRequest.safeParse({ ...ok, note: "x".repeat(TC_REFERRAL_CORRESPONDENCE_NOTE_MAX + 1) }).success).toBe(
      false,
    );
  });
});

// ── 2: the timeline ─────────────────────────────────────────────────────────

describe("2: the timeline", () => {
  it("renders the row by direction / party / channel, with its note", () => {
    render(<ReferralTimeline events={[CORR()]} />);
    const tl = screen.getByTestId("referral-timeline");
    expect(within(tl).getByText("Phone call from specialist's office")).toBeTruthy();
    expect(within(tl).getByText("Front desk called: booked for Nov 3.")).toBeTruthy();
  });
});

// ── 3–5: the hub panel ──────────────────────────────────────────────────────

async function openDetail(
  detail: TcReferral,
  opts: { viewer?: HubViewer; reader?: "hub" | "signoff"; files?: number } = {},
) {
  ref.getReferral.mockResolvedValue(detail);
  ref.getSignoffReferral.mockResolvedValue(detail);
  ref.listReferralAttachments.mockResolvedValue(Array.from({ length: opts.files ?? 0 }, (_, i) => attachment(i + 1)));
  const onChanged = vi.fn();
  render(
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
  await within(panel).findByTestId("tc-hub-actions");
  if (opts.files) await waitFor(() => expect(within(panel).getAllByText(/^x\d\.png$/).length).toBe(opts.files));
  return { panel, onChanged };
}

describe("3: who gets 'Log correspondence', where", () => {
  it.each(StatusEnum.options.map((s) => [s] as [TcReferralStatus]))("tc.full on %s", async (status) => {
    const { panel } = await openDetail(referral({ status }));
    expect(within(panel).queryByTestId("tc-hub-correspondence-open") !== null).toBe(status !== "draft");
  });

  it("never through the sign-off routes, never to a doctor", async () => {
    const { panel } = await openDetail(referral({ status: "pending_signoff" }), { viewer: DOCTOR, reader: "signoff" });
    expect(within(panel).queryByTestId("tc-hub-correspondence-open")).toBeNull();
    cleanup();
    const again = await openDetail(referral({ status: "pending_signoff" }), { viewer: ADMIN, reader: "signoff" });
    expect(within(again.panel).queryByTestId("tc-hub-correspondence-open")).toBeNull();
  });
});

function fill(panel: HTMLElement, { who, how, note }: { who?: string; how?: string; note: string }) {
  if (who) fireEvent.change(within(panel).getByLabelText("Who"), { target: { value: who } });
  if (how) fireEvent.change(within(panel).getByLabelText("How"), { target: { value: how } });
  fireEvent.change(within(panel).getByLabelText(/What was said/), { target: { value: note } });
}

describe("4: logging", () => {
  it("sends the body, shows the read-back (status unchanged), and nothing else is called", async () => {
    const d = referral({ status: "acknowledged" });
    const { panel, onChanged } = await openDetail(d);
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-open"));
    const save = within(panel).getByTestId("tc-hub-correspondence-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fill(panel, { who: "to:patient", how: "email", note: "  Sent the patient the specialist's map  " });
    expect(save.disabled).toBe(false);
    const row = CORR({
      fromStatus: "acknowledged",
      toStatus: "acknowledged",
      note: "Sent the patient the specialist's map",
      correspondence: { direction: "to", party: "patient", channel: "email" },
    });
    ref.logReferralCorrespondence.mockResolvedValue({ ...d, events: [row] });
    fireEvent.click(save);
    await waitFor(() =>
      expect(ref.logReferralCorrespondence).toHaveBeenCalledWith("roland", RID, {
        direction: "to",
        party: "patient",
        channel: "email",
        note: "Sent the patient the specialist's map",
      }),
    );
    await waitFor(() => expect(within(panel).getByText("Email to the patient")).toBeTruthy());
    expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Acknowledged");
    expect(within(panel).queryByTestId("tc-hub-correspondence-form")).toBeNull();
    expect(onChanged).toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith("Correspondence logged");
    expect(ref.uploadReferralAttachment).not.toHaveBeenCalled();
    expect(ref.markReferral).not.toHaveBeenCalled();
    expect(ref.referralVerb).not.toHaveBeenCalled();
    expect(ref.sendReferralEmail).not.toHaveBeenCalled();
  });

  it("a refusal keeps the form as typed, shows the server's words, and attempts no file", async () => {
    const { panel } = await openDetail(referral({ status: "pending_signoff" }));
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-open"));
    fill(panel, { note: "Called their office" });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pa.png", { type: "image/png" });
    fireEvent.change(within(panel).getByTestId("referral-attachment-input"), { target: { files: [file] } });
    ref.logReferralCorrespondence.mockRejectedValue(
      new TcApiError("A draft has not gone anywhere yet, so there is no correspondence to log. Submit it first.", 409, "REFERRAL_CORRESPONDENCE_NOT_ALLOWED", null, []),
    );
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-save"));
    await waitFor(() => expect(within(panel).getByRole("alert").textContent).toMatch(/A draft has not gone anywhere yet/));
    expect((within(panel).getByLabelText(/What was said/) as HTMLTextAreaElement).value).toBe("Called their office");
    expect(ref.uploadReferralAttachment).not.toHaveBeenCalled();
  });
});

describe("5: a file with it, through R4 unchanged", () => {
  it("awaiting sign-off with room: the file uploads through R4's route AFTER the contact is logged", async () => {
    const d = referral({ status: "pending_signoff" });
    const { panel } = await openDetail(d, { files: 2 });
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-open"));
    fill(panel, { how: "fax", who: "to:specialist", note: "Faxed the PA" });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pa.png", { type: "image/png" });
    fireEvent.change(within(panel).getByTestId("referral-attachment-input"), { target: { files: [file] } });
    const order: string[] = [];
    ref.logReferralCorrespondence.mockImplementation(async () => {
      order.push("log");
      return { ...d, events: [CORR({ fromStatus: "pending_signoff", toStatus: "pending_signoff" })] };
    });
    ref.uploadReferralAttachment.mockImplementation(async () => {
      order.push("upload");
      return attachment(3);
    });
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-save"));
    await waitFor(() => expect(ref.uploadReferralAttachment).toHaveBeenCalledWith("roland", RID, file));
    expect(order).toEqual(["log", "upload"]);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Correspondence logged, with its file"));
  });

  it("at the cap of 5: no file offered — R4's sentence says why — and the note still logs", async () => {
    const { panel } = await openDetail(referral({ status: "pending_signoff" }), { files: 5 });
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-open"));
    expect(within(panel).getByTestId("tc-hub-correspondence-no-file").textContent).toBe(CORRESPONDENCE_FILE_FULL_COPY);
    expect(CORRESPONDENCE_FILE_FULL_COPY).toMatch(/^A referral can carry at most 5 files/);
    expect(within(panel).queryByTestId("referral-attachment-zone")).toBeNull();
  });

  it("after sign-off: no file offered — R4 takes files only while it is a draft or awaiting sign-off", async () => {
    const { panel } = await openDetail(referral({ status: "sent" }));
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-open"));
    expect(within(panel).getByTestId("tc-hub-correspondence-no-file").textContent).toBe(CORRESPONDENCE_FILE_LOCKED_COPY);
    expect(within(panel).queryByTestId("referral-attachment-zone")).toBeNull();
  });

  it("R4 refuses anyway (someone took the fifth slot): its own words show, and the contact stays logged", async () => {
    const d = referral({ status: "pending_signoff" });
    const { panel } = await openDetail(d, { files: 4 });
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-open"));
    fill(panel, { note: "Their office asked for the PA" });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pa.png", { type: "image/png" });
    fireEvent.change(within(panel).getByTestId("referral-attachment-input"), { target: { files: [file] } });
    ref.logReferralCorrespondence.mockResolvedValue({
      ...d,
      events: [CORR({ fromStatus: "pending_signoff", toStatus: "pending_signoff", note: "Their office asked for the PA" })],
    });
    ref.uploadReferralAttachment.mockRejectedValue(new TcApiError("A referral can carry at most 5 files.", 409, "ATTACHMENT_LIMIT", null, []));
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-save"));
    const refused = await within(panel).findByTestId("tc-hub-correspondence-file-refused");
    expect(refused.textContent).toBe("Logged. pa.png was not attached: A referral can carry at most 5 files.");
    expect(within(panel).getByText("Their office asked for the PA")).toBeTruthy();
    expect(toastMock.error).toHaveBeenCalledWith("Correspondence logged — but pa.png was not attached: A referral can carry at most 5 files.");
  });
});

// ── 6: the card line ────────────────────────────────────────────────────────

const LAST = {
  direction: "from" as const,
  party: "specialist" as const,
  channel: "phone" as const,
  note: "Front desk called",
  actor: "tc@carein.ai",
  at: "2026-10-27T15:00:00.000Z",
};

describe("6: the card line", () => {
  it("the hub card shows the latest contact as a muted line; none = no line", () => {
    render(<HubCard referral={referral({ lastCorrespondence: LAST })} now={new Date("2026-10-28T15:00:00.000Z")} onOpen={() => {}} />);
    const line = screen.getByTestId("referral-last-contact");
    expect(line.textContent).toMatch(/^Last contact: phone from specialist, Oct 2[67]$/);
    expect(line.className).toMatch(/text-muted-foreground/);
    expect(line.getAttribute("title")).toBe("Front desk called");
    cleanup();
    render(<HubCard referral={referral({ lastCorrespondence: null })} now={new Date()} onOpen={() => {}} />);
    expect(screen.queryByTestId("referral-last-contact")).toBeNull();
  });

  it("the case row shows it too", async () => {
    ref.listReferrals.mockResolvedValue([referral({ lastCorrespondence: { ...LAST, channel: "fax", direction: "to" } })]);
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    const line = await screen.findByTestId("referral-last-contact");
    expect(line.textContent).toMatch(/^Last contact: fax to specialist, Oct 2[67]$/);
  });
});
