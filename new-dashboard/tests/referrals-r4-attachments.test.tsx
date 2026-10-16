/**
 * Referrals R4 (queue item 55), in jsdom: the upload zone and the flows.
 *
 *  - AttachmentZone: the helper text is exactly the PM's; images + PDF only,
 *    10 MB each, at most 5 (counting files already attached) — a courtesy
 *    pre-check that names the file and the reason; drag, pick and paste.
 *  - ReferralsPanel: chosen files upload BEFORE the submit; a file that did
 *    not land keeps the referral a draft and says which and why.
 *  - Viewing a file goes through the audited route (openReferralAttachment)
 *    and opens it in a new tab; the sign-off page reads through the doctor's
 *    route.
 *
 * With TC_SHOTS=1 it also dumps the form with files chosen (tccheckout-12).
 * NO NETWORK, NO BACKEND, NO PHI (test patient 12827).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TcReferral, TcReferralAttachment } from "@shared/tc/referrals";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralsStatus: vi.fn(),
    listDirectory: vi.fn(),
    listReferrals: vi.fn(),
    createReferral: vi.fn(),
    updateReferral: vi.fn(),
    referralVerb: vi.fn(),
    uploadReferralAttachment: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    listSignoffQueue: vi.fn(),
    getSignoffReferral: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { AttachmentZone } from "@/features/tc/referrals/AttachmentZone";
import { ReferralsPanel } from "@/features/tc/referrals/ReferralsPanel";
import { SignoffInner } from "@/pages/tc/TcReferralSignoff";

const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function file(name: string, type: string, size = 2048): File {
  const f = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8",
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
    status: "draft",
    statusChangedAt: "2026-10-16T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-16T15:00:00.000Z",
    updatedAt: "2026-10-16T15:00:00.000Z",
    ...over,
  };
}

function attachment(over: Partial<TcReferralAttachment> = {}): TcReferralAttachment {
  return {
    attachmentId: "1c1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    referralId: referral().referralId,
    fileName: "pa-3.png",
    contentType: "image/png",
    sizeBytes: 2048,
    uploadedBy: "tc@carein.ai",
    uploadedAt: "2026-10-16T15:01:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ref.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
  ref.listDirectory.mockResolvedValue([]);
  ref.listReferrals.mockResolvedValue([]);
  ref.listReferralAttachments.mockResolvedValue([]);
});
afterEach(cleanup);

function Harness({ already = 0 }: { already?: number }) {
  const [files, setFiles] = React.useState<File[]>([]);
  return <AttachmentZone files={files} onChange={setFiles} alreadyAttached={already} />;
}

function drop(target: HTMLElement, files: File[]) {
  fireEvent.drop(target, { dataTransfer: { files } });
}

describe("the upload zone", () => {
  it("says exactly how to snip the X-ray", () => {
    render(<Harness />);
    expect(screen.getByTestId("referral-attachment-hint").textContent).toBe(
      "Press Win+Shift+S to snip the X-ray, then drag it here.",
    );
  });

  it("takes images and PDFs; names a refused file and why", () => {
    render(<Harness />);
    const zone = screen.getByRole("button", { name: /Attach files/ });
    drop(zone, [file("pa-3.png", "image/png"), file("letter.pdf", "application/pdf"), file("notes.txt", "text/plain")]);
    const pending = screen.getByTestId("referral-attachment-pending");
    expect(within(pending).getByText("pa-3.png")).toBeTruthy();
    expect(within(pending).getByText("letter.pdf")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("notes.txt isn't an image or a PDF.");
  });

  it("refuses a file over 10 MB", () => {
    render(<Harness />);
    drop(screen.getByRole("button", { name: /Attach files/ }), [file("ct.png", "image/png", 10 * 1024 * 1024 + 1)]);
    expect(screen.getByRole("alert").textContent).toBe("ct.png is larger than 10 MB.");
    expect(screen.queryByTestId("referral-attachment-pending")).toBeNull();
  });

  it("at most 5, counting what is already attached", () => {
    render(<Harness already={3} />);
    drop(screen.getByRole("button", { name: /Attach files/ }), [
      file("a.png", "image/png"),
      file("b.png", "image/png"),
      file("c.png", "image/png"),
    ]);
    expect(within(screen.getByTestId("referral-attachment-pending")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toBe("A referral can carry at most 5 files.");
  });

  it("a pasted snip (Win+Shift+S puts it on the clipboard) is taken too, and can be removed", () => {
    render(<Harness />);
    const zone = screen.getByRole("button", { name: /Attach files/ });
    fireEvent.paste(zone, { clipboardData: { files: [file("image.png", "image/png")] } });
    expect(within(screen.getByTestId("referral-attachment-pending")).getByText("image.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove image.png" }));
    expect(screen.queryByTestId("referral-attachment-pending")).toBeNull();
  });
});

describe("files on the case's referral form", () => {
  async function newReferralWithFile() {
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    fireEvent.click(await screen.findByRole("button", { name: /New referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Possible cracked tooth" } });
    drop(within(dialog).getByRole("button", { name: /Attach files/ }), [file("pa-3.png", "image/png")]);
    fireEvent.click(within(dialog).getByRole("button", { name: /Save & submit/ }));
  }

  it("uploads the X-ray BEFORE submitting, onto the saved referral", async () => {
    ref.createReferral.mockResolvedValue(referral());
    ref.uploadReferralAttachment.mockResolvedValue(attachment());
    ref.referralVerb.mockResolvedValue(referral({ status: "pending_signoff" }));
    await newReferralWithFile();
    await waitFor(() => expect(ref.referralVerb).toHaveBeenCalledWith("roland", referral().referralId, "submit"));
    expect(ref.uploadReferralAttachment).toHaveBeenCalledWith("roland", referral().referralId, expect.any(File));
    const uploadOrder = ref.uploadReferralAttachment.mock.invocationCallOrder[0];
    const submitOrder = ref.referralVerb.mock.invocationCallOrder[0];
    expect(uploadOrder).toBeLessThan(submitOrder);
  });

  it("a file that did not land keeps it a draft and says which and why", async () => {
    ref.createReferral.mockResolvedValue(referral());
    ref.uploadReferralAttachment.mockRejectedValue(new Error("Attachment storage isn't set up here yet. Nothing was saved."));
    await newReferralWithFile();
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "pa-3.png was not attached: Attachment storage isn't set up here yet. Nothing was saved.",
      ),
    );
    expect(ref.referralVerb).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("Kept as a draft so the missing file can be added before sign-off");
  });

  it("a referral's files are listed, and View goes through the audited route", async () => {
    ref.listReferrals.mockResolvedValue([referral({ status: "pending_signoff" })]);
    ref.listReferralAttachments.mockResolvedValue([attachment()]);
    ref.openReferralAttachment.mockResolvedValue("blob:fake-url");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const revoke = vi.fn();
    Object.assign(URL, { revokeObjectURL: revoke });
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    fireEvent.click(await screen.findByRole("button", { name: "View pa-3.png" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("blob:fake-url", "_blank", "noopener"));
    expect(ref.openReferralAttachment).toHaveBeenCalledWith("roland", referral().referralId, attachment().attachmentId);
    open.mockRestore();
  });
});

describe("the doctor sees the X-ray at sign-off", () => {
  it("lists the files through the sign-off route", async () => {
    const pending = referral({ status: "pending_signoff" });
    ref.listSignoffQueue.mockResolvedValue([pending]);
    ref.getSignoffReferral.mockResolvedValue({ ...pending, events: [] });
    ref.listReferralAttachments.mockResolvedValue([attachment()]);
    ref.openReferralAttachment.mockResolvedValue("blob:fake-url");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<SignoffInner office="roland" />);
    fireEvent.click(await screen.findByTestId("tc-signoff-row"));
    const detail = await screen.findByTestId("tc-signoff-detail");
    fireEvent.click(await within(detail).findByRole("button", { name: "View pa-3.png" }));
    expect(ref.listReferralAttachments).toHaveBeenCalledWith("roland", pending.referralId, true);
    await waitFor(() =>
      expect(ref.openReferralAttachment).toHaveBeenCalledWith("roland", pending.referralId, attachment().attachmentId, true),
    );
    open.mockRestore();
  });
});

const SHOOT = process.env.TC_SHOTS === "1";
describe.skipIf(!SHOOT)("attachments screenshot dump", () => {
  it("12 — the referral form with an X-ray and a PDF chosen", async () => {
    render(<ReferralsPanel office="roland" source={{ caseId: CASE_ID }} />);
    fireEvent.click(await screen.findByRole("button", { name: /New referral/ }));
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Possible cracked tooth, endo evaluation" } });
    fireEvent.change(within(dialog).getByLabelText("Teeth"), { target: { value: "3" } });
    drop(within(dialog).getByRole("button", { name: /Attach files/ }), [
      file("pa-3.png", "image/png", 812_000),
      file("perio-chart.pdf", "application/pdf", 240_000),
    ]);
    document.querySelectorAll("input").forEach((i) => i.setAttribute("value", i.value));
    const out = resolve(import.meta.dirname, ".shots");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-12-referral-attachments@1280x1100.html"), document.body.innerHTML, "utf8");
  });
});
