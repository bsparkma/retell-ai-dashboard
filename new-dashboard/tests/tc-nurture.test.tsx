/**
 * NurtureWorkspace component tests (jsdom via the .tsx glob), following the
 * tc-followups-queue harness: @/features/tc/api and sonner are mocked, office
 * is a prop, and `today` is pinned so queue grouping is deterministic.
 *
 * Covers: section grouping (today / this week / roster), unsubscribed cases
 * excluded from the queue but shown dimmed in the table, the confirmed-save
 * exit-nurture flow (row removed and toast fired only after transitionCase
 * resolves), and the financing touchpoint create payload (kind nurture,
 * whole-dollar monthly figure from integer cents).
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
// jsx: "preserve"); provide the classic-runtime global for component modules.
(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => ({
  listCases: vi.fn(),
  listFollowups: vi.fn(),
  patchCase: vi.fn(),
  transitionCase: vi.fn(),
  createFollowup: vi.fn(),
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

import { NurtureWorkspace } from "@/features/tc/nurture/NurtureWorkspace";
import type { TcCaseSummary, TcQueueFollowup } from "@/features/tc/api";

const TODAY = "2026-03-10";

function mkCase(
  overrides: Partial<TcCaseSummary> & Pick<TcCaseSummary, "caseId" | "patientName">,
): TcCaseSummary {
  return {
    legacyId: null,
    officeId: "roland",
    patientAge: null,
    phone: "(479) 555-0100",
    email: null,
    odPatientId: null,
    caseType: "Implant",
    category: "implant",
    status: "nurture",
    urgency: "medium",
    doctorName: "Dr. Sparkman",
    diagnosingProvider: null,
    assignedTc: "Amber",
    caseValueCents: 250_000,
    readinessScore: 50,
    financingStatus: "",
    preferredFinancingProvider: null,
    decisionMakers: "",
    financialSituation: [],
    keyMotivators: [],
    contactPreference: null,
    bestTimeToReach: "",
    notes: "",
    referralSource: null,
    lostReason: null,
    diagnosedDate: null,
    statusChangedAt: "2026-01-01T00:00:00.000Z",
    nurtureCadence: "standard",
    inLongTailMode: false,
    nurtureEnrolledAt: "2026-02-24T00:00:00.000Z", // 14 days ago → Phase 1
    nurturePhaseChangedAt: null,
    nurturePhase1DaysOverride: null,
    nurturePhase2DaysOverride: null,
    nurtureUnsubscribed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mkTouchpoint(
  overrides: Partial<TcQueueFollowup> &
    Pick<TcQueueFollowup, "followupId" | "caseId" | "dueDate">,
): TcQueueFollowup {
  return {
    officeId: "roland",
    kind: "nurture",
    channel: "text",
    status: "pending",
    talkingPoint: "Just checking in",
    outcomeNote: "",
    completedAt: null,
    completedBy: null,
    source: "manual",
    patientResponded: null,
    nurtureType: "check_in",
    legacyId: null,
    ...overrides,
  };
}

const maria = mkCase({ caseId: "case-maria", patientName: "Maria Lopez" });
const ursula = mkCase({
  caseId: "case-ursula",
  patientName: "Ursula Unsub",
  nurtureUnsubscribed: true,
});

const dueTodayTp = mkTouchpoint({
  followupId: "tp-today",
  caseId: "case-maria",
  dueDate: "2026-03-10",
});
const thisWeekTp = mkTouchpoint({
  followupId: "tp-week",
  caseId: "case-maria",
  dueDate: "2026-03-14",
  nurtureType: "seasonal",
});
const unsubTp = mkTouchpoint({
  followupId: "tp-unsub",
  caseId: "case-ursula",
  dueDate: "2026-03-10",
});
const completedTp = mkTouchpoint({
  followupId: "tp-done",
  caseId: "case-maria",
  dueDate: "2026-02-24",
  status: "completed",
  completedAt: "2026-02-24T15:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listCases.mockResolvedValue([maria, ursula]);
  apiMock.listFollowups.mockResolvedValue([dueTodayTp, thisWeekTp, unsubTp, completedTp]);
});

afterEach(() => {
  cleanup();
});

describe("NurtureWorkspace", () => {
  it("groups touchpoints into Today's Queue and This Week, excluding unsubscribed cases", async () => {
    render(<NurtureWorkspace office="roland" today={TODAY} />);

    expect(
      await screen.findByText("2 patients in long-term nurture · 1 touchpoint due today"),
    ).toBeTruthy();
    expect(apiMock.listCases).toHaveBeenCalledWith("roland", { status: "nurture" });
    expect(apiMock.listFollowups).toHaveBeenCalledWith("roland", { kind: "nurture" });

    // Today's queue: Maria's due-today card only — Ursula is unsubscribed.
    const todayRegion = screen.getByRole("region", { name: "Today's Queue" });
    expect(within(todayRegion).getByText("Maria Lopez")).toBeTruthy();
    expect(within(todayRegion).queryByText("Ursula Unsub")).toBeNull();

    // This Week holds the 03-14 touchpoint.
    const weekRegion = screen.getByRole("region", { name: "This Week" });
    expect(within(weekRegion).getByText("Due 2026-03-14")).toBeTruthy();

    // Table shows both cases; Ursula carries the Unsubscribed marker and no
    // row actions; Maria shows phase, days enrolled, cadence, and history.
    const table = screen.getByRole("region", { name: "All Nurture Patients" });
    expect(within(table).getByText("Ursula Unsub")).toBeTruthy();
    expect(within(table).getByText("Unsubscribed")).toBeTruthy();
    expect(within(table).queryByLabelText("Mark Ursula Unsub unsubscribed")).toBeNull();
    expect(within(table).getAllByText("Phase 1").length).toBe(2);
    expect(within(table).getAllByText("14d").length).toBe(2); // days enrolled
    expect(within(table).getAllByText("14d (default)").length).toBe(2);
    expect(within(table).getByText("2026-02-24")).toBeTruthy(); // last contact
  });

  it("exits nurture through transitionCase and removes the row only after the server confirms", async () => {
    let resolveTransition: (v: { changed: boolean; case: TcCaseSummary }) => void = () => {};
    apiMock.transitionCase.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTransition = resolve;
        }),
    );

    render(<NurtureWorkspace office="roland" today={TODAY} />);

    const exitBtn = await screen.findByLabelText("Move Maria Lopez back to active pipeline");
    fireEvent.click(exitBtn);

    expect(apiMock.transitionCase).toHaveBeenCalledWith("roland", "case-maria", {
      status: "considering",
    });

    // Confirmed-save: the row stays until the promise resolves.
    const table = screen.getByRole("region", { name: "All Nurture Patients" });
    expect(within(table).getByText("Maria Lopez")).toBeTruthy();
    expect(toastMock.success).not.toHaveBeenCalled();

    await act(async () => {
      resolveTransition({ changed: true, case: { ...maria, status: "considering" } });
    });

    await waitFor(() =>
      expect(within(table).queryByText("Maria Lopez")).toBeNull(),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "Maria Lopez moved back to the active pipeline (Considering)",
    );
    // Her queue cards unjoin with the case.
    expect(screen.getByText("You're all caught up for today.")).toBeTruthy();
  });

  it("adds a financing touchpoint with a whole-dollar monthly figure from integer cents", async () => {
    const created = mkTouchpoint({
      followupId: "tp-fin",
      caseId: "case-maria",
      dueDate: TODAY,
      nurtureType: "financing",
      talkingPoint: "server copy",
    });
    apiMock.createFollowup.mockResolvedValue(created);

    render(<NurtureWorkspace office="roland" today={TODAY} />);

    fireEvent.click(
      await screen.findByLabelText("Add financing touchpoint for Maria Lopez"),
    );

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        "Financing touchpoint added for Maria Lopez",
      ),
    );
    expect(apiMock.createFollowup).toHaveBeenCalledTimes(1);
    const [officeArg, payload] = apiMock.createFollowup.mock.calls[0] as [
      string,
      { kind: string; nurtureType: string; channel: string; dueDate: string; talkingPoint: string },
    ];
    expect(officeArg).toBe("roland");
    expect(payload.kind).toBe("nurture");
    expect(payload.nurtureType).toBe("financing");
    expect(payload.channel).toBe("text");
    expect(payload.dueDate).toBe(TODAY);
    // 250_000 cents / 48 months → $52/month, whole dollars only.
    expect(payload.talkingPoint).toContain("as low as $52/month");
    expect(payload.talkingPoint).toContain("Hi Maria,");
  });
});
