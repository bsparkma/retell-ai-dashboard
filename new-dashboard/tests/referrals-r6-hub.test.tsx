/**
 * Referrals R6 (queue item 56), in jsdom.
 *
 *  - The hub: grouped by lifecycle (Closed / declined / cancelled collapsed),
 *    filters go to the server, each card shows patient, specialist, source,
 *    status age, attachment count, and a doctor's open question.
 *  - The detail panel: history, staff edit (only what changed is sent; the
 *    panel shows the SERVER's answer, and a refusal leaves it as it was),
 *    "Edit (re-approval needed)" on an approved one, the manual marks labelled
 *    as attestations (mark-sent needs how/where), sent+ read-only.
 *  - The doctor's sign-off card: edit incl. the doctor's note, and "Send back
 *    with a question" (needs the question).
 *  - The submitter sees "Returned by Dr. — <question>" on the case panel.
 *  - The route gate: /tc/referrals is tc.full; the sign-off page stays the
 *    doctor's own.
 *
 * With TC_SHOTS=1 it also dumps the hub and the doctor's edit card
 * (tccheckout-11 / -12). NO NETWORK, NO BACKEND, NO PHI (test patient 12827).
 */
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TcReferral, TcReferralDirectoryEntry, TcReferralEvent } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralsStatus: vi.fn(),
    listDirectory: vi.fn(),
    listHub: vi.fn(),
    getReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    editReferralFields: vi.fn(),
    reopenReferral: vi.fn(),
    markReferral: vi.fn(),
    listReferrals: vi.fn(),
    createReferral: vi.fn(),
    updateReferral: vi.fn(),
    referralVerb: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    listSignoffQueue: vi.fn(),
    getSignoffReferral: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    listSignoffDirectory: vi.fn(),
    doctorEditReferral: vi.fn(),
    returnReferral: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/components/TcShell", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/components/TcShell")>()),
  useTcOffice: () => "roland",
}));

import { HubInner, groupForHub, nextMark } from "@/pages/tc/TcReferralsHub";
import { SignoffInner } from "@/pages/tc/TcReferralSignoff";
import { ReferralsPanel } from "@/features/tc/referrals/ReferralsPanel";
import { changedFields } from "@/features/tc/referrals/ReferralFieldsForm";
import { referralEventLabel } from "@/features/tc/referrals/ReferralTimeline";
import { requiredActionFor } from "@/lib/permissions";
import { referralLastReturn, referralReturnedLine, referralStatusAge } from "@shared/tc/referrals";

const NOW = new Date("2026-10-20T15:00:00.000Z");
const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const ENTRY = "5a1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const ENTRY2 = "5b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const id = (n: number) => `${n}b1c2d3e-4f50-4a61-8b72-938495a6b7c8`;

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: id(9),
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: CASE_ID,
    sourceKind: "case",
    sourceRef: CASE_ID,
    referringProvider: "DOC1",
    directoryEntryId: ENTRY,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "Sensitive to biting",
    status: "draft",
    statusChangedAt: "2026-10-17T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-16T15:00:00.000Z",
    updatedAt: "2026-10-16T15:00:00.000Z",
    doctorNote: null,
    attachmentCount: 0,
    returned: null,
    ...over,
  };
}

