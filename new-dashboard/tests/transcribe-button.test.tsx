/**
 * The "Transcribe & Summarize" button, end to end in jsdom (Mango slice M4).
 *
 * lib/transcribe.ts is tested separately as pure logic; what is pinned HERE is the part a
 * user can actually get wrong — the in-flight behaviour of the real hook driving a real
 * button:
 *
 *   - idle → "Transcribing…" and DISABLED while the request is in flight;
 *   - a second click during a run is a silent no-op, never a second request and never an
 *     error toast (the honest-states rule);
 *   - success is announced only after the request resolves, never optimistically;
 *   - each refusal produces its own message, and leaves the button usable again.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform, while the app's Vite build
// uses the automatic runtime — so component modules never import React themselves.
(globalThis as Record<string, unknown>).React = React;

const toasts = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; text: string }> }));
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.calls.push({ kind: "success", text }),
    info: (text: string) => toasts.calls.push({ kind: "info", text }),
    error: (text: string) => toasts.calls.push({ kind: "error", text }),
  },
}));

const transcribeMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, transcribeMangoCall: transcribeMock.fn } };
});

import { useTranscribeCall } from "@/hooks/useTranscribeCall";
import { needsRebillConfirm, REBILL_CONFIRM_BODY, REBILL_CONFIRM_ACCEPT, REBILL_CONFIRM_CANCEL } from "@/lib/transcribe";
import { TranscribeRebillDialog } from "@/components/calls/TranscribeRebillDialog";
import type { TranscribeResult } from "@/lib/api";

/**
 * The smallest thing that behaves like both real placements: a button that goes through
 * `request` (so the re-bill gate applies) plus the shared confirmation dialog.
 */
function TranscribeButton({
  onResult, lastOutcome,
}: {
  onResult?: (id: string, r: TranscribeResult) => void;
  lastOutcome?: string | null;
}) {
  const transcribe = useTranscribeCall(onResult);
  const running = transcribe.isRunning("call-1");
  return (
    <>
      <button disabled={running} onClick={() => transcribe.request("call-1", lastOutcome)}>
        {running
          ? "Transcribing…"
          : needsRebillConfirm(lastOutcome)
          ? "No speech detected"
          : "Transcribe & Summarize"}
      </button>
      <TranscribeRebillDialog
        open={transcribe.pendingConfirm !== null}
        onConfirm={transcribe.confirm}
        onCancel={transcribe.cancelConfirm}
      />
    </>
  );
}

