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
import { checkPickedTime, sendWindowWords } from "@/features/tc/nurture/campaignCopy";
import { TcApiError } from "@/features/tc/api";
import { toast } from "sonner";

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

describe("Review campaign forms wait for the server (fix: a refused save must be visible)", () => {
  const open = () =>
    wrap(<NurtureCampaignReview office="roland" enrollmentId={ENR_A} open onOpenChange={() => {}} onChanged={() => {}} />);
  /** The campaign with email 4 (index 3) moved to `scheduledFor`. */
  const withEmail3At = (scheduledFor: string) =>
    campaignResponse({
      emails: campaignResponse().emails.map((x, i) => (i === 3 ? { ...x, message: { ...x.message, scheduledFor } } : x)),
    });
  /** A promise the test settles by hand, to look at the form while the request is in flight. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const openDateForm = async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    fireEvent.click(within(rows[3]).getByText("Change date"));
    return { rows, form: within(rows[3]).getByTestId("nurture-review-date-form") };
  };
  const pickIn = (form: HTMLElement, date: string, time: string) => {
    fireEvent.change(within(form).getByLabelText("Date"), { target: { value: date } });
    fireEvent.change(within(form).getByLabelText("Time (office)"), { target: { value: time } });
  };
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  const saveDate = (form: HTMLElement) => within(form).getByRole("button", { name: "Save date" }) as HTMLButtonElement;

  it("a refused reschedule keeps the form open, with the server's message inline and the picked values", async () => {
    const { rows, form } = await openDateForm();
    pickIn(form, "2026-12-11", "11:30");
    const refusal = deferred<never>();
    api.rescheduleNurtureEmail.mockReturnValue(refusal.promise);
    fireEvent.click(saveDate(form));
    // In flight: the form is still open, Save spins and is disabled.
    expect(within(rows[3]).getByTestId("nurture-review-date-form")).toBeTruthy();
    expect(saveDate(form).disabled).toBe(true);
    expect(saveDate(form).querySelector(".animate-spin")).not.toBeNull();
    refusal.reject(
      new TcApiError("Email 4 has to go after email 3 — the campaign keeps its order. Move that one first, or pick another time.", 409, "OUT_OF_ORDER", null, []),
    );
    const alert = await within(rows[3]).findByRole("alert");
    expect(alert.textContent).toMatch(/Not saved: Email 4 has to go after email 3/);
    const still = within(rows[3]).getByTestId("nurture-review-date-form");
    expect((within(still).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-12-11");
    expect((within(still).getByLabelText("Time (office)") as HTMLInputElement).value).toBe("11:30");
    // The row still shows the old time, and no toast pretended anything.
    expect(within(rows[3]).getByTestId("nurture-review-planned").textContent).toContain("Thu, Dec 10 · 10:00 AM");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // The message stays until the next attempt...
    api.rescheduleNurtureEmail.mockReturnValue(new Promise(() => {}));
    fireEvent.click(saveDate(still));
    await waitFor(() => expect(within(rows[3]).queryByRole("alert")).toBeNull());
  });

  it("Cancel clears a refusal and puts the row's own date back", async () => {
    const { rows, form } = await openDateForm();
    pickIn(form, "2026-12-11", "11:30");
    api.rescheduleNurtureEmail.mockRejectedValue(new TcApiError("That time would break the rule of 3 emails in 7 days.", 409, "CAP_WOULD_EXCEED", null, []));
    fireEvent.click(saveDate(form));
    await within(rows[3]).findByRole("alert");
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(within(rows[3]).queryByTestId("nurture-review-date-form")).toBeNull();
    fireEvent.click(within(rows[3]).getByText("Change date"));
    const again = within(rows[3]).getByTestId("nurture-review-date-form");
    expect(within(rows[3]).queryByRole("alert")).toBeNull();
    expect((within(again).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-12-10");
  });

  it("a refused edit keeps the typed text and says why inline", async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    fireEvent.click(within(rows[3]).getByText("Edit"));
    const typed = "Hi Test Patient,\n\nA shorter note.\n\nTest Coordinator";
    fireEvent.change(within(rows[3]).getByRole("textbox", { name: "Email text" }), { target: { value: typed } });
    fireEvent.change(within(rows[3]).getByRole("textbox", { name: "Subject" }), { target: { value: "A new subject" } });
    api.editDraft.mockRejectedValue(new TcApiError("This email is scheduled, so it can't be edited. Unapprove it first.", 409, "MESSAGE_NOT_EDITABLE", null, []));
    fireEvent.click(within(rows[3]).getByRole("button", { name: "Save" }));
    expect((await within(rows[3]).findByRole("alert")).textContent).toMatch(/Not saved: This email is scheduled/);
    expect(within(rows[3]).getByTestId("nurture-review-edit-form")).toBeTruthy();
    expect((within(rows[3]).getByRole("textbox", { name: "Email text" }) as HTMLTextAreaElement).value).toBe(typed);
    expect((within(rows[3]).getByRole("textbox", { name: "Subject" }) as HTMLInputElement).value).toBe("A new subject");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a Sunday pick says what it is, names Monday, and disables Save date", async () => {
    const { form } = await openDateForm();
    pickIn(form, "2026-11-29", "10:00");
    expect(within(form).getByTestId("nurture-review-pick-words").textContent).toBe("Sunday, Nov 29, 10:00 AM office time");
    expect(within(form).getByTestId("nurture-review-pick-problem").textContent).toBe(
      "Emails go out Monday to Friday, 9:00 AM to 4:00 PM office time. The next allowed time is Monday, Nov 30, 9:00 AM.",
    );
    expect(saveDate(form).disabled).toBe(true);
    fireEvent.click(saveDate(form));
    expect(api.rescheduleNurtureEmail).not.toHaveBeenCalled();
  });

  it("a 5:00 PM pick disables Save date and names the next morning that sends", async () => {
    const { form } = await openDateForm();
    pickIn(form, "2026-12-11", "17:00");
    expect(within(form).getByTestId("nurture-review-pick-words").textContent).toBe("Friday, Dec 11, 5:00 PM office time");
    expect(within(form).getByTestId("nurture-review-pick-problem").textContent).toContain("The next allowed time is Monday, Dec 14, 9:00 AM.");
    expect(saveDate(form).disabled).toBe(true);
  });

  it("a valid pick enables Save date; success closes the form and the new time is highlighted", async () => {
    const { rows, form } = await openDateForm();
    pickIn(form, "2026-12-11", "11:30");
    expect(within(form).getByTestId("nurture-review-pick-words").textContent).toBe("Friday, Dec 11, 11:30 AM office time");
    expect(within(form).queryByTestId("nurture-review-pick-problem")).toBeNull();
    expect(saveDate(form).disabled).toBe(false);
    const ok = deferred<ReturnType<typeof message>>();
    api.rescheduleNurtureEmail.mockReturnValue(ok.promise);
    // 2026-12-11 11:30 Chicago (CST) is 17:30Z.
    api.getNurtureCampaign.mockResolvedValue(withEmail3At("2026-12-11T17:30:00.000Z"));
    fireEvent.click(saveDate(form));
    expect(within(rows[3]).getByTestId("nurture-review-date-form")).toBeTruthy();
    ok.resolve(message(3, { scheduledFor: "2026-12-11T17:30:00.000Z" }));
    await waitFor(() => expect(within(rows[3]).queryByTestId("nurture-review-date-form")).toBeNull());
    const planned = within(rows[3]).getByTestId("nurture-review-planned");
    expect(planned.textContent).toContain("Fri, Dec 11 · 11:30 AM");
    expect(planned.getAttribute("data-flash")).toBe("true");
    expect(toast.success).toHaveBeenCalledWith("Planned time changed.");
  });

  it("a successful edit closes the form and highlights the new text", async () => {
    open();
    const rows = await screen.findAllByTestId("nurture-review-email");
    fireEvent.click(within(rows[3]).getByText("Edit"));
    const typed = "Hi Test Patient,\n\nA shorter note.";
    fireEvent.change(within(rows[3]).getByRole("textbox", { name: "Email text" }), { target: { value: typed } });
    api.editDraft.mockResolvedValue(message(3, { body: typed }));
    api.getNurtureCampaign.mockResolvedValue(
      campaignResponse({
        emails: campaignResponse().emails.map((x, i) => (i === 3 ? { ...x, message: { ...x.message, body: typed } } : x)),
      }),
    );
    fireEvent.click(within(rows[3]).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(rows[3]).queryByTestId("nurture-review-edit-form")).toBeNull());
    const shown = within(rows[3]).getByTestId("nurture-review-body");
    expect(shown.textContent).toBe(typed);
    expect(shown.getAttribute("data-flash")).toBe("true");
  });

  it("the date inputs re-seed after a reload brings a new planned time", async () => {
    const { rows, form } = await openDateForm();
    expect((within(form).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-12-10");
    // Something else reloads the campaign (an approval here) while the form is open,
    // and the server has moved email 4 to Mon Dec 14 09:00 (15:00Z).
    api.approveNurtureEmail.mockResolvedValue({ message: message(3, { status: "scheduled" }), replanned: 0 });
    api.getNurtureCampaign.mockResolvedValue(withEmail3At("2026-12-14T15:00:00.000Z"));
    fireEvent.click(within(rows[3]).getByTestId("nurture-review-approve"));
    await waitFor(() => expect(within(rows[3]).getByTestId("nurture-review-planned").textContent).toContain("Mon, Dec 14 · 9:00 AM"));
    const now = within(rows[3]).getByTestId("nurture-review-date-form");
    expect((within(now).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-12-14");
    expect((within(now).getByLabelText("Time (office)") as HTMLInputElement).value).toBe("09:00");
  });

  it("a double click on Save date sends one request", async () => {
    const { form } = await openDateForm();
    pickIn(form, "2026-12-11", "11:30");
    api.rescheduleNurtureEmail.mockReturnValue(new Promise(() => {}));
    const button = saveDate(form);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(api.rescheduleNurtureEmail).toHaveBeenCalledTimes(1));
  });
});

describe("checkPickedTime (pure, office time, no clock)", () => {
  it.each([
    ["2026-12-11", "16:00", true, null],
    ["2026-12-11", "09:00", true, null],
    ["2026-12-11", "16:01", false, "Monday, Dec 14, 9:00 AM"],
    ["2026-12-14", "08:59", false, "Monday, Dec 14, 9:00 AM"],
    ["2026-12-12", "12:00", false, "Monday, Dec 14, 9:00 AM"],
    ["2026-12-09", "23:30", false, "Thursday, Dec 10, 9:00 AM"],
    ["2026-11-01", "10:00", false, "Monday, Nov 2, 9:00 AM"],
  ])("%s %s → in window %s, next %s", (date, time, inWindow, next) => {
    const r = checkPickedTime(date, time);
    expect(r.inWindow).toBe(inWindow);
    if (next) expect(r.problem).toContain(`The next allowed time is ${next}.`);
    else expect(r.problem).toBeNull();
  });

  it("says nothing about an incomplete or impossible pick", () => {
    expect(checkPickedTime("", "10:00")).toEqual({ words: null, inWindow: false, problem: null });
    expect(checkPickedTime("2026-02-30", "10:00")).toEqual({ words: null, inWindow: false, problem: null });
    expect(checkPickedTime("2026-12-11", "")).toEqual({ words: null, inWindow: false, problem: null });
  });

  it("reads the window off the shared contract", () => {
    expect(sendWindowWords()).toBe("Monday to Friday, 9:00 AM to 4:00 PM office time");
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