function entry(over: Partial<TcReferralDirectoryEntry> = {}): TcReferralDirectoryEntry {
  return {
    entryId: ENTRY,
    officeId: "roland",
    practiceName: "River Endodontics",
    specialistName: "",
    specialty: "Endodontics",
    contactPerson: "",
    email: "",
    phone: "",
    fax: "",
    notes: "",
    preferredFormatNotes: "",
    active: true,
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedBy: "tc@carein.ai",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function ev(over: Partial<TcReferralEvent>): TcReferralEvent {
  return {
    eventId: id(Math.floor(Math.random() * 9)).replace(/^./, "e"),
    fromStatus: null,
    toStatus: "draft",
    actor: "tc@carein.ai",
    at: "2026-10-16T15:00:00.000Z",
    note: "",
    verb: null,
    ...over,
  };
}

const HUB_LIST = [
  referral({ referralId: id(1), status: "draft", attachmentCount: 1, returned: { note: "Which tooth — 3 or 14?", actor: "doctor@carein.ai", at: "2026-10-19T15:00:00.000Z" } }),
  referral({ referralId: id(2), status: "pending_signoff", sourceKind: "checkout", attachmentCount: 2, urgency: "urgent" }),
  referral({ referralId: id(3), status: "approved", sourceKind: "hyg_visit", practiceName: "Valley Periodontics", directoryEntryId: ENTRY2 }),
  referral({ referralId: id(4), status: "sent", sourceKind: "call" }),
  referral({ referralId: id(5), status: "patient_seen" }),
  referral({ referralId: id(6), status: "cancelled" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listDirectory.mockResolvedValue([entry(), entry({ entryId: ENTRY2, practiceName: "Valley Periodontics", specialty: "Periodontics" })]);
  ref.listSignoffDirectory.mockResolvedValue([entry(), entry({ entryId: ENTRY2, practiceName: "Valley Periodontics", specialty: "Periodontics" })]);
  ref.listHub.mockResolvedValue(HUB_LIST);
  ref.listReferralAttachments.mockResolvedValue([]);
});
afterEach(cleanup);

// ── pure pieces ─────────────────────────────────────────────────────────────

describe("pure pieces", () => {
  it("groups in page order; sent + acknowledged share a group", () => {
    const g = groupForHub([...HUB_LIST, referral({ referralId: id(7), status: "acknowledged" })]);
    expect(g.map((x) => [x.key, x.referrals.length])).toEqual([
      ["drafts", 1],
      ["signoff", 1],
      ["ready", 1],
      ["sent", 2],
      ["seen", 1],
      ["done", 1],
    ]);
  });
  it("the next mark per status, and none before approval", () => {
    expect(["draft", "pending_signoff", "approved", "sent", "acknowledged", "patient_seen", "closed"].map((s) => nextMark(s as never))).toEqual([
      null,
      null,
      "mark_sent",
      "mark_acknowledged",
      "mark_patient_seen",
      "close",
      null,
    ]);
  });
  it("status age reads like the spec", () => {
    expect(referralStatusAge("pending_signoff", "2026-10-17T14:00:00.000Z", NOW)).toBe("in sign-off 3d");
    expect(referralStatusAge("draft", "2026-10-20T14:00:00.000Z", NOW)).toBe("draft <1d");
  });
  it("only what changed is sent", () => {
    const r = referral();
    expect(changedFields(r, { directoryEntryId: ENTRY, urgency: "soon", reason: "Possible cracked tooth", teeth: [3] }, false)).toEqual({});
    expect(changedFields(r, { directoryEntryId: "", urgency: "urgent", reason: " x ", teeth: "mouth", doctorNote: "n" }, false)).toEqual({
      directoryEntryId: null,
      urgency: "urgent",
      reason: "x",
      teeth: "mouth",
    });
    expect(changedFields(r, { directoryEntryId: ENTRY, urgency: "soon", reason: "Possible cracked tooth", teeth: [3], doctorNote: "  " }, true)).toEqual({});
    expect(changedFields(r, { directoryEntryId: ENTRY, urgency: "soon", reason: "Possible cracked tooth", teeth: [3], doctorNote: "See soon" }, true)).toEqual({ doctorNote: "See soon" });
  });
  it("the return line follows the latest status MOVE, not edits", () => {
    const events = [
      ev({ verb: "create" }),
      ev({ verb: "submit", fromStatus: "draft", toStatus: "pending_signoff" }),
      ev({ verb: "return", fromStatus: "pending_signoff", toStatus: "draft", note: "Which tooth?", actor: "doctor@carein.ai" }),
      ev({ verb: "edit", fromStatus: "draft", toStatus: "draft", note: "Changed teeth" }),
    ];
    expect(referralReturnedLine(referralLastReturn(events))).toBe("Returned by Dr. — Which tooth?");
    expect(referralLastReturn([...events, ev({ verb: "submit", fromStatus: "draft", toStatus: "pending_signoff" })])).toBeNull();
    expect(referralLastReturn([ev({ verb: "withdraw", fromStatus: "pending_signoff", toStatus: "draft" })])).toBeNull();
  });
  it("history labels: by verb, and by status for rows written before R6", () => {
    expect(referralEventLabel(ev({ verb: "mark_sent", toStatus: "sent" }))).toBe("Marked sent (outside the app)");
    expect(referralEventLabel(ev({ verb: null, toStatus: "pending_signoff" }))).toBe("Pending Dr. sign-off");
  });
  it("the hub is tc.full; the sign-off page stays the doctor's own", () => {
    expect(requiredActionFor("/tc/referrals")).toBe("tc.full");
    expect(requiredActionFor("/tc/referrals/signoff")).toBe("tc.referral_signoff");
  });
});

// ── the hub ─────────────────────────────────────────────────────────────────

describe("the hub", () => {
  it("draws every group, collapses the finished ones, and each card carries its facts", async () => {
    render(<HubInner office="roland" now={() => NOW} />);
    const drafts = await screen.findByTestId("tc-hub-group-drafts");
    const card = within(drafts).getByTestId("tc-hub-card");
    expect(card.textContent).toContain("Test 2, Stedi");
    expect(card.textContent).toContain("River Endodontics");
    expect(within(card).getByTestId("tc-hub-source").textContent).toBe("TC case");
    expect(within(card).getByTestId("tc-hub-age").textContent).toBe("draft 3d");
    expect(within(card).getByTestId("tc-hub-attachments").textContent).toContain("1");
    expect(within(card).getByTestId("tc-hub-returned").textContent).toBe("Returned by Dr. — Which tooth — 3 or 14?");
    expect(within(screen.getByTestId("tc-hub-group-signoff")).getByTestId("tc-hub-source").textContent).toBe("Checkout");
    expect(within(screen.getByTestId("tc-hub-group-ready")).getByTestId("tc-hub-card").textContent).toContain("Valley Periodontics");
    expect(within(screen.getByTestId("tc-hub-group-sent")).getAllByTestId("tc-hub-card")).toHaveLength(1);
    expect(within(screen.getByTestId("tc-hub-group-seen")).getAllByTestId("tc-hub-card")).toHaveLength(1);

    const done = screen.getByTestId("tc-hub-group-done");
    expect(within(done).queryByTestId("tc-hub-card")).toBeNull();
    expect(within(done).getByTestId("tc-hub-group-count").textContent).toBe("1");
    fireEvent.click(within(done).getByRole("button", { name: /Closed \/ declined \/ cancelled/ }));
    expect(within(done).getAllByTestId("tc-hub-card")).toHaveLength(1);
  });

  it("filters are the server's: each change re-asks with the filter", async () => {
    render(<HubInner office="roland" now={() => NOW} />);
    await screen.findByTestId("tc-hub-group-drafts");
    await waitFor(() => expect(screen.getByLabelText("Specialist").querySelectorAll("option").length).toBe(3));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "approved" } });
    await waitFor(() => expect(ref.listHub).toHaveBeenLastCalledWith("roland", { status: "approved" }));
    fireEvent.change(screen.getByLabelText("Specialist"), { target: { value: ENTRY2 } });
    fireEvent.change(screen.getByLabelText("Started from"), { target: { value: "hyg_visit" } });
    fireEvent.change(screen.getByLabelText("Sat for"), { target: { value: "7" } });
    await waitFor(() =>
      expect(ref.listHub).toHaveBeenLastCalledWith("roland", {
        status: "approved",
        directoryEntryId: ENTRY2,
        sourceKind: "hyg_visit",
        minAgeDays: 7,
      }),
    );
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "" } });
    await waitFor(() =>
      expect(ref.listHub).toHaveBeenLastCalledWith("roland", { status: undefined, directoryEntryId: ENTRY2, sourceKind: "hyg_visit", minAgeDays: 7 }),
    );
  });

  it("dark: referrals off for the office → says so and never lists", async () => {
    ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: false });
    render(<HubInner office="roland" now={() => NOW} />);
    expect((await screen.findByTestId("tc-hub-off")).textContent).toContain("not switched on");
    expect(ref.listHub).not.toHaveBeenCalled();
  });
});

