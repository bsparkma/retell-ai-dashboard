/**
 * EL-2c — approve up front, in the dashboard.
 *
 *   - Start Nurture from the library opens "Review campaign" on the campaign
 *     the server just wrote
 *   - Review campaign: each email's planned time, stage, subject and chip;
 *     Approve / Edit / Change date / Skip on a draft; Unapprove (and the
 *     "unapprove to send by hand" hint) on an approved one; Approve all asks
 *     first; the honest "automatic sending is not switched on" banner
 *   - the case strip: "Library: Dental Crown · Warm · 3 of 10 approved · 0
 *     sent · next Dec 1", Review and Patient replied
 *   - the outbox: library campaigns per case with a needs-approval count
 *
 * NOTHING HERE SENDS: messagingApi.sendMessage is a mock that must never be
 * called. NO NETWORK: every API is mocked. Designated test-patient names only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { NurtureCaseResponse } from "@shared/tc/nurture";
import { NURTURE_AUTOMATIC_SENDING_NOTE } from "@shared/tc/nurture";
import {
  CASE_A,
  CATALOG,
  ENR_A,
  campaignResponse,
  libraryEnrollment,
  message,
  outboxWithCampaigns,
  rendered,
} from "./fixtures/tcNurtureCampaign";

(globalThis as Record<string, unknown>).React = React;

const api = vi.hoisted(() => ({
  getNurtureOutbox: vi.fn(),
  skipNurtureDraft: vi.fn(),
  getCaseNurture: vi.fn(),
  startNurture: vi.fn(),
  pauseNurture: vi.fn(),
  resumeNurture: vi.fn(),
  stopNurture: vi.fn(),
  getNurtureCampaign: vi.fn(),
  approveNurtureEmail: vi.fn(),
  unapproveNurtureEmail: vi.fn(),
  rescheduleNurtureEmail: vi.fn(),
  approveAllNurtureEmails: vi.fn(),
  markPatientReplied: vi.fn(),
  getEmailLibraryCatalog: vi.fn(),
  editDraft: vi.fn(),
  renderEmail: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("@/features/tc/nurture/campaignApi", () => ({
  getNurtureOutbox: api.getNurtureOutbox,
  skipNurtureDraft: api.skipNurtureDraft,
  getCaseNurture: api.getCaseNurture,
  startNurture: api.startNurture,
  pauseNurture: api.pauseNurture,
  resumeNurture: api.resumeNurture,
  stopNurture: api.stopNurture,
  getNurtureCampaign: api.getNurtureCampaign,
  approveNurtureEmail: api.approveNurtureEmail,
  unapproveNurtureEmail: api.unapproveNurtureEmail,
  rescheduleNurtureEmail: api.rescheduleNurtureEmail,
  approveAllNurtureEmails: api.approveAllNurtureEmails,
  markPatientReplied: api.markPatientReplied,
}));
vi.mock("@/features/tc/messaging/messagingApi", () => ({
  editDraft: api.editDraft,
  renderEmail: api.renderEmail,
  sendMessage: api.sendMessage,
}));
vi.mock("@/features/tc/emailLibrary/emailLibraryApi", () => ({ getEmailLibraryCatalog: api.getEmailLibraryCatalog }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NurtureCampaignBar } from "@/features/tc/nurture/NurtureCampaignBar";
import { NurtureCampaignReview } from "@/features/tc/nurture/NurtureCampaignReview";
import { NurtureOutbox } from "@/features/tc/nurture/NurtureOutbox";

function wrap(node: React.ReactNode) {
  const { hook } = memoryLocation({ path: "/tc/cases/x" });
  return render(<WouterRouter hook={hook}>{node}</WouterRouter>);
}

const TRACKS: NurtureCaseResponse["tracks"] = [
  { trackKey: "warm_followup", label: "Warm Follow-Up", goal: "Schedule presented treatment while it's fresh.", intensity: "standard", touchCount: 6, channels: ["sms", "email"], available: true, reason: null, libraryAvailable: true, libraryBlockedReason: null },
];

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
  api.getNurtureCampaign.mockResolvedValue(campaignResponse());
  api.renderEmail.mockImplementation(async () => rendered(3));
  api.sendMessage.mockImplementation(async () => {
    throw new Error("EL-2c must never send");
  });
});
afterEach(() => {
  cleanup();
  expect(api.sendMessage).not.toHaveBeenCalled();
});

describe("Start Nurture from the library opens Review campaign", () => {
  it("opens the campaign the server just wrote", async () => {
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [], tracks: TRACKS } satisfies NurtureCaseResponse);
    api.startNurture.mockResolvedValue(libraryEnrollment({ approvedCount: 0 }));
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId("start-nurture"));
    fireEvent.click(screen.getByTestId("nurture-library-toggle"));
    await waitFor(() => expect(screen.getByTestId("nurture-library-procedure")).not.toHaveProperty("disabled", true));
    fireEvent.change(screen.getByTestId("nurture-library-procedure"), { target: { value: "crown" } });
    fireEvent.click(screen.getByTestId("track-warm_followup"));
    await waitFor(() => expect(api.getNurtureCampaign).toHaveBeenCalledWith("roland", ENR_A));
    expect(api.startNurture).toHaveBeenCalledWith("roland", CASE_A, "warm_followup", { procedureId: "crown", variant: "A" });
    expect(await screen.findByTestId("nurture-review")).toBeTruthy();
    expect(screen.getAllByTestId("nurture-review-email")).toHaveLength(10);
  });
});

describe("Review campaign", () => {
  const open = () =>
    wrap(<NurtureCampaignReview office="roland" enrollmentId={ENR_A} open onOpenChange={() => {}} onChanged={() => {}} />);

  it("shows the honest banner, the progress, and each email's planned time, stage, subject and chip", async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    expect(screen.getByTestId("nurture-auto-send-note").textContent).toContain(NURTURE_AUTOMATIC_SENDING_NOTE);
    expect(screen.getByTestId("nurture-review-progress").textContent).toBe("3 of 10 approved");
    expect(within(rows[0]).getByTestId("nurture-review-chip").textContent).toBe("Approved, sends Dec 1");
    expect(within(rows[3]).getByTestId("nurture-review-chip").textContent).toBe("Needs approval");
    // Planned times are office time: 2026-12-10 16:00Z is 10:00 AM in Chicago.
    expect(within(rows[3]).getByTestId("nurture-review-planned").textContent).toContain("Thu, Dec 10 · 10:00 AM");
    await waitFor(() => expect(rows[3].textContent).toContain("What to expect"));
    expect(rows[3].textContent).toContain("Email 4 of 10");
    expect(rows[3].textContent).toContain("What the appointment is actually like");
  });

  it("a draft offers Approve, Edit, Change date and Skip; an approved one offers Unapprove (and how to send by hand)", async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    expect(within(rows[3]).getByTestId("nurture-review-approve")).toBeTruthy();
    expect(within(rows[3]).getByText("Edit")).toBeTruthy();
    expect(within(rows[3]).getByText("Change date")).toBeTruthy();
    expect(within(rows[3]).queryByTestId("nurture-review-unapprove")).toBeNull();
    expect(within(rows[0]).getByTestId("nurture-review-unapprove")).toBeTruthy();
    expect(within(rows[0]).queryByTestId("nurture-review-approve")).toBeNull();
    expect(within(rows[0]).queryByText("Edit")).toBeNull();
    expect(within(rows[0]).getByTestId("nurture-review-unapprove-hint").textContent).toMatch(/Unapprove to edit it or send it by hand/);

    api.approveNurtureEmail.mockResolvedValue({ message: message(3, { status: "scheduled" }), replanned: 0 });
    fireEvent.click(within(rows[3]).getByTestId("nurture-review-approve"));
    await waitFor(() => expect(api.approveNurtureEmail).toHaveBeenCalledWith("roland", message(3).messageId));
    api.unapproveNurtureEmail.mockResolvedValue(message(0));
    fireEvent.click(within(rows[0]).getByTestId("nurture-review-unapprove"));
    await waitFor(() => expect(api.unapproveNurtureEmail).toHaveBeenCalledWith("roland", message(0).messageId));
  });

  it("Approve all asks first, then approves every remaining draft in one call", async () => {
    open();
    fireEvent.click(await screen.findByTestId("nurture-approve-all"));
    expect(api.approveAllNurtureEmails).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("nurture-approve-all-confirm");
    expect(confirm.textContent).toMatch(/Approve all 7 exactly as written\? Each waits for its planned time\./);
    api.approveAllNurtureEmails.mockResolvedValue({ approved: 7, enrollment: libraryEnrollment({ approvedCount: 10 }) });
    fireEvent.click(within(confirm).getByRole("button", { name: "Approve all 7" }));
    await waitFor(() => expect(api.approveAllNurtureEmails).toHaveBeenCalledWith("roland", ENR_A));
  });

  it("skipped and sent emails say so, and offer nothing", async () => {
    api.getNurtureCampaign.mockResolvedValue(
      campaignResponse({
        emails: campaignResponse().emails.map((x, i) =>
          i === 4 ? { ...x, message: { ...x.message, status: "skipped", skipReason: "manual" } } : i === 5 ? { ...x, message: { ...x.message, status: "sent" } } : x,
        ),
      }),
    );
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    expect(within(rows[4]).getByTestId("nurture-review-chip").textContent).toBe("Skipped: by a person");
    expect(within(rows[5]).getByTestId("nurture-review-chip").textContent).toBe("Sent");
    for (const r of [rows[4], rows[5]]) {
      expect(within(r).queryByTestId("nurture-review-approve")).toBeNull();
      expect(within(r).queryByTestId("nurture-review-skip")).toBeNull();
    }
  });

  it("Edit refuses a {{ token on the client too; Save sends the text through the ordinary draft edit", async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    fireEvent.click(within(rows[3]).getByText("Edit"));
    const box = within(rows[3]).getByRole("textbox", { name: "Email text" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Hi {{first_name}}" } });
    expect(within(rows[3]).getByTestId("nurture-review-text-problem").textContent).toMatch(/merge token/);
    expect((within(rows[3]).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Hi Stedi,\n\nA shorter note.\n\nTest Coordinator" } });
    api.editDraft.mockResolvedValue(message(3));
    fireEvent.click(within(rows[3]).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.editDraft).toHaveBeenCalledWith("roland", message(3).messageId, {
        body: "Hi Stedi,\n\nA shorter note.\n\nTest Coordinator",
        subject: "What the appointment is actually like",
      }),
    );
  });

  it("Change date sends a date and a time in office time", async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    fireEvent.click(within(rows[3]).getByText("Change date"));
    const form = within(rows[3]).getByTestId("nurture-review-date-form");
    expect((within(form).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-12-10");
    expect((within(form).getByLabelText("Time (office)") as HTMLInputElement).value).toBe("10:00");
    fireEvent.change(within(form).getByLabelText("Date"), { target: { value: "2026-12-11" } });
    fireEvent.change(within(form).getByLabelText("Time (office)"), { target: { value: "11:30" } });
    api.rescheduleNurtureEmail.mockResolvedValue(message(3));
    fireEvent.click(within(form).getByRole("button", { name: "Save date" }));
    await waitFor(() =>
      expect(api.rescheduleNurtureEmail).toHaveBeenCalledWith("roland", message(3).messageId, { date: "2026-12-11", time: "11:30" }),
    );
  });

  it("Show email renders the server's email in a sandboxed frame", async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    fireEvent.click(within(rows[3]).getByTestId("nurture-review-preview-toggle"));
    await waitFor(() => expect(api.renderEmail).toHaveBeenCalledWith("roland", { messageId: message(3).messageId }));
    const frame = (await within(rows[3]).findByTestId("email-preview-frame")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
  });

  it("a paused campaign says so and cannot be approved; nothing was cancelled", async () => {
    api.getNurtureCampaign.mockResolvedValue(campaignResponse({ enrollment: libraryEnrollment({ status: "paused" }) }));
    open();
    expect((await screen.findByTestId("nurture-review-not-running")).textContent).toMatch(/paused.*Nothing is cancelled/);
    expect(screen.queryByTestId("nurture-approve-all")).toBeNull();
    const rows = screen.getAllByTestId("nurture-review-email");
    expect((within(rows[3]).getByTestId("nurture-review-approve") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the case strip on a library campaign", () => {
  it("reads approvals and sends, offers Review and Patient replied, and says nothing sends automatically", async () => {
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [libraryEnrollment()],
      tracks: TRACKS.map((t) => ({ ...t, available: false, reason: "already_enrolled" as const })),
    } satisfies NurtureCaseResponse);
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("nurture-chip-pace").textContent).toBe(
        "Library: Dental Crown · Warm · 3 of 10 approved · 0 sent · next Dec 1",
      ),
    );
    expect(screen.getByTestId("nurture-strip-auto-note").textContent).toBe(NURTURE_AUTOMATIC_SENDING_NOTE);
    api.markPatientReplied.mockResolvedValue(libraryEnrollment({ status: "paused", stopReason: "patient_replied" }));
    fireEvent.click(screen.getByTestId("nurture-replied"));
    await waitFor(() => expect(api.markPatientReplied).toHaveBeenCalledWith("roland", ENR_A));
    fireEvent.click(screen.getByTestId("nurture-review-open"));
    await waitFor(() => expect(api.getNurtureCampaign).toHaveBeenCalledWith("roland", ENR_A));
  });

  it("paused because the patient replied: says so, and offers no second 'Patient replied'", async () => {
    api.getCaseNurture.mockResolvedValue({
      enabled: true,
      enrollments: [libraryEnrollment({ status: "paused", stopReason: "patient_replied" })],
      tracks: TRACKS,
    } satisfies NurtureCaseResponse);
    wrap(<NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />);
    expect((await screen.findByTestId("nurture-chip-paused")).textContent).toMatch(/^Paused: the patient replied\. Its emails wait as they are and nothing is cancelled\./);
    expect(screen.queryByTestId("nurture-replied")).toBeNull();
  });
});

describe("the outbox on library campaigns", () => {
  it("lists each campaign per case with its needs-approval count and opens Review; hand-written drafts stay in their group", async () => {
    api.getNurtureOutbox.mockResolvedValue(outboxWithCampaigns());
    wrap(<NurtureOutbox office="roland" />);
    const campaigns = await screen.findAllByTestId("outbox-campaign");
    expect(campaigns).toHaveLength(2);
    expect(within(campaigns[0]).getByTestId("outbox-campaign-needs").textContent).toBe("7 need approval");
    expect(within(campaigns[1]).getByTestId("outbox-campaign-needs").textContent).toBe("5 need approval");
    expect(screen.getByTestId("outbox-auto-send-note").textContent).toContain(NURTURE_AUTOMATIC_SENDING_NOTE);
    expect(within(campaigns[0]).getAllByTestId("outbox-campaign-email")).toHaveLength(3);
    expect(screen.getAllByTestId("outbox-draft")).toHaveLength(1);
    fireEvent.click(within(campaigns[1]).getByTestId("outbox-campaign-review"));
    await waitFor(() => expect(api.getNurtureCampaign).toHaveBeenCalledWith("roland", "77777777-7777-4777-8777-777777777777"));
  });
});
