/**
 * Next touch: the derivation, the chip, the Follow-ups page view, and the
 * consult run order.
 *
 *   derivation  earliest PENDING follow-up; ties stable (shared/tc/nextTouch)
 *   chip        red overdue / amber today / neutral upcoming; "No next step"
 *   view        pinned "No next step" section + Overdue → Due today → Upcoming;
 *               one click sets a step; closing the LAST touch prompts for the
 *               next one (dismissable); writes go to the ROW's office
 *   consult     a plan that moves into an open status runs its first
 *               follow-up before the move, so the case already has its touch
 *
 * The api module is mocked; `today` is pinned. Synthetic data only.
 */
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => ({
  nextTouchView: vi.fn(),
  createFollowup: vi.fn(),
  completeFollowup: vi.fn(),
  skipFollowup: vi.fn(),
  rescheduleFollowup: vi.fn(),
  tcErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : "Something went wrong.")),
}));
vi.mock("@/features/tc/api", () => apiMock);
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: { name: "TC User", email: "tc@carein.ai", tenantId: "t", tenant: null, role: "tc", isSuperAdmin: false },
  }),
}));

import {
  addBusinessDays,
  isOpenCaseStatus,
  nextTouchByCase,
  nextTouchState,
  ownerInitials,
  pickNextTouch,
} from "../shared/tc/nextTouch";
import { NextTouchChip } from "@/features/tc/nextTouch/NextTouch";
import { NextTouchView, bucketNextTouches } from "@/features/tc/followups/NextTouchView";
import { consultRunOrder, type ConsultStep } from "@/features/tc/consult/outcomeActions";
import type { TcDueFollowup, TcNoNextStepCase } from "@/features/tc/api";

const TODAY = "2026-11-11"; // a Wednesday

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

function touch(o: Partial<TcDueFollowup> & Pick<TcDueFollowup, "followupId" | "dueDate" | "patientName">): TcDueFollowup {
  return {
    caseId: `case-${o.followupId}`,
    officeId: "roland",
    kind: "followup",
    channel: "phone_call",
    status: "pending",
    talkingPoint: "",
    outcomeNote: "",
    completedAt: null,
    completedBy: null,
    source: "manual",
    patientResponded: null,
    nurtureType: null,
    legacyId: null,
    owner: "alex.owner@carein.ai",
    casePhone: null,
    caseStatus: "considering",
    assignedTc: "",
    caseValueCents: 100_000,
    caseUrgency: "medium",
    ...o,
  };
}

function bare(o: Partial<TcNoNextStepCase> & Pick<TcNoNextStepCase, "caseId" | "patientName">): TcNoNextStepCase {
  return {
    officeId: "roland",
    casePhone: null,
    caseStatus: "presented",
    assignedTc: "",
    caseValueCents: 100_000,
    caseUrgency: "medium",
    statusChangedAt: null,
    ...o,
  };
}

// ── Derivation (the dashboard runs the same shared module) ──────────────────

describe("next-touch derivation", () => {
  it("is the earliest PENDING follow-up, ignoring completed/skipped; same-day ties are stable", () => {
    const f = (followupId: string, dueDate: string, status = "pending") => ({ followupId, dueDate, status });
    expect(pickNextTouch([f("b", "2026-11-15"), f("a", "2026-11-01", "completed"), f("c", "2026-11-20")])?.followupId).toBe("b");
    expect(pickNextTouch([f("a", "2026-11-01", "skipped")])).toBeNull();
    expect(pickNextTouch([f("z", "2026-11-15"), f("y", "2026-11-15")])?.followupId).toBe("y");
    const m = nextTouchByCase([
      { ...f("x2", "2026-11-30"), caseId: "X" },
      { ...f("x1", "2026-11-10"), caseId: "X" },
    ]);
    expect(m.get("X")?.followupId).toBe("x1");
  });

  it("open statuses: the working ones only — never terminal, never scheduled", () => {
    for (const s of ["hygiene_review", "diagnosed", "pending_tc", "pending_pt", "presented", "considering", "financing_pending", "nurture"]) {
      expect(isOpenCaseStatus(s)).toBe(true);
    }
    for (const s of ["accepted", "partially_accepted", "scheduled", "started", "completed", "lost"]) {
      expect(isOpenCaseStatus(s)).toBe(false);
    }
  });

  it("business days and initials", () => {
    expect(addBusinessDays("2026-11-11", 2)).toBe("2026-11-13");
    expect(addBusinessDays("2026-11-13", 2)).toBe("2026-11-17");
    expect(ownerInitials("alex.owner@carein.ai")).toBe("AO");
    expect(ownerInitials(null)).toBe("?");
    expect(nextTouchState("2026-11-10", TODAY)).toBe("overdue");
  });
});

