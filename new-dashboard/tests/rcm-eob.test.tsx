/**
 * The EOB upload affordance on /rcm (Slice 4) — client side.
 *
 * What this pins is the honesty of the states, because the states are the whole
 * product at this stage:
 *   - "Proposal ready", never "posted" — nothing in this slice writes a chart;
 *   - a tripped cost cap reads as PAUSED, with the reset time, not as an error;
 *   - a failed upload shows the server's reason, not a generic apology;
 *   - a re-submission says which of the three things happened;
 *   - the office each panel uploads to is the office it was rendered for.
 *
 * The backend gate is the source of truth (backend/routes/rcm/eobRoutes.test.js);
 * this is about what a person is told.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Classic JSX runtime under vitest — same shim the other .tsx suites use.
(globalThis as Record<string, unknown>).React = React;

const eobState = vi.hoisted(() => ({
  uploads: [] as unknown[],
  extraction: {
    paused: false,
    usedCents: 125,
    capCents: 1000,
    remainingCents: 875,
    resetsAt: "2026-08-15T05:00:00.000Z",
    timezone: "America/Chicago",
    persisted: true,
  } as Record<string, unknown>,
  listError: null as Error | null,
  uploadResult: null as unknown,
  uploadError: null as Error | null,
  calls: [] as Array<{ office: string; filename: string }>,
}));

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    listEobUploads: vi.fn(async (office: string) => {
      if (eobState.listError) throw eobState.listError;
      return {
        office,
        uploads: eobState.uploads,
        total: eobState.uploads.length,
        limit: 25,
        offset: 0,
        extraction: eobState.extraction,
      };
    }),
    uploadEob: vi.fn(async (office: string, file: File) => {
      eobState.calls.push({ office, filename: file.name });
      if (eobState.uploadError) throw eobState.uploadError;
      return eobState.uploadResult;
    }),
  };
});

import EobUploadPanel from "@/pages/rcm/EobUploadPanel";
import { RcmApiError } from "@/features/rcm/api";

/** One upload row, with only the fields a test cares about spelled out. */
function upload(over: Record<string, unknown> = {}) {
  return {
    uploadId: "u1",
    officeId: "roland",
    filename: "remittance.pdf",
    fileSizeBytes: 24_576,
    status: "uploaded",
    message: null,
    resultClaimId: null,
    resultBatchId: null,
    uploadedAt: "2026-08-14T14:00:00.000Z",
    processedAt: null,
    ...over,
  };
}

/** Drive the hidden file input the way a file picker would. */
function pick(office: string, name = "remittance.pdf") {
  const input = screen.getByTestId(`rcm-eob-input-${office}`) as HTMLInputElement;
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: "application/pdf",
  });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  eobState.uploads = [];
  eobState.listError = null;
  eobState.uploadError = null;
  eobState.uploadResult = { office: "roland", duplicate: false, upload: upload() };
  eobState.calls = [];
  eobState.extraction = {
    paused: false,
    usedCents: 125,
    capCents: 1000,
    remainingCents: 875,
    resetsAt: "2026-08-15T05:00:00.000Z",
    timezone: "America/Chicago",
    persisted: true,
  };
});

afterEach(() => cleanup());

