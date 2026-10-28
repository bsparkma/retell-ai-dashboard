/**
 * R6.9a: the staff attachment window, widened so the specialist's returned
 * report or fax can be attached after the referral went out.
 *
 *   1. The mirror of the server's staff window: draft, awaiting sign-off,
 *      sent, acknowledged, patient seen. The standalone "Add files" box is for
 *      the three after send, to tc.full only.
 *   2. The hub panel draws "Add files" on sent / acknowledged / patient seen
 *      and the upload goes through the hub's own route; never on approved /
 *      closed / cancelled / declined, never through the sign-off reader,
 *      never to a doctor. Draft / awaiting sign-off still add files via Edit.
 *   3. The correspondence form offers its file after send too.
 *
 * Every API call is mocked: nothing uploads. Test patient only (roland 12827).
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
    uploadSignoffAttachment: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { HubDetail } from "@/pages/tc/TcReferralsHub";
import {
  HUB_STAFF_ATTACHABLE_STATUSES,
  hubCanAddFilesAfterSend,
  type HubViewer,
} from "@/features/tc/referrals/hubActions";
import { CORRESPONDENCE_FILE_LOCKED_COPY } from "@/features/tc/referrals/LogCorrespondence";
import {
  TcReferral as TcReferralSchema,
  TcReferralStatus as StatusEnum,
  type TcReferral,
  type TcReferralStatus,
} from "@shared/tc/referrals";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const CASE_ID = "1b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const TC: HubViewer = { tcFull: true, signoff: false };
const ADMIN: HubViewer = { tcFull: true, signoff: true };
const DOCTOR: HubViewer = { tcFull: false, signoff: true };

const AFTER_SEND: TcReferralStatus[] = ["sent", "acknowledged", "patient_seen"];
const SHUT: TcReferralStatus[] = ["approved", "closed", "cancelled", "declined"];

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
  contentType: "image/png" as const,
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

async function openDetail(detail: TcReferral, opts: { viewer?: HubViewer; reader?: "hub" | "signoff" } = {}) {
  ref.getReferral.mockResolvedValue(detail);
  ref.getSignoffReferral.mockResolvedValue(detail);
  render(
    <HubDetail
      office="roland"
      referralId={detail.referralId}
      onClose={() => undefined}
      onChanged={vi.fn()}
      viewer={opts.viewer ?? TC}
      reader={opts.reader ?? "hub"}
      signoffRequired
    />,
  );
  const panel = await screen.findByTestId("tc-hub-detail");
  await within(panel).findByTestId("tc-hub-actions");
  return panel;
}

const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

describe("1: the window, mirrored", () => {
  it("the staff window is draft, awaiting sign-off, sent, acknowledged, patient seen", () => {
    expect([...HUB_STAFF_ATTACHABLE_STATUSES]).toEqual(["draft", "pending_signoff", "sent", "acknowledged", "patient_seen"]);
  });

  it("the standalone box: after send only, tc.full only", () => {
    for (const s of StatusEnum.options) {
      const after = AFTER_SEND.includes(s);
      expect(hubCanAddFilesAfterSend(s, TC), s).toBe(after);
      expect(hubCanAddFilesAfterSend(s, ADMIN), s).toBe(after);
      expect(hubCanAddFilesAfterSend(s, DOCTOR), s).toBe(false);
    }
  });
});

describe("2: the hub panel", () => {
  for (const status of AFTER_SEND) {
    it(`${status}: "Add files" is drawn and uploads through the hub's own route`, async () => {
      ref.uploadReferralAttachment.mockResolvedValue(attachment(1));
      const panel = await openDetail(referral({ status }));
      const box = within(panel).getByTestId("referral-add-attachments");
      fireEvent.change(within(box).getByTestId("referral-attachment-input"), { target: { files: [png("report.png")] } });
      fireEvent.click(within(box).getByRole("button", { name: "Attach file" }));
      await waitFor(() => expect(ref.uploadReferralAttachment).toHaveBeenCalledTimes(1));
      expect(ref.uploadReferralAttachment.mock.calls[0][0]).toBe("roland");
      expect(ref.uploadReferralAttachment.mock.calls[0][1]).toBe(RID);
      expect(ref.uploadSignoffAttachment).not.toHaveBeenCalled();
      await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("File attached"));
      expect(within(panel).queryByRole("button", { name: /remove|delete/i })).toBeNull();
    });
  }

  for (const status of SHUT) {
    it(`${status}: no "Add files"`, async () => {
      const panel = await openDetail(referral({ status }));
      expect(within(panel).queryByTestId("referral-add-attachments")).toBeNull();
    });
  }

  it("draft / awaiting sign-off: no standalone box — files still go through Edit, as before", async () => {
    for (const status of ["draft", "pending_signoff"] as const) {
      const panel = await openDetail(referral({ status }));
      expect(within(panel).queryByTestId("referral-add-attachments")).toBeNull();
      cleanup();
    }
  });

  it("never to a doctor, never through the sign-off reader", async () => {
    let panel = await openDetail(referral({ status: "sent" }), { viewer: DOCTOR });
    expect(within(panel).queryByTestId("referral-add-attachments")).toBeNull();
    cleanup();
    panel = await openDetail(referral({ status: "sent" }), { viewer: ADMIN, reader: "signoff" });
    expect(within(panel).queryByTestId("referral-add-attachments")).toBeNull();
  });
});

describe("3: the correspondence form", () => {
  it("after send it offers its file (no locked sentence)", async () => {
    const panel = await openDetail(referral({ status: "acknowledged" }));
    fireEvent.click(within(panel).getByTestId("tc-hub-correspondence-open"));
    expect(within(panel).queryByTestId("tc-hub-correspondence-no-file")).toBeNull();
    expect(CORRESPONDENCE_FILE_LOCKED_COPY).toMatch(/^Files can be added only while a referral is a draft, awaiting sign-off, sent/);
  });
});