// ── Chip ─────────────────────────────────────────────────────────────────────

describe("NextTouchChip", () => {
  it("red when overdue, amber when due today, neutral upcoming — with owner initials", () => {
    const { rerender } = render(<NextTouchChip nextTouch={{ dueDate: "2026-11-09", owner: "alex.owner@carein.ai" }} today={TODAY} />);
    let chip = screen.getByTestId("next-touch-chip");
    expect(chip.getAttribute("data-state")).toBe("overdue");
    expect(chip.className).toContain("red");
    expect(chip.textContent).toContain("AO");

    rerender(<NextTouchChip nextTouch={{ dueDate: TODAY, owner: "tc@carein.ai" }} today={TODAY} />);
    chip = screen.getByTestId("next-touch-chip");
    expect(chip.getAttribute("data-state")).toBe("today");
    expect(chip.className).toContain("amber");

    rerender(<NextTouchChip nextTouch={{ dueDate: "2026-11-20", owner: null }} today={TODAY} />);
    chip = screen.getByTestId("next-touch-chip");
    expect(chip.getAttribute("data-state")).toBe("upcoming");
    expect(chip.className).not.toContain("red");
    expect(chip.className).not.toContain("amber");
    expect(chip.textContent).toContain("?");
  });

  it('null = "No next step"', () => {
    render(<NextTouchChip nextTouch={null} today={TODAY} />);
    const chip = screen.getByTestId("next-touch-chip");
    expect(chip.getAttribute("data-state")).toBe("none");
    expect(chip.textContent).toContain("No next step");
  });
});

// ── Follow-ups page: the next-touch view ─────────────────────────────────────

describe("bucketNextTouches", () => {
  it("overdue → today → upcoming, each date-sorted", () => {
    const b = bucketNextTouches(
      [
        touch({ followupId: "u2", dueDate: "2026-11-20", patientName: "Test, U2" }),
        touch({ followupId: "o1", dueDate: "2026-11-02", patientName: "Test, O1" }),
        touch({ followupId: "t1", dueDate: TODAY, patientName: "Test, T1" }),
        touch({ followupId: "u1", dueDate: "2026-11-12", patientName: "Test, U1" }),
        touch({ followupId: "o2", dueDate: "2026-11-10", patientName: "Test, O2" }),
      ],
      TODAY,
    );
    expect(b.overdue.map((x) => x.followupId)).toEqual(["o1", "o2"]);
    expect(b.today.map((x) => x.followupId)).toEqual(["t1"]);
    expect(b.upcoming.map((x) => x.followupId)).toEqual(["u1", "u2"]);
  });
});

