/**
 * Activity timeline — voice_handoff rendering (the TC half of the voice→TC
 * handoff slice).
 *
 * The handoff event is the ONLY durable record of the call inside TC: the voice
 * module prunes call rows on its own schedule, so the summary text has to be
 * readable here with the deep link dead. These tests pin that — the summary
 * renders as text, the link is an extra rather than the payload, and an event
 * with no link or no summary still renders cleanly.
 */
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Classic-runtime React global (see tests/tc-followups-queue.test.tsx).
(globalThis as Record<string, unknown>).React = React;

import type { TcCaseEvent } from "@shared/tc/contract";
import { ActivityTimeline } from "@/features/tc/caseview/ActivityTimeline";

const SUMMARY = "Caller asked about replacing a missing back tooth and the cost.";

function handoffEvent(overrides: Partial<TcCaseEvent> = {}): TcCaseEvent {
  return {
    eventId: "11111111-1111-4111-8111-111111111111",
    legacyId: null,
    ts: "2026-08-07T15:04:05.000Z",
    type: "voice_handoff",
    description: "Sent to TC from a CareIN call — new case",
    actor: "tc@carein.ai",
    detail: { callUrl: "/calls/mango_call_1", callSummary: SUMMARY, attached: false },
    sourceCallId: "mango_call_1",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("ActivityTimeline — voice_handoff", () => {
  it("labels the event 'From call' and renders the snapshot summary as text", () => {
    render(<ActivityTimeline events={[handoffEvent()]} />);

    expect(screen.getByText("From call")).toBeTruthy();
    // The summary is a COPY, not a lookup — it must be readable on its own.
    expect(screen.getByText(SUMMARY)).toBeTruthy();
    expect(screen.getByText("tc@carein.ai", { exact: false })).toBeTruthy();
  });

  it("renders the call link when present, as an extra rather than the payload", () => {
    render(<ActivityTimeline events={[handoffEvent()]} />);

    const link = screen.getByRole("link", { name: "Open the call" });
    expect(link.getAttribute("href")).toBe("/calls/mango_call_1");
    // The meaning is in the text above it, which survives the link 404-ing.
    expect(screen.getByText(SUMMARY)).toBeTruthy();
  });

  it("renders with no link and no summary — neither is required", () => {
    render(
      <ActivityTimeline
        events={[
          handoffEvent({
            detail: { callUrl: null, callSummary: null, attached: true },
          }),
        ]}
      />,
    );

    expect(screen.getByText("From call")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says whether the handoff opened the case or attached to it", () => {
    const { unmount } = render(<ActivityTimeline events={[handoffEvent()]} />);
    expect(screen.getByText("Opened this case")).toBeTruthy();
    unmount();

    render(
      <ActivityTimeline
        events={[
          handoffEvent({
            detail: { callUrl: null, callSummary: null, attached: true },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Attached to this case")).toBeTruthy();
  });

  it("still renders contact_attempt detail — the two payload shapes coexist", () => {
    render(
      <ActivityTimeline
        events={[
          handoffEvent(),
          {
            eventId: "22222222-2222-4222-8222-222222222222",
            legacyId: null,
            ts: "2026-08-06T10:00:00.000Z",
            type: "contact_attempt",
            description: "Left a voicemail",
            actor: "tc@carein.ai",
            detail: { channel: "call", outcome: "voicemail" },
            sourceCallId: null,
          },
        ]}
      />,
    );

    expect(screen.getByText("Call — voicemail")).toBeTruthy();
    expect(screen.getByText("From call")).toBeTruthy();
  });
});