describe("EOB upload panel", () => {
  it("offers a drop zone and a file picker for its office", async () => {
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-panel-roland")).toBeTruthy());
    expect(screen.getByTestId("rcm-eob-dropzone-roland")).toBeTruthy();
    expect(screen.getByTestId("rcm-eob-input-roland")).toBeTruthy();
    expect(screen.getByText(/PDF only, up to 25MB/)).toBeTruthy();
  });

  it("says nothing is here yet, rather than showing an empty box", async () => {
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-empty-roland")).toBeTruthy());
    expect(screen.getByTestId("rcm-eob-empty-roland").textContent).toContain(
      "No EOB documents uploaded",
    );
  });

  it("uploads to the office it was rendered for", async () => {
    render(<EobUploadPanel office="valley" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-empty-valley")).toBeTruthy());
    pick("valley");
    await waitFor(() => expect(eobState.calls.length).toBe(1));
    expect(eobState.calls[0].office).toBe("valley");
  });

  it("labels an extracted upload a PROPOSAL, never posted", async () => {
    eobState.uploads = [upload({ status: "extracted", resultClaimId: "claim-1" })];
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-status-u1")).toBeTruthy());
    const chip = screen.getByTestId("rcm-eob-status-u1").textContent ?? "";
    expect(chip).toBe("Proposal ready");
    // Nothing in this slice writes to a chart, so nothing may say it did.
    expect(screen.getByTestId("rcm-eob-panel-roland").textContent).not.toMatch(/posted/i);
  });

  it("renders a chip for every status", async () => {
    eobState.uploads = [
      upload({ uploadId: "a", status: "uploaded" }),
      upload({ uploadId: "b", status: "processing" }),
      upload({ uploadId: "c", status: "extracted" }),
      upload({ uploadId: "d", status: "failed", message: "boom" }),
    ];
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-status-a")).toBeTruthy());
    expect(screen.getByTestId("rcm-eob-status-a").textContent).toBe("Waiting");
    expect(screen.getByTestId("rcm-eob-status-b").textContent).toBe("Extracting");
    expect(screen.getByTestId("rcm-eob-status-c").textContent).toBe("Proposal ready");
    expect(screen.getByTestId("rcm-eob-status-d").textContent).toBe("Failed");
  });

  it("shows a failure's own reason, not a generic apology", async () => {
    eobState.uploads = [
      upload({
        status: "failed",
        message:
          "This PDF has no extractable text layer — it is most likely a scanned image. " +
          "Upload a text PDF exported from the payer portal, or enter this EOB manually.",
      }),
    ];
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-message-u1")).toBeTruthy());
    expect(screen.getByTestId("rcm-eob-message-u1").textContent).toContain("scanned image");
  });

  it("reads a tripped cost cap as PAUSED, with the reset time — not as an error", async () => {
    eobState.extraction = {
      ...eobState.extraction,
      paused: true,
      usedCents: 1000,
      remainingCents: 0,
    };
    eobState.uploads = [upload({ status: "uploaded", message: "Extraction paused — the daily cost cap of $10.00 is used up." })];
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-paused-roland")).toBeTruthy());
    const banner = screen.getByTestId("rcm-eob-paused-roland").textContent ?? "";
    expect(banner).toContain("Extraction paused");
    expect(banner).toContain("$10.00");
    expect(banner).toContain("Uploads are still accepted");
    // A paused document is Waiting, not Failed.
    expect(screen.getByTestId("rcm-eob-status-u1").textContent).toBe("Waiting");
    // And no error state is shown — a spent cap is not a failure.
    expect(screen.queryByTestId("rcm-eob-error-roland")).toBeNull();
  });

  it("shows today's spend when the cap is not reached", async () => {
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-spend-roland")).toBeTruthy());
    expect(screen.getByTestId("rcm-eob-spend-roland").textContent).toContain("$1.25 of $10.00");
  });

  it("distinguishes a new upload, a duplicate, and a re-queued retry", async () => {
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-empty-roland")).toBeTruthy());

    pick("roland");
    await waitFor(() =>
      expect(screen.getByTestId("rcm-eob-notice-roland").textContent).toBe("Uploaded."),
    );

    eobState.uploadResult = { office: "roland", duplicate: true, upload: upload({ status: "extracted" }) };
    pick("roland");
    await waitFor(() =>
      expect(screen.getByTestId("rcm-eob-notice-roland").textContent).toContain("already on file"),
    );

    eobState.uploadResult = {
      office: "roland",
      duplicate: true,
      requeued: true,
      upload: upload({ status: "uploaded" }),
    };
    pick("roland");
    await waitFor(() =>
      expect(screen.getByTestId("rcm-eob-notice-roland").textContent).toContain(
        "queued for another extraction attempt",
      ),
    );
  });

  it("surfaces a rejected upload's server message", async () => {
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-empty-roland")).toBeTruthy());

    eobState.uploadError = new RcmApiError("That file is not a PDF. Upload the EOB as a PDF.", 415, "NOT_A_PDF");
    pick("roland", "scan.png");
    await waitFor(() =>
      expect(screen.getByTestId("rcm-eob-notice-roland").textContent).toContain("not a PDF"),
    );
  });

  it("reports MODULE_NOT_ENTITLED as itself", async () => {
    eobState.listError = new RcmApiError("MODULE_NOT_ENTITLED", 403, "MODULE_NOT_ENTITLED");
    render(<EobUploadPanel office="roland" />);
    await waitFor(() => expect(screen.getByTestId("rcm-eob-error-roland")).toBeTruthy());
    expect(screen.getByTestId("rcm-eob-error-roland").textContent).toContain(
      "not set up for the RCM module",
    );
  });
});
