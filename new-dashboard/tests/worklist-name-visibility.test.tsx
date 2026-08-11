/**
 * The worklist row: the patient's name is readable, and the actions stopped taking its
 * space.
 *
 * THE BUG (reported 2026-08-11): on a full-screen desktop window the patient name
 * truncated to a few characters. The Patient cell rendered `Matched: {name}` alongside a
 * labeled "Send to chart" AND a labeled "Send to TC", with the name `truncate`d and
 * `min-w-0` — so the two buttons won every pixel they wanted and the name got the rest.
 *
 * THE FIX: identity gets its cell to itself; all actions moved to one right-aligned
 * Actions column where at most one carries a word.
 *
 * jsdom has no layout, so these tests pin the STRUCTURE that makes the fix true rather
 * than measuring pixels: no action buttons in the Patient cell, at most one labeled
 * button per row, every remaining action still reachable by its accessible name, and a
 * `title` on every name so an over-long one is readable on hover.
 *
 * No PHI: every name below is a synthetic staging fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/calls", () => {}],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
    },
  }),
}));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "__all__",
  useOffice: () => ({
    office: "valley",
    offices: [{ officeId: "valley", officeName: "Valley Family Dental", odConnected: true }],
    selected: { officeId: "valley", officeName: "Valley Family Dental", odConnected: true },
  }),
}));

// The transcription hook owns budget confirmations and in-flight state; this file is about
// layout, so it is stubbed to a quiet idle.
vi.mock("@/hooks/useTranscribeCall", () => ({
  useTranscribeCall: () => ({
    isRunning: () => false,
    request: vi.fn(),
    pendingConfirm: null,
    pendingConfirmKind: null,
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
  }),
}));

const apiMock = vi.hoisted(() => ({
  getUnifiedCalls: vi.fn(),
  getSyncStatus: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { type UnifiedCall } from "@/lib/api";
import { CallWorklist } from "@/pages/calls/CallWorklist";

/** A name long enough that the old layout had nowhere to put it. */
const LONG_NAME = "Bartholomew Fitzgerald-Winthrop"; // 31 chars, synthetic

const baseCall = (over: Partial<UnifiedCall>): UnifiedCall => ({
  id: "c1",
  source: "retell",
  officeId: "valley",
  patientName: "Test Caller",
  fromNumber: "+15550000000",
  calledNumber: "+15551111111",
  duration: 120,
  date: "2026-08-11T15:00:00.000Z",
  summary: "",
  odPatientId: null,
  odPatientName: null,
  odSyncStatus: "needs_review",
  odMatchCandidates: [],
  notAPatient: false,
  notAPatientReason: null,
  hasTranscript: true,
  transcribeLastOutcome: null,
  triageStatus: "new",
  triageOutcome: null,
  triageBy: null,
  triageAt: null,
  tcCaseId: null,
  tcCaseUrl: null,
  linkRole: null,
  linkedCallId: null,
  isEmergency: false,
  appointmentBooked: false,
  appointmentRequested: false,
  callbackRequested: false,
  isNewPatient: false,
  insuranceMentioned: false,
  ...over,
} as unknown as UnifiedCall);

/**
 * @param calls the rows to serve
 * @param view  the default "needs" view hides resolved and not-a-patient rows
 *              (callNeedsAttention) — pass "all" to inspect those.
 */
async function renderWorklist(calls: UnifiedCall[], view: "needs" | "all" = "needs") {
  apiMock.getUnifiedCalls.mockResolvedValue({ calls, mangoWorklistMode: "all" });
  apiMock.getSyncStatus.mockResolvedValue({
    lastSyncedAt: "2026-08-11T17:19:00.000Z",
    nextAutoSync: "2026-08-11T18:15:00.000Z",
    mangoMode: "api",
  });
  render(React.createElement(CallWorklist));
  if (view === "all") fireEvent.click(screen.getByText("All calls"));
  await waitFor(() => expect(screen.getAllByTestId("row-actions").length).toBe(calls.length));
}

/** Buttons in a row's Actions cell that show a WORD, not just an icon. */
function labeledButtons(cell: HTMLElement): string[] {
  return within(cell)
    .queryAllByRole("button")
    .map((b) => (b.textContent ?? "").trim())
    .filter((t) => t.length > 0);
}

beforeEach(() => {
  apiMock.getUnifiedCalls.mockReset();
  apiMock.getSyncStatus.mockReset();
});
afterEach(cleanup);

describe("patient identity keeps its cell", () => {
  it("renders a long matched name in full, with no action button beside it", async () => {
    await renderWorklist([
      baseCall({ odPatientId: 7115, odPatientName: LONG_NAME }),
    ]);

    // The whole name is in the document — the old layout put buttons on this same line.
    const identity = screen.getByText(`Matched: ${LONG_NAME}`);
    expect(identity).toBeTruthy();

    // Truncation is CSS, so the guarantee jsdom CAN check is that the full name is
    // always available on hover.
    const titled = identity.closest("[title]");
    expect(titled?.getAttribute("title")).toContain(LONG_NAME);

    // Nothing clickable shares the identity cell. This is the regression that mattered.
    const identityCell = identity.closest("div.min-w-0");
    expect(identityCell).toBeTruthy();
    expect(within(identityCell as HTMLElement).queryAllByRole("button")).toHaveLength(0);
  });

  it("renders a long sent-to-chart name in full, as a link with the full name on hover", async () => {
    await renderWorklist([
      baseCall({ odPatientId: 7115, odPatientName: LONG_NAME, odSyncStatus: "synced" }),
    ]);

    const sent = screen.getByText(`Sent · ${LONG_NAME}`);
    expect(sent.closest("[title]")?.getAttribute("title")).toContain(LONG_NAME);
  });

  it("puts the caller's name behind a title too, for the same reason", async () => {
    await renderWorklist([baseCall({ patientName: LONG_NAME })]);

    const caller = screen.getByTitle(LONG_NAME);
    expect(caller.textContent).toBe(LONG_NAME);
  });
});

