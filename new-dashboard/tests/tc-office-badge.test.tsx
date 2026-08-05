/**
 * Location badge visibility (jsdom via the .tsx glob).
 *
 * DentaFlow only badged rows in "both" mode; the platform port does the same:
 * badges appear when the queue is fanned out over more than one office and
 * never in single-office mode. Also pins that a fanned-out queue calls the
 * per-office API once per office and writes back to the ROW's office.
 *
 * Same harness as tests/tc-followups-queue.test.tsx: @/features/tc/api and
 * sonner are mocked, office is a prop (no OfficeContext), `today` is pinned.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
    Pick<TcDueFollowup, "followupId" | "patientName" | "officeId">,
): TcDueFollowup {
  return {
    caseId: `case-${overrides.followupId}`,
    dueDate: TODAY,
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

const rolandRow = mkFollowup({
  followupId: "fu-roland",
  patientName: "Rita Roland",
  officeId: "roland",
});
const valleyRow = mkFollowup({
  followupId: "fu-valley",
  patientName: "Victor Valley",
  officeId: "valley",
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("office badges", () => {
  it("shows no badges in single-office mode", async () => {
    apiMock.followupsDue.mockResolvedValue([rolandRow]);

    render(<FollowupQueue office="roland" today={TODAY} />);

    await screen.findByText("Rita Roland");
    expect(screen.queryAllByTestId("office-badge")).toHaveLength(0);
    expect(apiMock.followupsDue).toHaveBeenCalledTimes(1);
    expect(apiMock.followupsDue).toHaveBeenCalledWith("roland", { date: TODAY });
  });

  it("shows no badges when the all-offices scope holds a single office", async () => {
    apiMock.followupsDue.mockResolvedValue([rolandRow]);

    render(<FollowupQueue office={["roland"]} today={TODAY} />);

    await screen.findByText("Rita Roland");
    expect(screen.queryAllByTestId("office-badge")).toHaveLength(0);
  });

  it("badges every row and queries each office once in all-offices mode", async () => {
    apiMock.followupsDue.mockImplementation(async (office: string) =>
      office === "roland" ? [rolandRow] : [valleyRow],
    );

    render(<FollowupQueue office={["roland", "valley"]} today={TODAY} />);

    await screen.findByText("Rita Roland");
    expect(screen.getByText("Victor Valley")).toBeTruthy();
    expect(apiMock.followupsDue.mock.calls.map((c) => c[0])).toEqual(["roland", "valley"]);

    const badges = screen.getAllByTestId("office-badge");
    expect(badges).toHaveLength(2);
    expect(badges.map((b) => b.textContent)).toEqual(["Roland", "Valley"]);
  });

  it("writes a completion back to the row's office, not the page scope", async () => {
    apiMock.followupsDue.mockImplementation(async (office: string) =>
      office === "roland" ? [rolandRow] : [valleyRow],
    );
    apiMock.completeFollowup.mockResolvedValue({ ...valleyRow, status: "completed" });

    render(<FollowupQueue office={["roland", "valley"]} today={TODAY} />);

    const region = await screen.findByRole("region", { name: "Due today" });
    const valleyCard = within(region).getByText("Victor Valley").closest("div.rounded-xl");
    expect(valleyCard).toBeTruthy();
    fireEvent.click(within(valleyCard as HTMLElement).getByRole("button", { name: "Complete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark complete" }));

    await waitFor(() =>
      expect(apiMock.completeFollowup).toHaveBeenCalledWith("valley", "fu-valley", {
        patientResponded: false,
      }),
    );
  });

  it("keeps the healthy office's rows and warns when one office fails", async () => {
    apiMock.followupsDue.mockImplementation(async (office: string) => {
      if (office === "valley") throw new Error("Valley is down");
      return [rolandRow];
    });

    render(<FollowupQueue office={["roland", "valley"]} today={TODAY} />);

    await screen.findByText("Rita Roland");
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("Showing partial data");
    expect(notice.textContent).toContain("Valley");
    // Not a blank page and not a hard error banner.
    expect(screen.queryByText("Queue clear")).toBeNull();
  });
});
