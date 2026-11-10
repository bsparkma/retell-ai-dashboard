/**
 * Activity timeline — notes_updated rendering (AT-0).
 *
 * Each save of the long-form notes box that changes it is an append-only
 * notes_updated event whose detail is the FULL text after that save. The
 * timeline must show each version on its own (not a diff), say "cleared" for
 * an emptied box, and keep rendering every other event type around it — the
 * EVENT_META map is a Record over the whole CaseEventType, so a missing entry
 * is a compile error; this pins the rendered result.
 */
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Classic-runtime React global (see tests/tc-followups-queue.test.tsx).
(globalThis as Record<string, unknown>).React = React;

import { CaseEventType, TcCaseEvent, type TcCaseEvent as TcCaseEventT } from "@shared/tc/contract";
import { ActivityTimeline } from "@/features/tc/caseview/ActivityTimeline";

function event(overrides: Partial<TcCaseEventT>): TcCaseEventT {
  return {
    eventId: "22222222-2222-4222-8222-222222222222",
    legacyId: null,
    ts: "2026-11-10T15:00:00.000Z",
    type: "notes_updated",
    description: "Case notes edited",
    actor: "tc@carein.ai",
    detail: { notes: "Wants to phase it.\nCall back after the holidays." },
    sourceCallId: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("ActivityTimeline — notes_updated", () => {
  it("is in the shared vocabulary and its detail parses through the contract", () => {
    expect(CaseEventType.options).toContain("notes_updated");
    const parsed = TcCaseEvent.parse(event({}));
    expect(parsed.detail).toEqual({ notes: "Wants to phase it.\nCall back after the holidays." });
  });

  it("labels the revision and shows the full saved text and who saved it", () => {
    render(<ActivityTimeline events={[event({})]} />);
    expect(screen.getByText("Case notes edited", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/Wants to phase it\.\s+Call back after the holidays\./)).toBeTruthy();
    expect(screen.getByText("tc@carein.ai", { exact: false })).toBeTruthy();
  });

  it("each revision renders as its own version, newest first", () => {
    render(
      <ActivityTimeline
        events={[
          event({ eventId: "33333333-3333-4333-8333-333333333331", ts: "2026-11-09T15:00:00.000Z", detail: { notes: "first version" } }),
          event({ eventId: "33333333-3333-4333-8333-333333333332", ts: "2026-11-10T15:00:00.000Z", detail: { notes: "second version" } }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("second version");
    expect(items[1].textContent).toContain("first version");
  });

  it("an emptied box reads as 'Notes cleared'", () => {
    render(<ActivityTimeline events={[event({ description: "Case notes cleared", detail: { notes: "" } })]} />);
    expect(screen.getByText("Notes cleared")).toBeTruthy();
  });

  it("renders beside status changes and a voice handoff without disturbing them", () => {
    render(
      <ActivityTimeline
        events={[
          event({ eventId: "44444444-4444-4444-8444-444444444441", ts: "2026-11-10T15:00:00.000Z" }),
          event({
            eventId: "44444444-4444-4444-8444-444444444442",
            ts: "2026-11-09T15:00:00.000Z",
            type: "status_change",
            description: "pending_tc → presented",
            detail: null,
          }),
          event({
            eventId: "44444444-4444-4444-8444-444444444443",
            ts: "2026-11-08T15:00:00.000Z",
            type: "voice_handoff",
            description: "Sent to TC from a CareIN call — new case",
            detail: { callUrl: null, callSummary: "Asked about a crown.", attached: false },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Status change")).toBeTruthy();
    expect(screen.getByText("pending_tc → presented")).toBeTruthy();
    expect(screen.getByText("From call")).toBeTruthy();
    expect(screen.getByText("Asked about a crown.")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
