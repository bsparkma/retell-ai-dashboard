/**
 * Item 42 — the Conversion section and the win overlay's SERVED rate.
 *
 * The SQL behind these numbers is verified against a real Postgres by
 * backend/scripts/tc-funnel-verify-queries.js. These tests hold the CLIENT to
 * its side of the honesty rules:
 *  - the section renders only what GET /api/tc/reports/funnel served, and makes
 *    no case-summary request of its own;
 *  - "—" for a rate with no denominator, the coverage caption on the tiles,
 *    the server's coverage note when there is no history;
 *  - the overlay shows a rate ONLY when the server served one for the case's
 *    office, and never when the request fails or the trigger has no office;
 *  - the client's board-stage list is the server's.
 */
import * as React from "react";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = NoopResizeObserver;

const apiMock = vi.hoisted(() => ({
  getConversionFunnel: vi.fn(),
  listCases: vi.fn(),
  listFollowups: vi.fn(),
  tcErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : "error")),
}));
vi.mock("@/features/tc/api", () => apiMock);

import { ConversionSection } from "@/features/tc/reports/ConversionSection";
import {
  FunnelReportSchema,
  formatPercent,
  parseServedFunnel,
  presetFromDate,
  servedAcceptanceRate,
} from "@/features/tc/reports/funnel";
import { WinCelebrationProvider, useWinCelebration } from "@/features/tc/wins/WinCelebrationProvider";
import { BOARD_STATUSES } from "@/features/tc/status";

const require = createRequire(import.meta.url);

/** A served body shaped exactly like the backend's shapeFunnel output. */
function servedBody(over: Partial<Record<string, unknown>> = {}) {
  const stages = BOARD_STATUSES.map((status) => ({
    status,
    entered: status === "presented" ? 4 : 0,
    progressed: status === "presented" ? 2 : 0,
    lostAfter: status === "presented" ? 1 : 0,
    conversionPercent: status === "presented" ? 50 : null,
    completedStays: status === "presented" ? 3 : 0,
    openStays: status === "presented" ? 1 : 0,
    medianDays: status === "presented" ? 4 : null,
    p90Days: status === "presented" ? 4 : null,
  }));
  return {
    office: "roland",
    timeZone: "America/Chicago",
    window: {
      requestedFrom: "2026-07-11",
      to: "2026-10-08",
      fromTs: "2026-08-20T15:00:00.000Z",
      toTs: "2026-10-09T05:00:00.000Z",
      clampedToCoverage: true,
    },
    coverageStartsAt: "2026-08-20T15:00:00.000Z",
    coverageNote:
      "Transition history starts here; the window was shortened to begin at the first reliably recorded status change.",
    reliableEntries: 22,
    acceptance: {
      presentedCases: 4,
      acceptedCases: 2,
      acceptanceRatePercent: 50,
      presentedValueCents: 850000,
      acceptedValueCents: 700000,
      valueAcceptanceRatePercent: 82.4,
    },
    stages,
    acceptedByWeek: [
      { weekStart: "2026-08-31", wonCases: 1, wonValueCents: 200000 },
      { weekStart: "2026-09-07", wonCases: 3, wonValueCents: 1200000 },
    ],
    winLoss: {
      wonCases: 4,
      wonValueCents: 1400000,
      lostCases: 1,
      winRatePercent: 80,
      byLostReason: [{ reason: "moved", lostCases: 1 }],
    },
    byAssignedTc: [
      { name: "tc.a@fixture.invalid", presentedCases: 2, acceptedCases: 2, acceptedValueCents: 700000, acceptanceRatePercent: 100 },
      { name: "", presentedCases: 2, acceptedCases: 0, acceptedValueCents: 0, acceptanceRatePercent: 0 },
    ],
    byDoctor: [],
    nurtureReactivations: { cases: 1, valueCents: 400000 },
    ...over,
  };
}

