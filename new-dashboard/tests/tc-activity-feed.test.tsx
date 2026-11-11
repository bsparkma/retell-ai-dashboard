/**
 * AT-1: the case view's Activity tab, now the merged feed.
 *
 * Pins: each row's audience badge, the "Current value" and "On chart" markers;
 * source chips hide/show rows; "Load more" pages with the server's cursor and
 * appends without repeating; the "This patient (other cases)" toggle re-reads
 * with scope=patient; the tab is read-only (its only buttons are filters,
 * the scope toggle and Load more); a malformed page is an error, not a row.
 *
 * Synthetic data only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// Classic-runtime React global (see tests/tc-case-status.test.tsx).
(globalThis as Record<string, unknown>).React = React;

import { TcActivityPage, type TcActivityItem } from "@shared/tc/activity";
import { ActivityFeed } from "@/features/tc/caseview/ActivityFeed";

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, getCaseActivity: vi.fn() };
});

import { getCaseActivity } from "../client/src/features/tc/api";

const activityMock = vi.mocked(getCaseActivity);
const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function item(overrides: Partial<TcActivityItem> & Pick<TcActivityItem, "id" | "source">): TcActivityItem {
  return {
    kind: "note",
    at: "2026-11-10T15:00:00.000Z",
    actor: { display: "tc@carein.ai", email: "tc@carein.ai", system: false },
    audience: "internal",
    title: "Note",
    body: null,
    scope: "case",
    links: {},
    chart: { onChart: false, via: null },
    completeness: "full",
    ...overrides,
  };
}

const PAGE_ONE: TcActivityItem[] = [
  item({ id: "message:m1", source: "message", kind: "sms_out", audience: "patient_facing", direction: "outbound", title: "Text sent", body: "See you Tuesday." }),
  item({
    id: "voice_call:c1",
    source: "voice_call",
    kind: "call",
    audience: "patient_facing",
    title: "Phone call · 2 min",
    body: "Asked about crown cost.",
    chart: { onChart: true, via: "voice", commLogNum: 777 },
    actor: { display: "CareIN voice agent", email: null, system: true },
  }),
  item({ id: "case_notes:n1", source: "case_notes", kind: "notes_current", title: "Case notes (current value)", body: "Box as it is now", completeness: "current_value_only" }),
  item({ id: "referral_event:r1", source: "referral_event", kind: "referral_sent", audience: "external", title: "Referral letter sent — letter as sent was not stored" }),
];

const PAGE_TWO: TcActivityItem[] = [
  item({ id: "case_event:e1", source: "case_event", kind: "status_change", title: "Status: pending_tc → presented", body: "Walked through it", at: "2026-11-01T15:00:00.000Z" }),
];

beforeEach(() => {
  activityMock.mockReset();
});

afterEach(() => {
  cleanup();
});

const rows = () => screen.queryAllByTestId("tc-activity-row");

describe("ActivityFeed (AT-1)", () => {
  it("renders each row with its audience badge, Current value and On chart markers", async () => {
    activityMock.mockResolvedValue({ items: PAGE_ONE, nextCursor: null });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(activityMock).toHaveBeenCalledWith("roland", CASE_ID, { scope: "case", limit: 50 });

    const [msg, call, notes, ref] = rows();
    expect(within(msg).getByText("Patient-facing")).toBeTruthy();
    expect(within(msg).getByText("See you Tuesday.")).toBeTruthy();
    expect(within(call).getByText("On chart · call note")).toBeTruthy();
    expect(within(notes).getByText("Current value")).toBeTruthy();
    expect(within(notes).getByText(/^as of /)).toBeTruthy();
    expect(within(notes).getByText("Internal")).toBeTruthy();
    expect(within(ref).getByText("External")).toBeTruthy();
    expect(within(ref).getByText(/letter as sent was not stored/)).toBeTruthy();
  });

  it("source chips hide and show rows", async () => {
    activityMock.mockResolvedValue({ items: PAGE_ONE, nextCursor: null });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(rows()).toHaveLength(4));

    const chip = screen.getByRole("button", { name: "Messages" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(rows().map((r) => r.getAttribute("data-source"))).toEqual(["voice_call", "case_notes", "referral_event"]);
    fireEvent.click(chip);
    expect(rows()).toHaveLength(4);
  });

  it("Load more pages with the server's cursor and appends without repeating", async () => {
    activityMock
      .mockResolvedValueOnce({ items: PAGE_ONE, nextCursor: "cursor-1" })
      // The second page repeats one row (a widened server pull may): shown once.
      .mockResolvedValueOnce({ items: [PAGE_ONE[3], ...PAGE_TWO], nextCursor: null });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(rows()).toHaveLength(4));

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(activityMock).toHaveBeenLastCalledWith("roland", CASE_ID, { scope: "case", limit: 50, before: "cursor-1" });
    expect(rows()[4].textContent).toContain("Walked through it");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("the other-cases toggle re-reads with scope=patient and marks those rows", async () => {
    activityMock
      .mockResolvedValueOnce({ items: PAGE_ONE, nextCursor: null })
      .mockResolvedValueOnce({
        items: [...PAGE_ONE, item({ id: "case_event:other", source: "case_event", title: "Note", body: "From another case", scope: "patient" })],
        nextCursor: null,
      });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(rows()).toHaveLength(4));

    const toggle = screen.getByRole("button", { name: "This patient (other cases)" });
    fireEvent.click(toggle);
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(activityMock).toHaveBeenLastCalledWith("roland", CASE_ID, { scope: "patient", limit: 50 });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const other = rows().find((r) => r.textContent?.includes("From another case"));
    expect(other && within(other).getByText("Other case / patient")).toBeTruthy();
  });

  it("is read-only: the only buttons are source filters, the scope toggle and Load more", async () => {
    activityMock.mockResolvedValue({ items: PAGE_ONE, nextCursor: "c" });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(rows()).toHaveLength(4));
    const names = screen.getAllByRole("button").map((b) => b.textContent?.trim());
    expect(names).toEqual(["Notes box", "Messages", "Referrals", "Calls", "This patient (other cases)", "Load more"]);
  });

  it("an error is shown, not an empty feed; and the shared schema refuses a malformed page", async () => {
    activityMock.mockRejectedValue(new Error("boom"));
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn’t load activity/);
    expect(screen.queryByText("No activity yet.")).toBeNull();

    expect(TcActivityPage.safeParse({ items: [{ id: "x:1", source: "nope" }], nextCursor: null }).success).toBe(false);
    expect(TcActivityPage.safeParse({ items: PAGE_ONE, nextCursor: null }).success).toBe(true);
  });
});
