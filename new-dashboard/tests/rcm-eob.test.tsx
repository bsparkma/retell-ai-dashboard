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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  /** How many times the panel has asked the server for the list. */
  listCalls: 0,
}));

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    listEobUploads: vi.fn(async (office: string) => {
      eobState.listCalls += 1;
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

/** Flip the tab between foreground and background, the way a browser would. */
function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  setVisibility("visible");
  eobState.uploads = [];
  eobState.listError = null;
  eobState.uploadError = null;
  eobState.uploadResult = { office: "roland", duplicate: false, upload: upload() };
  eobState.calls = [];
  eobState.listCalls = 0;
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

/**
 * The staging bug (2026-08-17): extraction finished in 3.7 seconds, the row went
 * to `extracted`, and the chip still read "Extracting" an hour later — because
 * the panel fetched twice, on mount and after the upload, and the second fetch
 * landed ~2s too early. Nothing on the server lied. The page just stopped asking.
 *
 * What these pin is BOTH halves of the fix: that it keeps asking while an answer
 * is genuinely coming, and — the part that protects everyone else — that it
 * stops. The limiter allows 600 requests per 15 minutes per signed-in user, and
 * a standing timer on an open tab is exactly how the 2026-08-12 429 incident
 * happened.
 */
describe("EOB upload panel — waiting for extraction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Let mount effects and any already-due timers settle. */
  async function settle(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("keeps checking while a document is extracting, and stops once it settles", async () => {
    eobState.uploads = [upload({ status: "processing" })];
    render(<EobUploadPanel office="roland" />);
    await settle();
    expect(eobState.listCalls).toBe(1);
    expect(screen.getByTestId("rcm-eob-status-u1").textContent).toBe("Extracting");

    await settle(3_000);
    expect(eobState.listCalls).toBe(2);

    // The server finishes. The next poll sees it — and is the last one.
    eobState.uploads = [upload({ status: "extracted", resultClaimId: "claim-1" })];
    await settle(3_000);
    expect(eobState.listCalls).toBe(3);
    expect(screen.getByTestId("rcm-eob-status-u1").textContent).toBe("Proposal ready");

    await settle(60_000);
    expect(eobState.listCalls).toBe(3);
  });

  it("does not poll at all when every document is already settled", async () => {
    eobState.uploads = [
      upload({ uploadId: "a", status: "extracted" }),
      upload({ uploadId: "b", status: "failed", message: "boom" }),
    ];
    render(<EobUploadPanel office="roland" />);
    await settle();
    expect(eobState.listCalls).toBe(1);

    await settle(5 * 60_000);
    expect(eobState.listCalls).toBe(1);
  });

  it("does not poll a document the cost cap has parked — that waits on a clock", async () => {
    eobState.extraction = { ...eobState.extraction, paused: true, usedCents: 1000, remainingCents: 0 };
    eobState.uploads = [
      upload({
        status: "uploaded",
        message: "Extraction paused — the daily cost cap of $10.00 is used up.",
      }),
    ];
    render(<EobUploadPanel office="roland" />);
    await settle();
    expect(screen.getByTestId("rcm-eob-paused-roland")).toBeTruthy();
    expect(eobState.listCalls).toBe(1);

    // The cap resets at local midnight. Asking every three seconds until then
    // would spend a user's entire rate-limit budget learning nothing.
    await settle(5 * 60_000);
    expect(eobState.listCalls).toBe(1);
  });

  it("backs off after the first 30 seconds instead of holding 3s for five minutes", async () => {
    eobState.uploads = [upload({ status: "processing" })];
    render(<EobUploadPanel office="roland" />);
    await settle();

    // Fast phase: one every 3s. Stepped tick by tick because each response is
    // what arms the next request — that is the point of the design.
    for (let i = 0; i < 10; i += 1) await settle(3_000);
    expect(eobState.listCalls).toBe(11);

    // Slow phase: one every 10s, not three more per 10s.
    await settle(10_000);
    expect(eobState.listCalls).toBe(12);
    await settle(9_000);
    expect(eobState.listCalls).toBe(12);
  });

  it("stops after five minutes and SAYS it stopped, with a way to look again", async () => {
    eobState.uploads = [upload({ status: "processing" })];
    render(<EobUploadPanel office="roland" />);
    await settle();
    expect(screen.queryByTestId("rcm-eob-stalled-roland")).toBeNull();

    for (let i = 0; i < 10; i += 1) await settle(3_000); // 0 → 30s, fast phase
    for (let i = 0; i < 27; i += 1) await settle(10_000); // 30s → 5min, slow phase
    const stalled = screen.getByTestId("rcm-eob-stalled-roland");
    expect(stalled.textContent).toContain("stopped checking");
    const spent = eobState.listCalls;

    // And it really has stopped — no further requests once it gave up.
    await settle(5 * 60_000);
    expect(eobState.listCalls).toBe(spent);

    // The manual escape hatch restarts the run.
    eobState.uploads = [upload({ status: "extracted", resultClaimId: "claim-1" })];
    await act(async () => {
      fireEvent.click(screen.getByTestId("rcm-eob-recheck-roland"));
    });
    expect(eobState.listCalls).toBe(spent + 1);
    expect(screen.queryByTestId("rcm-eob-stalled-roland")).toBeNull();
    expect(screen.getByTestId("rcm-eob-status-u1").textContent).toBe("Proposal ready");
  });

  it("pauses while the tab is hidden and picks up when it comes back", async () => {
    eobState.uploads = [upload({ status: "processing" })];
    render(<EobUploadPanel office="roland" />);
    await settle();
    expect(eobState.listCalls).toBe(1);

    setVisibility("hidden");
    await settle(60_000);
    expect(eobState.listCalls).toBe(1);

    setVisibility("visible");
    await settle(3_000);
    expect(eobState.listCalls).toBe(2);
  });

  it("stops polling when the panel goes away", async () => {
    eobState.uploads = [upload({ status: "processing" })];
    const view = render(<EobUploadPanel office="roland" />);
    await settle();
    expect(eobState.listCalls).toBe(1);

    view.unmount();
    await settle(60_000);
    expect(eobState.listCalls).toBe(1);
  });
});