function emptyBody() {
  return servedBody({
    coverageStartsAt: null,
    coverageNote:
      "No reliably recorded status changes yet for this office — imported legacy history carries no from-status, so there is nothing to compute a funnel from.",
    reliableEntries: 0,
    window: {
      requestedFrom: "2026-07-11",
      to: "2026-10-08",
      fromTs: "2026-07-11T05:00:00.000Z",
      toTs: "2026-10-09T05:00:00.000Z",
      clampedToCoverage: false,
    },
    acceptance: {
      presentedCases: 0,
      acceptedCases: 0,
      acceptanceRatePercent: null,
      presentedValueCents: 0,
      acceptedValueCents: 0,
      valueAcceptanceRatePercent: null,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("funnel parsing and the served-rate brand", () => {
  it("parses a served body and mints a rate carrying its count and window", () => {
    const f = parseServedFunnel(servedBody());
    const rate = servedAcceptanceRate(f);
    expect(rate).not.toBeNull();
    expect(rate?.percent).toBe(50);
    expect(rate?.acceptedCases).toBe(2);
    expect(rate?.presentedCases).toBe(4);
    expect(rate?.clampedToCoverage).toBe(true);
    expect(rate?.windowFromTs).toBe("2026-08-20T15:00:00.000Z");
  });

  it("serves NO rate when nothing was presented — null, not 0%", () => {
    expect(servedAcceptanceRate(parseServedFunnel(emptyBody()))).toBeNull();
  });

  it("refuses a body that is not the server's shape", () => {
    expect(() => parseServedFunnel({ acceptance: { acceptanceRatePercent: 50 } })).toThrow();
    const bad = servedBody({ stages: [{ status: "not_a_status" }] });
    expect(FunnelReportSchema.safeParse(bad).success).toBe(false);
    const stringRate = servedBody();
    (stringRate.acceptance as Record<string, unknown>).acceptanceRatePercent = "50";
    expect(FunnelReportSchema.safeParse(stringRate).success).toBe(false);
  });

  it("formats null as a dash and presets as local calendar dates", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(82.4)).toBe("82.4%");
    expect(formatPercent(50)).toBe("50%");
    expect(presetFromDate(90, new Date(2026, 9, 8, 12))).toBe("2026-07-11");
    expect(presetFromDate(1, new Date(2026, 9, 8, 12))).toBe("2026-10-08");
  });

  it("the client's 9 board stages are the server's, in the same order", () => {
    const server = require("../../backend/routes/tc/funnel.js") as { BOARD_STAGES: readonly string[] };
    expect([...server.BOARD_STAGES]).toEqual(BOARD_STATUSES);
    expect(BOARD_STATUSES).toHaveLength(9);
  });
});

describe("ConversionSection", () => {
  it("renders only served numbers, with the coverage caption, from ONE request", async () => {
    apiMock.getConversionFunnel.mockResolvedValue(parseServedFunnel(servedBody()));
    render(<ConversionSection office="roland" />);

    await screen.findByTestId("tile-acceptance");
    expect(apiMock.getConversionFunnel).toHaveBeenCalledTimes(1);
    const [office, window] = apiMock.getConversionFunnel.mock.calls[0] as [string, { from?: string }];
    expect(office).toBe("roland");
    expect(window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The section never reads case summaries.
    expect(apiMock.listCases).not.toHaveBeenCalled();
    expect(apiMock.listFollowups).not.toHaveBeenCalled();

    expect(screen.getByTestId("tile-acceptance").textContent).toContain("50%");
    expect(screen.getByTestId("tile-acceptance").textContent).toContain("2 of 4 presented accepted");
    expect(screen.getByTestId("tile-value").textContent).toContain("82.4%");
    expect(screen.getByTestId("tile-won").textContent).toContain("win rate 80%");
    expect(screen.getByTestId("funnel-coverage").textContent).toMatch(/^Since Aug 20, 2026, when status history begins/);
    expect(screen.getByTestId("funnel-coverage-note")).toBeTruthy();
    // Unknown conversion renders as a dash in the time-in-stage table.
    expect(screen.getByTestId("time-in-stage").textContent).toContain("—");
    // A blank assignee is labeled, not rendered as an empty row.
    expect(screen.getByText("Unassigned")).toBeTruthy();
  });

  it("an office with no history shows the server's coverage note and no tiles", async () => {
    apiMock.getConversionFunnel.mockResolvedValue(parseServedFunnel(emptyBody()));
    render(<ConversionSection office="valley" />);
    const empty = await screen.findByTestId("funnel-no-history");
    expect(empty.textContent).toContain("No reliably recorded status changes yet");
    expect(screen.queryByTestId("tile-acceptance")).toBeNull();
    expect(screen.getByTestId("funnel-coverage").textContent).toBe("No recorded status changes yet");
  });

  it("a failed load says so and shows no numbers", async () => {
    apiMock.getConversionFunnel.mockRejectedValue(new Error("Internal error"));
    render(<ConversionSection office="roland" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the conversion funnel");
    expect(screen.queryByTestId("tile-acceptance")).toBeNull();
  });

  it("changing the window re-asks the server with a new start date", async () => {
    apiMock.getConversionFunnel.mockResolvedValue(parseServedFunnel(servedBody()));
    render(<ConversionSection office="roland" />);
    await screen.findByTestId("tile-acceptance");
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    await waitFor(() => expect(apiMock.getConversionFunnel).toHaveBeenCalledTimes(2));
    const first = (apiMock.getConversionFunnel.mock.calls[0] as [string, { from: string }])[1].from;
    const second = (apiMock.getConversionFunnel.mock.calls[1] as [string, { from: string }])[1].from;
    expect(second > first).toBe(true);
  });
});

describe("WinCelebration — the served rate", () => {
  function Fire({ office }: { office?: "roland" | "valley" }) {
    const { celebrateWin } = useWinCelebration();
    return (
      <button
        type="button"
        onClick={() =>
          celebrateWin(
            { caseId: "c1", patientName: "Fixture Patient", caseValueCents: 480000, ...(office ? { office } : {}) },
            null,
          )
        }
      >
        fire
      </button>
    );
  }

  it("shows the server's rate, count and window when the funnel answers", async () => {
    apiMock.getConversionFunnel.mockResolvedValue(parseServedFunnel(servedBody()));
    render(
      <WinCelebrationProvider>
        <Fire office="roland" />
      </WinCelebrationProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    const line = await screen.findByTestId("win-served-rate");
    expect(line.textContent).toContain("Acceptance rate 50%");
    expect(line.textContent).toContain("2 of 4 presented");
    expect(line.textContent).toContain("since Aug 20, 2026");
    expect(apiMock.getConversionFunnel).toHaveBeenCalledWith("roland", expect.objectContaining({ from: expect.any(String) }));
  });

  it("no office on the trigger → no request and no rate", async () => {
    render(
      <WinCelebrationProvider>
        <Fire />
      </WinCelebrationProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    await screen.findByText("Case Accepted!");
    expect(apiMock.getConversionFunnel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("win-served-rate")).toBeNull();
  });

  it("a failed or empty funnel leaves the rate off — never a placeholder", async () => {
    apiMock.getConversionFunnel.mockRejectedValueOnce(new Error("down"));
    const { unmount } = render(
      <WinCelebrationProvider>
        <Fire office="roland" />
      </WinCelebrationProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    await screen.findByText("Case Accepted!");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("win-served-rate")).toBeNull();
    unmount();

    apiMock.getConversionFunnel.mockResolvedValueOnce(parseServedFunnel(emptyBody()));
    render(
      <WinCelebrationProvider>
        <Fire office="valley" />
      </WinCelebrationProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    await screen.findByText("Case Accepted!");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("win-served-rate")).toBeNull();
  });
});