/** A promise we resolve by hand, so "in flight" is a state the test can hold open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  toasts.calls = [];
  transcribeMock.fn.mockReset();
});
afterEach(cleanup);

describe("in-flight behaviour", () => {
  it("shows Transcribing… and disables the button while the request is in flight", async () => {
    const gate = deferred<TranscribeResult>();
    transcribeMock.fn.mockReturnValue(gate.promise);

    render(<TranscribeButton />);
    const button = screen.getByRole("button");
    expect(button.hasAttribute("disabled")).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button").textContent).toContain("Transcribing"));
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
    expect(toasts.calls, "nothing is announced before the server answers").toHaveLength(0);

    gate.resolve({ status: "completed", transcript: "hi", minutesUsed: 1.5 });
    await waitFor(() => expect(screen.getByRole("button").textContent).toContain("Transcribe"));
  });

  it("a second click during a run does NOTHING — no second request, no error", async () => {
    const gate = deferred<TranscribeResult>();
    transcribeMock.fn.mockReturnValue(gate.promise);

    render(<TranscribeButton />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true));

    // Click straight through the disabled attribute, as a determined double-click would.
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));

    expect(transcribeMock.fn).toHaveBeenCalledTimes(1);
    expect(toasts.calls).toHaveLength(0);

    gate.resolve({ status: "completed", minutesUsed: 1 });
    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledTimes(1));
  });

  it("the button is usable again after the run, whatever the outcome", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "recording_not_ready" } as TranscribeResult);

    render(<TranscribeButton />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledTimes(2));
  });
});

describe("outcome announcements", () => {
  it("announces success only after the server confirms it", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed", minutesUsed: 2.25 } as TranscribeResult);

    render(<TranscribeButton />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0].kind).toBe("success");
    expect(toasts.calls[0].text).toContain("2.3 min");
  });

  it("budget exhaustion tells the user when it resets", async () => {
    transcribeMock.fn.mockResolvedValue({
      status: "budget_exhausted",
      resetsAt: "2026-08-07T05:00:00.000Z",
    } as TranscribeResult);

    render(<TranscribeButton />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0].kind).toBe("error");
    expect(toasts.calls[0].text).toContain("Daily transcription budget is used up");
    expect(toasts.calls[0].text).toMatch(/resets at \d{1,2}:\d{2}/);
  });

  it("a network failure is reported as an error, never as a silent success", async () => {
    transcribeMock.fn.mockRejectedValue(new Error("offline"));

    const seen: TranscribeResult[] = [];
    render(<TranscribeButton onResult={(_id, r) => seen.push(r)} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0].kind).toBe("error");
    expect(toasts.calls[0].text).toContain("nothing was saved");
    expect(seen[0].status).toBe("error");
  });

  it("no_speech is announced and reported back so the row can remember it", async () => {
    const seen: TranscribeResult[] = [];
    transcribeMock.fn.mockResolvedValue({ status: "no_speech", alreadyBilled: true } as TranscribeResult);

    render(<TranscribeButton onResult={(_id, r) => seen.push(r)} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0].kind).toBe("error");
    expect(toasts.calls[0].text).toContain("No speech was detected");
    expect(seen[0].alreadyBilled).toBe(true);
  });

  it("only completed/exists hand a transcript back to the caller", async () => {
    const seen: Array<{ id: string; r: TranscribeResult }> = [];
    transcribeMock.fn.mockResolvedValue({ status: "exists", transcript: "already here" } as TranscribeResult);

    render(<TranscribeButton onResult={(id, r) => seen.push({ id, r })} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].id).toBe("call-1");
    expect(seen[0].r.transcript).toBe("already here");
    expect(toasts.calls[0].kind).toBe("info");
  });
});

describe("re-bill confirmation for a silent call", () => {
  it("a first click on a NEVER-billed call runs straight away — no ceremony", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed", minutesUsed: 1 } as TranscribeResult);

    render(<TranscribeButton lastOutcome={null} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(REBILL_CONFIRM_BODY)).toBeNull();
  });

  it("a call that already came back silent shows its state and ASKS before spending", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed", minutesUsed: 1 } as TranscribeResult);

    render(<TranscribeButton lastOutcome="no_speech" />);
    expect(screen.getByRole("button").textContent).toContain("No speech detected");

    fireEvent.click(screen.getByRole("button"));

    // The dialog is up and NOTHING has been spent yet.
    await waitFor(() => expect(screen.getByText(REBILL_CONFIRM_BODY)).toBeTruthy());
    expect(transcribeMock.fn).not.toHaveBeenCalled();
  });

  it("cancelling spends nothing — the misclick this exists to stop", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed", minutesUsed: 1 } as TranscribeResult);

    render(<TranscribeButton lastOutcome="no_speech" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText(REBILL_CONFIRM_BODY)).toBeTruthy());

    fireEvent.click(screen.getByText(REBILL_CONFIRM_CANCEL));

    await waitFor(() => expect(screen.queryByText(REBILL_CONFIRM_BODY)).toBeNull());
    expect(transcribeMock.fn).not.toHaveBeenCalled();
    expect(toasts.calls).toHaveLength(0);
  });

  it("confirming DOES spend — this is a guard rail, not a lockout", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed", minutesUsed: 1 } as TranscribeResult);

    render(<TranscribeButton lastOutcome="no_speech" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText(REBILL_CONFIRM_BODY)).toBeTruthy());

    fireEvent.click(screen.getByText(REBILL_CONFIRM_ACCEPT));

    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledTimes(1));
    expect(transcribeMock.fn).toHaveBeenCalledWith("call-1");
    await waitFor(() => expect(toasts.calls[0].kind).toBe("success"));
  });

  it("repeated clicks while the dialog is open never queue up extra spend", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed", minutesUsed: 1 } as TranscribeResult);

    render(<TranscribeButton lastOutcome="no_speech" />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(REBILL_CONFIRM_BODY)).toBeTruthy());
    fireEvent.click(button);
    fireEvent.click(button);

    fireEvent.click(screen.getByText(REBILL_CONFIRM_ACCEPT));
    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledTimes(1));
  });
});
