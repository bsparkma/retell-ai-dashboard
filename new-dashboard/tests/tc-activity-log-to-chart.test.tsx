/**
 * AT-2: "Log to chart" on the Activity tab.
 *
 * Pins: the button shows ONLY on items the server marked chartable, never on
 * one already on the chart, and never when the server did not say (older
 * server); disabled with the server's named reason when the office cannot
 * write; the dialog states the office and "Open Dental chart note — CareIN
 * TC"; the FINAL text (trimmed, OD-safe, plus the conversation-date line) is
 * shown above Confirm and is exactly what is sent; a refusal keeps the dialog
 * open with the server's sentence; nothing writes until Confirm.
 *
 * Synthetic data only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

import { activityChartFinalText, type TcActivityChartPreview, type TcActivityItem } from "@shared/tc/activity";
import { ActivityFeed } from "@/features/tc/caseview/ActivityFeed";
import { logToChartFinalText } from "@/features/tc/caseview/LogToChartDialog";

vi.mock("@/features/tc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/features/tc/api")>();
  return { ...actual, getCaseActivity: vi.fn(), getActivityChartPreview: vi.fn(), logActivityToChart: vi.fn() };
});

import { TcApiError, getActivityChartPreview, getCaseActivity, logActivityToChart } from "../client/src/features/tc/api";

const activityMock = vi.mocked(getCaseActivity);
const previewMock = vi.mocked(getActivityChartPreview);
const writeMock = vi.mocked(logActivityToChart);
const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const ELIGIBLE = { eligible: true, code: null, reason: null };

function item(overrides: Partial<TcActivityItem> & Pick<TcActivityItem, "id" | "source">): TcActivityItem {
  return {
    kind: "note",
    at: "2026-11-10T15:00:00.000Z",
    actor: { display: "tc@carein.ai", email: "tc@carein.ai", system: false },
    audience: "internal",
    title: "Note",
    body: "Patient will call after the holidays.",
    scope: "case",
    links: {},
    chart: { onChart: false, via: null },
    completeness: "full",
    ...overrides,
  };
}

const NOTE = item({ id: "case_event:e1", source: "case_event", chartable: ELIGIBLE });
const SYSTEM = item({
  id: "case_event:e2",
  source: "case_event",
  kind: "nurture_enrolled",
  title: "Nurture enrolled",
  actor: { display: "CareIN", email: null, system: true },
  chartable: { eligible: false, code: "NOT_CHARTABLE_SYSTEM", reason: "Automatic and system events are not charted." },
});
const CHARTED = item({
  id: "case_event:e3",
  source: "case_event",
  chart: { onChart: true, via: "tc", commLogNum: 70001 },
  chartable: { eligible: false, code: "ALREADY_ON_CHART", reason: "Already on the chart." },
});

function preview(over: Partial<TcActivityChartPreview> = {}): TcActivityChartPreview {
  return {
    itemId: NOTE.id,
    chartable: ELIGIBLE,
    defaultText: "CareIN TC - Note 11/10/2026 9:00 AM by tc@carein.ai\nPatient will call after the holidays.",
    maxLength: 2000,
    office: { id: "roland", name: "Roland" },
    commType: { name: "CareIN TC" },
    hasPatient: true,
    availability: { available: true, code: null, message: null },
    onChart: null,
    ...over,
  };
}

beforeEach(() => {
  activityMock.mockReset();
  previewMock.mockReset();
  writeMock.mockReset();
});
afterEach(() => cleanup());

const rowOf = (title: string) => screen.getAllByTestId("tc-activity-row").find((r) => within(r).queryByText(title) !== null)!;

describe("Log to chart (AT-2)", () => {
  it("shows the button only on chartable items, never on one already on the chart", async () => {
    activityMock.mockResolvedValue({
      items: [NOTE, SYSTEM, CHARTED],
      nextCursor: null,
      chartWrite: { available: true, code: null, message: null },
    });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("tc-activity-row")).toHaveLength(3));
    expect(screen.getAllByTestId("tc-activity-log-to-chart")).toHaveLength(1);
    expect(within(rowOf("Nurture enrolled")).queryByTestId("tc-activity-log-to-chart")).toBeNull();
    expect(screen.getByText("On chart · TC note")).toBeTruthy();
    expect(previewMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("an older server that does not say whether it can write → no button at all", async () => {
    activityMock.mockResolvedValue({ items: [NOTE], nextCursor: null });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    await waitFor(() => expect(screen.getAllByTestId("tc-activity-row")).toHaveLength(1));
    expect(screen.queryByTestId("tc-activity-log-to-chart")).toBeNull();
  });

  it("disabled with the server's named reason when the office cannot write", async () => {
    activityMock.mockResolvedValue({
      items: [NOTE],
      nextCursor: null,
      chartWrite: {
        available: false,
        code: "TC_COMMTYPE_NOT_CONFIGURED",
        message: 'No "CareIN TC" chart note type is configured for Roland, so nothing can be written to its charts',
      },
    });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    const button = await screen.findByTestId("tc-activity-log-to-chart");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("tc-activity-log-to-chart-blocked").textContent).toMatch(/No "CareIN TC" chart note type/);
  });

  it("the dialog states the office and type, shows the exact final text, and sends exactly that", async () => {
    activityMock.mockResolvedValue({ items: [NOTE], nextCursor: null, chartWrite: { available: true, code: null, message: null } });
    previewMock.mockResolvedValue(preview());
    writeMock.mockResolvedValue({ itemId: NOTE.id, commLogNum: 70001, writtenAt: "2026-11-12T16:30:00.000Z", chart: { onChart: true, via: "tc", commLogNum: 70001 } });
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    fireEvent.click(await screen.findByTestId("tc-activity-log-to-chart"));

    const dialog = await screen.findByTestId("tc-log-to-chart-dialog");
    await waitFor(() => expect(within(dialog).getByText("Roland · Open Dental chart note — CareIN TC")).toBeTruthy());
    expect(previewMock).toHaveBeenCalledWith("roland", CASE_ID, NOTE.id);
    expect(writeMock).not.toHaveBeenCalled();

    const box = within(dialog).getByTestId("tc-log-to-chart-text") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  Patient said “after New Year” — call back.  " } });
    fireEvent.change(within(dialog).getByTestId("tc-log-to-chart-date"), { target: { value: "2026-11-10" } });
    const expected = 'Patient said "after New Year" -- call back.\n[Conversation date: 11/10/2026]';
    expect(within(dialog).getByTestId("tc-log-to-chart-final").textContent).toBe(expected);

    fireEvent.click(within(dialog).getByTestId("tc-log-to-chart-confirm"));
    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
    expect(writeMock).toHaveBeenCalledWith("roland", CASE_ID, NOTE.id, {
      text: 'Patient said "after New Year" -- call back.',
      conversationDate: "2026-11-10",
    });
    // What the server stores from that body is exactly what was shown.
    expect(activityChartFinalText('Patient said "after New Year" -- call back.', "2026-11-10")).toBe(expected);
    await waitFor(() => expect(screen.getByText("On chart · TC note")).toBeTruthy());
    expect(screen.queryByTestId("tc-activity-log-to-chart")).toBeNull();
  });

  it("a refusal keeps the dialog open with the server's sentence; nothing reads as written", async () => {
    activityMock.mockResolvedValue({ items: [NOTE], nextCursor: null, chartWrite: { available: true, code: null, message: null } });
    previewMock.mockResolvedValue(preview());
    writeMock.mockRejectedValue(
      new TcApiError(
        "The note was written to the chart (Open Dental note 70001) but could not be recorded here. Do not write it again.",
        500,
        "TC_CHART_WRITTEN_UNRECORDED",
        null,
        [],
      ),
    );
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    fireEvent.click(await screen.findByTestId("tc-activity-log-to-chart"));
    const dialog = await screen.findByTestId("tc-log-to-chart-dialog");
    await waitFor(() => expect((within(dialog).getByTestId("tc-log-to-chart-confirm") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByTestId("tc-log-to-chart-confirm"));
    await waitFor(() => expect(within(dialog).getByTestId("tc-log-to-chart-error").textContent).toMatch(/Do not write it again/));
    expect(screen.queryByText("On chart · TC note")).toBeNull();
  });

  it("Confirm is disabled (with the reason) when the preview says writes are off or the text is too long", async () => {
    activityMock.mockResolvedValue({ items: [NOTE], nextCursor: null, chartWrite: { available: true, code: null, message: null } });
    previewMock.mockResolvedValue(
      preview({ availability: { available: false, code: "OD_WRITE_DISABLED", message: "Open Dental writes are switched off in this environment." } }),
    );
    render(<ActivityFeed office="roland" caseId={CASE_ID} />);
    fireEvent.click(await screen.findByTestId("tc-activity-log-to-chart"));
    const dialog = await screen.findByTestId("tc-log-to-chart-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("tc-log-to-chart-blocked").textContent).toMatch(/switched off/));
    expect((within(dialog).getByTestId("tc-log-to-chart-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(logToChartFinalText("x".repeat(2001), "").length).toBe(2001);
  });
});
