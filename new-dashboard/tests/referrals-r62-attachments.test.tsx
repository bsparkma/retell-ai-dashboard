/**
 * R6.2 (A) — adding files from the edit surfaces, in jsdom.
 *
 *  - The hub's staff edit (draft / awaiting sign-off) offers "Add files"; the
 *    upload goes through the TC route (the R4 call, no `signoff` flag) and the
 *    list shown afterwards is the one RE-READ from the server.
 *  - A reopen (approved → re-approval) offers no files: approved is not a
 *    status staff may attach in.
 *  - (The doctor's sign-off edit — "Add files" through the sign-off route,
 *    only while editing — moved with the sign-off page into the hub:
 *    tests/referrals-signoff-in-hub.test.tsx.)
 *  - A failed upload is named; nothing reads as attached that the server did
 *    not store.
 *
 * NO NETWORK, NO BLOB STORE (the referrals API is mocked whole), NOTHING
 * SENDS, NO PHI (test patient 12827).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TcReferral, TcReferralAttachment } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    listDirectory: vi.fn(),
    editReferralFields: vi.fn(),
    reopenReferral: vi.fn(),
    markReferral: vi.fn(),
    referralVerb: vi.fn(),
    sendReferralEmail: vi.fn(),
    listSignoffQueue: vi.fn(),
    getSignoffReferral: vi.fn(),
    listSignoffDirectory: vi.fn(),
    doctorEditReferral: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    returnReferral: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { HubDetail } from "@/pages/tc/TcReferralsHub";
import { TcApiError } from "@/features/tc/api";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: RID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "case",
    sourceRef: "",
    referringProvider: "",
    directoryEntryId: null,
    practiceName: null,
    specialty: "",
    reason: "Possible cracked tooth",
    teeth: [],
    urgency: "routine",
    narrative: "",
    status: "draft",
    statusChangedAt: "2026-10-20T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-20T15:00:00.000Z",
    updatedAt: "2026-10-20T15:00:00.000Z",
    doctorNote: null,
    returned: null,
    events: [],
    ...over,
  };
}

function stored(n: number, by = "tc@carein.ai"): TcReferralAttachment {
  return {
    attachmentId: `${n}a1c2d3e-4f50-4a61-8b72-938495a6b7c8`,
    referralId: RID,
    fileName: `xray-${n}.png`,
    contentType: "image/png",
    sizeBytes: 1024,
    uploadedBy: by,
    uploadedAt: "2026-10-20T16:00:00.000Z",
  };
}

const png = (name = "xray.png") => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, { type: "image/png" });

function addFile(container: HTMLElement, file: File) {
  const input = within(container).getByTestId("referral-attachment-input") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  ref.listDirectory.mockResolvedValue([]);
  ref.listSignoffDirectory.mockResolvedValue([]);
});
afterEach(() => cleanup());

async function openHub(detail: TcReferral) {
  ref.getReferral.mockResolvedValue(detail);
  render(<HubDetail office="roland" referralId={detail.referralId} onClose={() => undefined} onChanged={() => undefined} />);
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByTestId("tc-hub-actions");
  return panel;
}

describe("the hub's staff edit", () => {
  it.each(["draft", "pending_signoff"] as const)("%s: Edit offers Add files; the upload is the TC route and the list is re-read", async (status) => {
    ref.listReferralAttachments.mockResolvedValueOnce([]).mockResolvedValueOnce([stored(1)]);
    const panel = await openHub(referral({ status }));
    expect(within(panel).queryByTestId("referral-add-attachments")).toBeNull(); // only while editing
    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    const add = await within(panel).findByTestId("referral-add-attachments");

    const file = png();
    addFile(add, file);
    ref.uploadReferralAttachment.mockResolvedValue(stored(1));
    fireEvent.click(within(add).getByRole("button", { name: "Attach file" }));

    await waitFor(() => expect(ref.uploadReferralAttachment).toHaveBeenCalledWith("roland", RID, file));
    await waitFor(() => expect(ref.listReferralAttachments).toHaveBeenCalledTimes(2));
    expect(ref.listReferralAttachments).toHaveBeenLastCalledWith("roland", RID);
    expect(await within(panel).findByText("xray-1.png")).toBeTruthy();
    expect(toastMock.success).toHaveBeenCalledWith("File attached");
    expect(ref.sendReferralEmail).not.toHaveBeenCalled();
  });

  it("a refused upload is named, and nothing reads as attached", async () => {
    ref.listReferralAttachments.mockResolvedValue([]);
    const panel = await openHub(referral());
    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    const add = await within(panel).findByTestId("referral-add-attachments");
    addFile(add, png("scan.png"));
    ref.uploadReferralAttachment.mockRejectedValue(
      new TcApiError("A referral can carry at most 5 files.", 409, "ATTACHMENT_LIMIT", null, []),
    );
    fireEvent.click(within(add).getByRole("button", { name: "Attach file" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("scan.png was not attached: A referral can carry at most 5 files."));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(within(panel).queryByText("scan.png")).toBeNull();
  });

  it("the 5-file count includes what is already stored", async () => {
    ref.listReferralAttachments.mockResolvedValue([1, 2, 3, 4, 5].map((n) => stored(n)));
    const panel = await openHub(referral());
    await within(panel).findByText("xray-5.png");
    fireEvent.click(within(panel).getByRole("button", { name: /^Edit$/ }));
    const add = await within(panel).findByTestId("referral-add-attachments");
    expect(add.textContent).toContain("0 of 5 left");
    expect(within(add).getByRole("button", { name: /Attach files: drop, paste or choose/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("a reopen (approved → re-approval) offers no files: approved is not attachable", async () => {
    ref.listReferralAttachments.mockResolvedValue([]);
    const panel = await openHub(referral({ status: "approved" }));
    fireEvent.click(within(panel).getByRole("button", { name: /Edit \(re-approval needed\)/ }));
    await within(panel).findByTestId("referral-fields-form");
    expect(within(panel).queryByTestId("referral-add-attachments")).toBeNull();
  });
});