// ── the detail panel ────────────────────────────────────────────────────────

async function openCard(groupKey: string, detail: TcReferral) {
  ref.getReferral.mockResolvedValue(detail);
  render(<HubInner office="roland" now={() => NOW} />);
  const group = await screen.findByTestId(`tc-hub-group-${groupKey}`);
  fireEvent.click(within(group).getByTestId("tc-hub-card"));
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByTestId("referral-timeline");
  return panel;
}

describe("the detail panel", () => {
  it("a draft: history, files, and an edit that sends only what changed and shows the SERVER's answer", async () => {
    const d = referral({
      referralId: id(1),
      events: [ev({ verb: "create" }), ev({ verb: "return", fromStatus: "pending_signoff", toStatus: "draft", note: "Which tooth?", actor: "doctor@carein.ai" })],
      returned: { note: "Which tooth?", actor: "doctor@carein.ai", at: "2026-10-19T15:00:00.000Z" },
    });
    const panel = await openCard("drafts", d);
    expect(within(panel).getByTestId("tc-hub-detail-returned").textContent).toBe("Returned by Dr. — Which tooth?");
    expect(within(panel).getByTestId("referral-timeline").textContent).toContain("Returned by Dr.");
    expect(ref.listReferralAttachments).toHaveBeenCalledWith("roland", id(1));

    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    const form = await within(panel).findByTestId("referral-fields-form");
    expect(within(form).queryByLabelText("Doctor's note")).toBeNull();
    fireEvent.change(within(form).getByLabelText("How soon"), { target: { value: "urgent" } });
    fireEvent.change(within(form).getByLabelText("Teeth"), { target: { value: "3, 14" } });
    ref.editReferralFields.mockResolvedValue({ ...d, urgency: "urgent", teeth: [3, 14] });
    fireEvent.click(within(form).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(ref.editReferralFields).toHaveBeenCalledWith("roland", id(1), { urgency: "urgent", teeth: [3, 14] }));
    await waitFor(() => expect(within(panel).queryByTestId("referral-fields-form")).toBeNull());
    expect(panel.textContent).toContain("#3, #14");
    expect(toastMock.success).toHaveBeenCalledWith("Referral updated");
  });

  it("honest states: a refused edit keeps the form open with the server's words, and nothing reads as saved", async () => {
    const d = referral({ referralId: id(1), events: [ev({ verb: "create" })] });
    const panel = await openCard("drafts", d);
    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    const form = await within(panel).findByTestId("referral-fields-form");
    fireEvent.change(within(form).getByLabelText("How soon"), { target: { value: "urgent" } });
    ref.editReferralFields.mockRejectedValue(new Error("This referral can no longer be edited: it is approved."));
    fireEvent.click(within(form).getByRole("button", { name: /Save changes/ }));
    expect(await within(form).findByText(/can no longer be edited/)).toBeTruthy();
    expect(toastMock.success).not.toHaveBeenCalled();
    // The form is still open, and the details still say what the server holds.
    expect(within(panel).getByTestId("referral-fields-form")).toBeTruthy();
    expect(panel.querySelector("dl")?.textContent).toContain("How soonSoon");
  });

  it("an approved one: 'Edit (re-approval needed)' reopens WITH the edit; 'Mark sent outside the app' needs how/where", async () => {
    const d = referral({ referralId: id(3), status: "approved", events: [ev({ verb: "approve", fromStatus: "pending_signoff", toStatus: "approved" })] });
    const panel = await openCard("ready", d);
    expect(within(panel).queryByRole("button", { name: /^Edit$/ })).toBeNull();
    expect(panel.textContent).toContain("Ready to send — sending ships in a later update.");

    // The mark: labelled as a record, needs how/where, sends nothing.
    const mark = within(panel).getByTestId("tc-hub-mark");
    expect(mark.textContent).toContain("it does not send anything");
    const markBtn = within(mark).getByRole("button", { name: "Mark sent outside the app" }) as HTMLButtonElement;
    expect(markBtn.disabled).toBe(true);
    fireEvent.change(within(mark).getByLabelText(/How and where/), { target: { value: "Faxed to their front desk" } });
    expect(markBtn.disabled).toBe(false);

    fireEvent.click(within(panel).getByRole("button", { name: /Edit \(re-approval needed\)/ }));
    const form = await within(panel).findByTestId("referral-fields-form");
    expect(form.textContent).toContain("sends it back to the doctor for sign-off first");
    fireEvent.change(within(form).getByLabelText("Specialist"), { target: { value: ENTRY2 } });
    ref.reopenReferral.mockResolvedValue({ ...d, status: "pending_signoff", directoryEntryId: ENTRY2, practiceName: "Valley Periodontics" });
    fireEvent.click(within(form).getByRole("button", { name: /Save & send for re-approval/ }));
    await waitFor(() => expect(ref.reopenReferral).toHaveBeenCalledWith("roland", id(3), { directoryEntryId: ENTRY2 }));
    await waitFor(() => expect(within(panel).getByTestId("tc-referral-status").textContent).toBe("Pending Dr. sign-off"));
    expect(ref.markReferral).not.toHaveBeenCalled();
  });

  it("the mark records the server's answer and moves on to the next one", async () => {
    const d = referral({ referralId: id(3), status: "approved", events: [ev({ verb: "approve" })] });
    const panel = await openCard("ready", d);
    const mark = within(panel).getByTestId("tc-hub-mark");
    fireEvent.change(within(mark).getByLabelText(/How and where/), { target: { value: "Emailed" } });
    ref.markReferral.mockResolvedValue({ ...d, status: "sent", events: [...(d.events ?? []), ev({ verb: "mark_sent", fromStatus: "approved", toStatus: "sent", note: "Sent outside the app: Emailed" })] });
    fireEvent.click(within(mark).getByRole("button", { name: "Mark sent outside the app" }));
    await waitFor(() => expect(ref.markReferral).toHaveBeenCalledWith("roland", id(3), "mark_sent", "Emailed"));
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "Specialist acknowledged (outside the app)" })).toBeTruthy(),
    );
    expect(within(panel).getByTestId("referral-timeline").textContent).toContain("Sent outside the app: Emailed");
  });

  it("sent and beyond: read-only — no edit of any kind, only the next attestation", async () => {
    const d = referral({ referralId: id(4), status: "sent", events: [ev({ verb: "mark_sent", toStatus: "sent" })] });
    const panel = await openCard("sent", d);
    expect(within(panel).getByTestId("tc-hub-readonly").textContent).toContain("can no longer be edited");
    expect(within(panel).queryByRole("button", { name: /Edit/ })).toBeNull();
    const next = within(panel).getByRole("button", { name: "Specialist acknowledged (outside the app)" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false); // the note is optional
  });
});

