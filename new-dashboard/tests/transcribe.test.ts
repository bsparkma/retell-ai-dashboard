/**
 * On-demand transcription: the button state machine and the user-facing copy
 * (Mango slice M4).
 *
 * Both button placements read from lib/transcribe.ts, so these tests ARE the UI contract:
 * what ends a run, what leaves the call clickable, and exactly what each refusal says.
 * The wording matters as much as the states — the whole point of the slice is that a
 * refusal tells the front desk something actionable instead of showing an error blob.
 */
import { describe, it, expect } from "vitest";
import {
  nextButtonState,
  isTerminal,
  formatResetTime,
  transcribeFeedback,
  toastDuration,
} from "@/lib/transcribe";
import type { TranscribeResult, TranscribeStatus } from "@/lib/api";

const ALL_STATUSES: TranscribeStatus[] = [
  "completed", "exists", "in_progress", "recording_not_ready", "recording_unavailable",
  "no_speech", "budget_exhausted", "unavailable", "not_found", "error",
];

describe("button state machine", () => {
  it("only a server-confirmed, persisted transcript ends the run", () => {
    expect(nextButtonState("completed")).toBe("done");
    expect(nextButtonState("exists")).toBe("done");
  });

  it("every refusal returns to idle, so the call stays transcribable", () => {
    const refusals = ALL_STATUSES.filter((s) => s !== "completed" && s !== "exists");
    for (const status of refusals) {
      expect(nextButtonState(status), `${status} must not consume the button`).toBe("idle");
      expect(isTerminal(status)).toBe(false);
    }
  });

  it("a failed attempt never marks the call done — the M3 seam stays open", () => {
    expect(nextButtonState("error")).toBe("idle");
    expect(nextButtonState("budget_exhausted")).toBe("idle");
    expect(nextButtonState("recording_not_ready")).toBe("idle");
  });
});

describe("failure copy", () => {
  const feedbackFor = (result: TranscribeResult) => transcribeFeedback(result);

  it("budget: says it is used up, WHEN it resets, and what to do instead", () => {
    // 05:00Z = midnight CDT. Formatted in the viewer's locale/zone, so assert on the
    // structure and on the presence of a real clock time rather than a fixed string.
    const fb = feedbackFor({ status: "budget_exhausted", resetsAt: "2026-08-07T05:00:00.000Z" });
    expect(fb.kind).toBe("error");
    expect(fb.text).toContain("Daily transcription budget is used up");
    expect(fb.text).toMatch(/resets at \d{1,2}:\d{2}/);
    expect(fb.text).toContain("transcribe fewer calls");
  });

  it("budget: degrades to 'midnight' rather than 'Invalid Date' with a bad/missing reset", () => {
    expect(feedbackFor({ status: "budget_exhausted" }).text).toContain("resets at midnight");
    expect(feedbackFor({ status: "budget_exhausted", resetsAt: "not-a-date" }).text)
      .toContain("resets at midnight");
    expect(feedbackFor({ status: "budget_exhausted", resetsAt: "not-a-date" }).text)
      .not.toContain("Invalid");
  });

  it("recording not ready: invites a retry", () => {
    const fb = feedbackFor({ status: "recording_not_ready", retryAfterMinutes: 12 });
    expect(fb.kind).toBe("error");
    expect(fb.text).toBe("Recording isn't ready yet — try again in a few minutes.");
  });

  it("recording unavailable: names the phone system, offers no false hope", () => {
    const fb = feedbackFor({ status: "recording_unavailable" });
    expect(fb.text).toBe("Recording is no longer available from the phone system.");
    expect(fb.text).not.toMatch(/try again/i);
  });

  it("error: states plainly that nothing was saved", () => {
    const fb = feedbackFor({ status: "error", detail: "Azure Speech 503" });
    expect(fb.kind).toBe("error");
    expect(fb.text).toBe("Transcription failed — nothing was saved. Try again.");
    expect(fb.text).not.toContain("503");
  });
});

describe("non-failure copy", () => {
  it("completed: reports the audio minutes actually billed", () => {
    const fb = transcribeFeedback({ status: "completed", minutesUsed: 1.5 });
    expect(fb.kind).toBe("success");
    expect(fb.text).toContain("1.5 min");
  });

  it("completed without a minute count still reads cleanly", () => {
    expect(transcribeFeedback({ status: "completed" }).text).toBe("Transcribed and summarized.");
  });

  it("exists: says nothing was re-run, so a second click never looks like spend", () => {
    const fb = transcribeFeedback({ status: "exists", transcript: "t" });
    expect(fb.kind).toBe("info");
    expect(fb.text).toContain("nothing was re-run");
  });

  it("in_progress: informational, not an error — a double click is not a mistake", () => {
    expect(transcribeFeedback({ status: "in_progress" }).kind).toBe("info");
  });
});

describe("copy coverage", () => {
  it("every status has real, non-placeholder copy", () => {
    for (const status of ALL_STATUSES) {
      const fb = transcribeFeedback({ status });
      expect(fb.text.length, `${status} has no copy`).toBeGreaterThan(10);
      expect(fb.text).not.toMatch(/undefined|\[object/);
      expect(["success", "info", "error"]).toContain(fb.kind);
    }
  });

  it("an unknown status from a future backend falls back to the error state", () => {
    const fb = transcribeFeedback({ status: "something_new" as TranscribeStatus });
    expect(fb.kind).toBe("error");
    expect(fb.text).toContain("nothing was saved");
  });

  it("failures stay on screen longer than successes — refusals need reading", () => {
    expect(toastDuration("error")).toBeGreaterThan(toastDuration("success"));
    expect(toastDuration("error")).toBeGreaterThan(toastDuration("info"));
  });
});

describe("formatResetTime", () => {
  it("renders a clock time for a valid instant", () => {
    expect(formatResetTime("2026-08-07T05:00:00.000Z")).toMatch(/\d{1,2}:\d{2}/);
  });

  it("never renders Invalid Date", () => {
    expect(formatResetTime(undefined)).toBe("midnight");
    expect(formatResetTime("")).toBe("midnight");
    expect(formatResetTime("nope")).toBe("midnight");
  });
});