describe("one labeled action per row, the rest icons", () => {
  it("labels only Send to chart on a matched staff call that also needs transcribing", async () => {
    await renderWorklist([
      baseCall({ source: "mango", hasTranscript: false, odPatientId: 7115, odPatientName: LONG_NAME }),
    ]);

    const cell = screen.getByTestId("row-actions");
    expect(labeledButtons(cell)).toEqual(["Send to chart"]);

    // Transcribe, Send to TC, Follow up and Done are all still THERE — as icons that
    // name themselves.
    const names = within(cell).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toContain("Send to TC");
    expect(names).toContain("Flag for follow up");
    expect(names).toContain("Mark done — choose an outcome");
    expect(names.some((n) => n?.includes("Transcribe and summarize"))).toBe(true);
  });

  it("labels Transcribe when there is no chart step to take", async () => {
    await renderWorklist([baseCall({ source: "mango", hasTranscript: false })]);

    expect(labeledButtons(screen.getByTestId("row-actions"))).toEqual(["Transcribe"]);
  });

  it("shows no labeled button at all on a row whose next step is neither", async () => {
    await renderWorklist([baseCall({ odSyncStatus: "synced", odPatientId: 7115 })]);

    expect(labeledButtons(screen.getByTestId("row-actions"))).toEqual([]);
  });

  it("never shows more than one label across a mixed list", async () => {
    await renderWorklist([
      baseCall({ id: "a", odPatientId: 7115, odPatientName: "Stedi TestValley" }),
      baseCall({ id: "b", source: "mango", hasTranscript: false }),
      baseCall({ id: "c", odSyncStatus: "synced", odPatientId: 7116 }),
      baseCall({ id: "d", triageStatus: "done", triageOutcome: "scheduled" }),
    ], "all");

    for (const cell of screen.getAllByTestId("row-actions")) {
      expect(labeledButtons(cell).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("triage actions survive the move", () => {
  it("offers Follow up and Done as icons on an open row", async () => {
    await renderWorklist([baseCall({})]);

    const cell = screen.getByTestId("row-actions");
    expect(within(cell).getByLabelText("Flag for follow up")).toBeTruthy();
    expect(within(cell).getByLabelText("Mark done — choose an outcome")).toBeTruthy();
  });

  it("distinguishes an already-flagged row by its label, not by a word on the button", async () => {
    await renderWorklist([baseCall({ triageStatus: "needs_action" })]);

    const cell = screen.getByTestId("row-actions");
    expect(within(cell).getByLabelText("Following up — click to keep it flagged")).toBeTruthy();
    expect(labeledButtons(cell)).toEqual([]);
  });

  it("swaps to Reopen once the row is done, and shows the outcome as a signal", async () => {
    await renderWorklist([
      baseCall({
        triageStatus: "done",
        triageOutcome: "scheduled",
        triageBy: { name: "Sarah Front", email: "sarah@carein.ai" },
        triageAt: "2026-08-11T14:14:00.000Z",
      }),
    ], "all");

    const cell = screen.getByTestId("row-actions");
    expect(within(cell).getByLabelText("Reopen this call")).toBeTruthy();
    // The outcome and who resolved it are still on the row — they moved to the signals,
    // where facts live, rather than disappearing with the buttons.
    expect(screen.getByText("Scheduled")).toBeTruthy();
    expect(screen.getByText(/^Sarah,/)).toBeTruthy();
  });
});

describe("actions that must not appear", () => {
  it("offers no chart or TC action when OD is not connected for the call's office", async () => {
    apiMock.getUnifiedCalls.mockResolvedValue({
      calls: [baseCall({ officeId: "unknown", odPatientId: 7115, odPatientName: LONG_NAME })],
      mangoWorklistMode: "all",
    });
    apiMock.getSyncStatus.mockResolvedValue({ lastSyncedAt: null, nextAutoSync: null, mangoMode: "api" });
    render(React.createElement(CallWorklist));
    await waitFor(() => expect(screen.getAllByTestId("row-actions").length).toBe(1));

    const cell = screen.getByTestId("row-actions");
    expect(labeledButtons(cell)).toEqual([]);
    const names = within(cell).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).not.toContain("Send to TC");
    // Triage is always available — it doesn't depend on Open Dental.
    expect(names).toContain("Flag for follow up");
  });

  it("offers no chart or TC action on a not-a-patient close-out", async () => {
    await renderWorklist([
      baseCall({ notAPatient: true, notAPatientReason: "spam", odPatientId: 7115 }),
    ], "all");

    const cell = screen.getByTestId("row-actions");
    expect(labeledButtons(cell)).toEqual([]);
    const names = within(cell).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).not.toContain("Send to TC");
  });
});