// ── the doctor's sign-off card ──────────────────────────────────────────────

async function openSignoff(detail: TcReferral) {
  ref.listSignoffQueue.mockResolvedValue([detail]);
  ref.getSignoffReferral.mockResolvedValue(detail);
  render(<SignoffInner office="roland" />);
  fireEvent.click(await screen.findByTestId("tc-signoff-row"));
  return screen.findByTestId("tc-signoff-detail");
}

describe("the doctor's sign-off card", () => {
  it("the doctor edits fields and their own note; the card shows what the server stored", async () => {
    const p = referral({ status: "pending_signoff", events: [] });
    const detail = await openSignoff(p);
    fireEvent.click(within(detail).getByRole("button", { name: /^Edit$/ }));
    const form = await within(detail).findByTestId("referral-fields-form");
    await waitFor(() => expect(ref.listSignoffDirectory).toHaveBeenCalledWith("roland"));
    expect(ref.listDirectory).not.toHaveBeenCalled(); // the directory route is tc.full
    expect((within(detail).getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Doctor's note"), { target: { value: "Please see within the week." } });
    fireEvent.change(within(form).getByLabelText("How soon"), { target: { value: "urgent" } });
    ref.doctorEditReferral.mockResolvedValue({ ...p, urgency: "urgent", doctorNote: "Please see within the week." });
    fireEvent.click(within(form).getByRole("button", { name: /Save changes/ }));
    await waitFor(() =>
      expect(ref.doctorEditReferral).toHaveBeenCalledWith("roland", p.referralId, { urgency: "urgent", doctorNote: "Please see within the week." }),
    );
    expect((await within(detail).findByTestId("tc-signoff-doctor-note")).textContent).toBe("Please see within the week.");
    expect((within(detail).getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("send back with a question: the question is required, and it goes back as a draft", async () => {
    const p = referral({ status: "pending_signoff", events: [] });
    const detail = await openSignoff(p);
    fireEvent.click(within(detail).getByRole("button", { name: /Send back with a question/ }));
    const send = within(detail).getByRole("button", { name: "Send back" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(detail).getByLabelText("What do you need from them?"), { target: { value: "Which tooth — 3 or 14?" } });
    ref.returnReferral.mockResolvedValue({ ...p, status: "draft" });
    ref.listSignoffQueue.mockResolvedValue([]);
    fireEvent.click(send);
    await waitFor(() => expect(ref.returnReferral).toHaveBeenCalledWith("roland", p.referralId, "Which tooth — 3 or 14?"));
    expect((await screen.findByTestId("tc-signoff-done")).textContent).toContain("sent back with your question");
    expect(ref.approveReferral).not.toHaveBeenCalled();
  });
});

// ── the submitter's surface ─────────────────────────────────────────────────

describe("the submitter sees the doctor's question", () => {
  it("on the case's referral panel", async () => {
    ref.listReferrals.mockResolvedValue([
      referral({ returned: { note: "Which tooth — 3 or 14?", actor: "doctor@carein.ai", at: "2026-10-19T15:00:00.000Z" } }),
      referral({ referralId: id(2), status: "pending_signoff" }),
    ]);
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    const lines = await screen.findAllByTestId("tc-referral-returned");
    expect(lines.map((l) => l.textContent)).toEqual(["Returned by Dr. — Which tooth — 3 or 14?"]);
  });
});

// ── screenshot dumps ────────────────────────────────────────────────────────

const SHOOT = process.env.TC_SHOTS === "1";
describe.skipIf(!SHOOT)("referrals R6 screenshot dumps", () => {
  const out = resolve(import.meta.dirname, ".shots");
  it("11 — the Referrals hub", async () => {
    render(
      <div className="max-w-6xl">
        <HubInner office="roland" now={() => NOW} />
      </div>,
    );
    await screen.findByTestId("tc-hub-group-drafts");
    await waitFor(() => expect(screen.getByLabelText("Specialist").querySelectorAll("option").length).toBe(3));
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-11-referrals-hub@1280x900.html"), document.body.innerHTML, "utf8");
  });
  it("12 — the doctor's edit card at sign-off", async () => {
    const p = referral({
      status: "pending_signoff",
      urgency: "soon",
      events: [
        ev({ eventId: "e1000000-4f50-4a61-8b72-938495a6b7c8", verb: "create", at: "2026-10-16T15:00:00.000Z" }),
        ev({ eventId: "e2000000-4f50-4a61-8b72-938495a6b7c8", verb: "submit", fromStatus: "draft", toStatus: "pending_signoff", at: "2026-10-17T15:00:00.000Z" }),
      ],
    });
    const detail = await openSignoff(p);
    fireEvent.click(within(detail).getByRole("button", { name: /^Edit$/ }));
    const form = await within(detail).findByTestId("referral-fields-form");
    await waitFor(() => expect(within(form).getByLabelText("Specialist").querySelectorAll("option").length).toBe(3));
    await act(async () => {
      fireEvent.change(within(form).getByLabelText("Doctor's note"), { target: { value: "Please see within the week; patient is symptomatic." } });
      fireEvent.change(within(form).getByLabelText("How soon"), { target: { value: "urgent" } });
    });
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-12-signoff-doctor-edit@1280x1100.html"), document.body.innerHTML, "utf8");
  });
});
