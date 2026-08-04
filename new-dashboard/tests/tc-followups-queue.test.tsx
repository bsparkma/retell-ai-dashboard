/**
 * FollowupQueue component tests (jsdom via the .tsx glob).
 *
 * The api module is mocked so the queue is driven purely by props — office is
 * a prop (no OfficeContext) and `today` is pinned so grouping is
 * deterministic. Covers: Overdue / Due today / Upcoming grouping, the
 * confirmed-save Complete flow (card removed only after the API resolves,
 * called with the typed outcome note), and a rejected complete keeping the
 * dialog open with its values and the card present.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform (tsconfig has
// jsx: "preserve"), while the app's Vite build uses the automatic runtime —
// so component modules never import React. Provide the classic-runtime global
// so their JSX renders under vitest.
(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => ({
  followupsDue: vi.fn(),
  completeFollowup: vi.fn(),
  skipFollowup: vi.fn(),
  rescheduleFollowup: vi.fn(),
  tcErrorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong.",
  ),
}));
vi.mock("@/features/tc/api", () => apiMock);

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { FollowupQueue } from "@/features/tc/followups/FollowupQueue";
import type { TcDueFollowup } from "@/features/tc/api";

const TODAY = "2026-03-10";

function mkFollowup(
  overrides: Partial<TcDueFollowup> &
    Pick<TcDueFollowup, "followupId" | "dueDate" | "patientName">,
): TcDueFollowup {
  return {
    caseId: `case-${overrides.followupId}`,
    officeId: "roland",
    kind: "followup",
    channel: "phone_call",
    status: "pending",
    talkingPoint: "Check in about the treatment plan",
    outcomeNote: "",
    completedAt: null,
    completedBy: null,
    source: "manual",
    patientResponded: null,
    nurtureType: null,
    legacyId: null,
    casePhone: "(479) 555-0100",
    caseStatus: "presented",
    assignedTc: "Amber",
    caseValueCents: 250_000,
    caseUrgency: "medium",
    ...overrides,
  };
}

const overdue = mkFollowup({
  followupId: "fu-overdue",
  dueDate: "2026-03-08",
  patientName: "Olive Overdue",
  caseUrgency: "high",
});
const dueToday = mkFollowup({
  followupId: "fu-today",
  dueDate: "2026-03-10",
  patientName: "Tina Today",
});
const upcoming = mkFollowup({
  followupId: "fu-upcoming",
  dueDate: "2026-03-12",
  patientName: "Uma Upcoming",
  kind: "nurture",
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("FollowupQueue", () => {
  it("groups rows into Overdue, Due today, and Upcoming with correct labels", async () => {
    apiMock.followupsDue.mockResolvedValue([upcoming, overdue, dueToday]);

    render(<FollowupQueue office="roland" today={TODAY} />);

    const overdueRegion = await screen.findByRole("region", { name: "Overdue" });
    expect(within(overdueRegion).getByText("Olive Overdue")).toBeTruthy();
    // Escalation badge from lib/followups: 2 calendar days past due.
    expect(within(overdueRegion).getByText("2d overdue")).toBeTruthy();

    const todayRegion = screen.getByRole("region", { name: "Due today" });
    expect(within(todayRegion).getByText("Tina Today")).toBeTruthy();
    expect(within(todayRegion).queryByText("Olive Overdue")).toBeNull();

    const upcomingRegion = screen.getByRole("region", { name: "Upcoming" });
    expect(within(upcomingRegion).getByText("Uma Upcoming")).toBeTruthy();

    // Default horizon is the provided today; kind filter "all" sends no kind.
    expect(apiMock.followupsDue).toHaveBeenCalledWith("roland", { date: TODAY });
  });

  it("completes a follow-up with the outcome note and removes the card only after the API resolves", async () => {
    apiMock.followupsDue.mockResolvedValue([overdue, dueToday, upcoming]);
    let resolveComplete: (row: TcDueFollowup) => void = () => {};
    apiMock.completeFollowup.mockImplementation(
      () =>
        new Promise<TcDueFollowup>((resolve) => {
          resolveComplete = resolve;
        }),
    );

    render(<FollowupQueue office="roland" today={TODAY} />);

    const todayRegion = await screen.findByRole("region", { name: "Due today" });
    fireEvent.click(within(todayRegion).getByRole("button", { name: "Complete" }));

    const note = await screen.findByLabelText("Outcome note");
    fireEvent.change(note, { target: { value: "Reached patient — thinking it over" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Patient responded?" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark complete" }));

    expect(apiMock.completeFollowup).toHaveBeenCalledWith("roland", "fu-today", {
      outcomeNote: "Reached patient — thinking it over",
      patientResponded: true,
    });

    // Confirmed-save: the card stays until the promise resolves.
    expect(screen.getByText("Tina Today")).toBeTruthy();
    expect(toastMock.success).not.toHaveBeenCalled();

    await act(async () => {
      resolveComplete({ ...dueToday, status: "completed" });
    });

    await waitFor(() => expect(screen.queryByText("Tina Today")).toBeNull());
    expect(toastMock.success).toHaveBeenCalled();
    // The other rows are untouched.
    expect(screen.getByText("Olive Overdue")).toBeTruthy();
    expect(screen.getByText("Uma Upcoming")).toBeTruthy();
  });

  it("keeps the dialog open with its values and the card present when complete fails", async () => {
    apiMock.followupsDue.mockResolvedValue([dueToday]);
    apiMock.completeFollowup.mockRejectedValue(new Error("Server exploded"));

    render(<FollowupQueue office="roland" today={TODAY} />);

    const todayRegion = await screen.findByRole("region", { name: "Due today" });
    fireEvent.click(within(todayRegion).getByRole("button", { name: "Complete" }));

    const note = await screen.findByLabelText("Outcome note");
    fireEvent.change(note, { target: { value: "Left voicemail" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark complete" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Server exploded"));

    // Dialog still open, typed note preserved, no success toast.
    const noteAfter = screen.getByLabelText("Outcome note");
    expect((noteAfter as HTMLTextAreaElement).value).toBe("Left voicemail");
    expect(toastMock.success).not.toHaveBeenCalled();

    // Card still in the queue. (While the dialog is open Radix marks the
    // background aria-hidden, so query by text rather than region role.)
    expect(screen.getByText("Tina Today")).toBeTruthy();
    expect(apiMock.completeFollowup).toHaveBeenCalledTimes(1);
  });
});
