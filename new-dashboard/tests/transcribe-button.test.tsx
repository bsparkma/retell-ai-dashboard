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
import type { TranscribeResult } from "@/lib/api";

/** The smallest thing that behaves like both real placements. */
function TranscribeButton({ onResult }: { onResult?: (id: string, r: TranscribeResult) => void }) {
  const transcribe = useTranscribeCall(onResult);
  const running = transcribe.isRunning("call-1");
  return (
    <button disabled={running} onClick={() => transcribe.run("call-1")}>
      {running ? "Transcribing…" : "Transcribe & Summarize"}
    </button>
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