describe("NextTouchView", () => {
  it('pins "No next step" above the date groups and lists each case once', async () => {
    apiMock.nextTouchView.mockResolvedValue({
      touches: [
        touch({ followupId: "fu-up", dueDate: "2026-11-20", patientName: "Test, Upcoming" }),
        touch({ followupId: "fu-od", dueDate: "2026-11-05", patientName: "Test, Overdue" }),
        touch({ followupId: "fu-td", dueDate: TODAY, patientName: "Test, Today" }),
      ],
      noNextStep: [bare({ caseId: "case-none", patientName: "Test, Nobody" })],
      truncated: false,
    });
    render(<NextTouchView office="roland" today={TODAY} />);

    const pinned = await screen.findByRole("region", { name: "No next step" });
    expect(within(pinned).getByText("Test, Nobody")).toBeTruthy();
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual(["No next step", "Overdue", "Due today", "Upcoming"]);
    expect(within(screen.getByRole("region", { name: "Overdue" })).getByText("Test, Overdue")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Due today" })).getByText("Test, Today")).toBeTruthy();
    expect(apiMock.nextTouchView).toHaveBeenCalledWith("roland");
  });

  it("one click sets a next step: defaults me + 2 business days, posted to the case's own office", async () => {
    // Each office answers for itself: roland has nothing open, valley has one.
    apiMock.nextTouchView.mockImplementation(async (office: string) => ({
      touches: [],
      noNextStep:
        office === "valley" ? [bare({ caseId: "case-v", patientName: "Stedi TestValley", officeId: "valley" })] : [],
      truncated: false,
    }));
    apiMock.createFollowup.mockResolvedValue({});
    render(<NextTouchView office={["roland", "valley"]} today={TODAY} />);

    fireEvent.click(await screen.findByRole("button", { name: /Set next step/ }));
    expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("tc@carein.ai");
    expect((screen.getByLabelText("Next touch") as HTMLInputElement).value).toBe("2026-11-13");
    fireEvent.click(screen.getByRole("button", { name: "Set next touch" }));

    await waitFor(() => expect(apiMock.createFollowup).toHaveBeenCalled());
    expect(apiMock.createFollowup).toHaveBeenCalledWith("valley", {
      caseId: "case-v",
      kind: "followup",
      dueDate: "2026-11-13",
      channel: "phone_call",
      talkingPoint: "",
      owner: "tc@carein.ai",
      source: "manual",
    });
  });

  it("completing the LAST touch prompts for the next; Not now dismisses and writes nothing", async () => {
    apiMock.nextTouchView.mockResolvedValue({
      touches: [touch({ followupId: "fu-last", dueDate: TODAY, patientName: "Test, Last" })],
      noNextStep: [],
      truncated: false,
    });
    apiMock.completeFollowup.mockResolvedValue({ followupId: "fu-last", nextTouchNeeded: true });
    render(<NextTouchView office="roland" today={TODAY} />);

    fireEvent.click(await screen.findByRole("button", { name: "Complete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark complete" }));

    expect(await screen.findByText("What's the next touch?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByText("What's the next touch?")).toBeNull());
    expect(apiMock.createFollowup).not.toHaveBeenCalled();
  });

  it("completing a touch that is NOT the last asks nothing", async () => {
    apiMock.nextTouchView.mockResolvedValue({
      touches: [touch({ followupId: "fu-one", dueDate: TODAY, patientName: "Test, One" })],
      noNextStep: [],
      truncated: false,
    });
    apiMock.completeFollowup.mockResolvedValue({ followupId: "fu-one", nextTouchNeeded: false });
    render(<NextTouchView office="roland" today={TODAY} />);

    fireEvent.click(await screen.findByRole("button", { name: "Complete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark complete" }));
    await waitFor(() => expect(apiMock.completeFollowup).toHaveBeenCalled());
    await waitFor(() => expect(apiMock.nextTouchView).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("What's the next touch?")).toBeNull();
  });
});

// ── Consult: the plan's own first follow-up becomes the next touch ──────────

describe("consultRunOrder", () => {
  const steps: ConsultStep[] = [
    { kind: "objection", category: "cost", note: "", patientWords: "" },
    { kind: "transition", status: "considering", lostReason: null, note: "" },
    { kind: "followup", dueDate: "2026-11-16", channel: "phone_call", talkingPoint: "1" },
    { kind: "followup", dueDate: "2026-11-23", channel: "text", talkingPoint: "2" },
  ];

  it("runs the first follow-up just before a move into an open status", () => {
    expect(consultRunOrder(steps)).toEqual([0, 2, 1, 3]);
  });

  it("leaves terminal moves and follow-up-free plans in plan order", () => {
    const accepted: ConsultStep[] = [{ kind: "transition", status: "accepted", lostReason: null, note: "" }];
    expect(consultRunOrder(accepted)).toEqual([0]);
    const nurture: ConsultStep[] = [{ kind: "transition", status: "nurture", lostReason: null, note: "" }];
    expect(consultRunOrder(nurture)).toEqual([0]);
  });
});
