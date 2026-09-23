/**
 * Worklist rows carry the call's absolute date and time.
 *
 * THE PROBLEM: a row said "1:30 · 3h ago". Relative age is the right thing when
 * you are working today's list, and useless the moment you are not — "3h ago" on
 * a row you open tomorrow morning cannot tell you which of yesterday's calls it
 * was, and "2d ago" spans two working days. The absolute stamp answers it
 * without leaving the list.
 *
 * The year is dropped for calls from the current year, because on the rows people
 * actually work it is noise. It reappears the moment it is the thing that
 * disambiguates, so a year-old call can never read as last week's.
 *
 * Everything resolves in the practice's zone — see `lib/callTime.ts` for why the
 * viewer's zone is the wrong answer.
 *
 * No PHI: every name and number below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

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
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice"] },
      role: "office",
      isSuperAdmin: false,
      permissions: ["voice.read", "voice.write"],
      homeOffice: null,
    },
  }),
}));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "__all__",
  useOffice: () => ({
    office: "roland",
    offices: [{ officeId: "roland", officeName: "Valley Family Dental at Roland", odConnected: true }],
    selected: { officeId: "roland", officeName: "Valley Family Dental at Roland", odConnected: true },
  }),
}));

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

import type { UnifiedCall } from "@/lib/api";
import { CallWorklist } from "@/pages/calls/CallWorklist";
import { formatCallStamp, formatCallStampCompact, OFFICE_TIME_ZONE } from "@/lib/callTime";

// ─────────────────────────────────────────────────────────────────────────────
// The formatter
// ─────────────────────────────────────────────────────────────────────────────

/** A fixed "now" so "this year" is a decision the test makes, not the calendar. */
const NOW = new Date("2026-09-22T18:00:00.000Z");

describe("formatCallStampCompact", () => {
  it("drops the year for a call from the current year", () => {
    expect(formatCallStampCompact("2026-09-22T12:57:00.000Z", NOW)).toBe("Sep 22, 7:57 AM");
  });

  it("keeps the year when the call is from a different one", () => {
    expect(formatCallStampCompact("2025-09-22T12:57:00.000Z", NOW)).toBe("Sep 22, 2025, 7:57 AM");
  });

  it("decides 'this year' in the office's zone, not UTC", () => {
    // 11:30 PM on New Year's Eve in Roland is already the next year in UTC.
    // Comparing UTC years would stamp a year onto a call from tonight.
    const newYearsEve = "2026-12-31T23:30:00-06:00";
    const laterThatNight = new Date("2026-12-31T23:59:00-06:00");
    expect(formatCallStampCompact(newYearsEve, laterThatNight)).toBe("Dec 31, 11:30 PM");
  });

  it("follows DST rather than a fixed offset", () => {
    // Both are 7:57 AM in Roland; the UTC instants differ by an hour.
    expect(formatCallStampCompact("2026-09-22T12:57:00.000Z", NOW)).toBe("Sep 22, 7:57 AM");
    expect(formatCallStampCompact("2026-01-15T13:57:00.000Z", NOW)).toBe("Jan 15, 7:57 AM");
  });

  it("returns null for anything unparseable", () => {
    expect(formatCallStampCompact("not-a-date", NOW)).toBeNull();
    expect(formatCallStampCompact("", NOW)).toBeNull();
    expect(formatCallStampCompact(undefined, NOW)).toBeNull();
    expect(formatCallStampCompact(null, NOW)).toBeNull();
  });
});

describe("the shared module is the single source", () => {
  it("the detail-page stamp still carries its year and separator", () => {
    expect(formatCallStamp("2026-09-22T12:57:00.000Z")).toBe("Sep 22, 2026 · 7:57 AM");
  });

  it("exports one office zone", () => {
    expect(OFFICE_TIME_ZONE).toBe("America/Chicago");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sep 22 is CDT in every year, so 12:57Z is 7:57 AM whichever year we build —
 * which lets these fixtures follow the calendar instead of going stale each
 * January, while still exercising both the current-year and prior-year branches.
 */
const THIS_YEAR = Number(
  new Date().toLocaleDateString("en-US", { timeZone: OFFICE_TIME_ZONE, year: "numeric" }),
);
const THIS_YEAR_CALL = `${THIS_YEAR}-09-22T12:57:00.000Z`;
const LAST_YEAR_CALL = `${THIS_YEAR - 1}-09-22T12:57:00.000Z`;

const baseCall = (over: Partial<UnifiedCall>): UnifiedCall => ({
  id: "c1",
  source: "mango",
  officeId: "roland",
  patientName: "Synthetic Caller",
  fromNumber: "+15550000000",
  calledNumber: "+15551111111",
  duration: 90,
  date: THIS_YEAR_CALL,
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
  disposition: null,
  dispositionBy: null,
  dispositionAt: null,
  notes: [],
  recordKind: "call",
  isPruned: false,
  prunedAt: null,
  retentionActions: [],
  ...over,
} as unknown as UnifiedCall);

async function renderWorklist(calls: UnifiedCall[], view: "needs" | "all" = "needs") {
  apiMock.getUnifiedCalls.mockResolvedValue({ calls, mangoWorklistMode: "all" });
  apiMock.getSyncStatus.mockResolvedValue({ lastSyncedAt: null, nextAutoSync: null, mangoMode: "api" });
  render(React.createElement(CallWorklist));
  if (view === "all") fireEvent.click(screen.getByText("All calls"));
  await waitFor(() => expect(apiMock.getUnifiedCalls).toHaveBeenCalled());
}

function metaText(): string {
  return screen.getAllByTestId("row-meta")[0].textContent ?? "";
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

describe("the worklist row shows when the call came in", () => {
  it("duration · stamp · relative age, in that order", async () => {
    await renderWorklist([baseCall({})]);

    await waitFor(() => expect(screen.getAllByTestId("row-meta").length).toBeGreaterThan(0));
    const meta = metaText();
    expect(meta).toContain("1:30");
    expect(meta).toContain("Sep 22, 7:57 AM");
    // Order matters — the stamp sits between the duration and the age.
    expect(meta.indexOf("1:30")).toBeLessThan(meta.indexOf("Sep 22, 7:57 AM"));
    expect(meta.indexOf("Sep 22, 7:57 AM")).toBeLessThan(meta.indexOf("ago"));
  });

  it("a prior-year call carries its year", async () => {
    await renderWorklist([baseCall({ date: LAST_YEAR_CALL })], "all");

    await waitFor(() => expect(screen.getAllByTestId("row-meta").length).toBeGreaterThan(0));
    expect(metaText()).toContain(`Sep 22, ${THIS_YEAR - 1}, 7:57 AM`);
  });

  it("an unparseable timestamp drops the stamp and keeps the rest of the line", async () => {
    await renderWorklist([baseCall({ date: "not-a-date" })], "all");

    await waitFor(() => expect(screen.getAllByTestId("row-meta").length).toBeGreaterThan(0));
    const meta = metaText();
    // The stamp is gone rather than rendered as a defect...
    expect(meta).not.toContain("Invalid Date");
    expect(meta).not.toMatch(/\b\w+ \d+, \d{1,2}:\d{2} [AP]M/);
    // ...the duration survives, and no dangling separator is left behind.
    expect(meta).toContain("1:30");
    expect(meta).not.toContain("· ·");
    expect(meta.trim().endsWith("·")).toBe(false);

    // NOT asserted: the relative age. `formatTimeAgo` in lib/utils.ts is itself
    // unguarded and renders "NaNd ago" for an unparseable date — a PRE-EXISTING
    // defect this branch neither introduced nor fixed. It is shared by 13 call
    // sites across the dashboard, so guarding it belongs in its own change.
  });

  it("the same row renders in both views", async () => {
    // "Needs attention" and "All calls" are filters over one list and one row
    // component, so the stamp cannot be present in one and missing in the other.
    await renderWorklist([baseCall({})], "all");

    await waitFor(() => expect(screen.getAllByTestId("row-meta").length).toBeGreaterThan(0));
    expect(metaText()).toContain("Sep 22, 7:57 AM");
  });

  it("a pruned row stamps too — its date is all that is left of it", async () => {
    await renderWorklist(
      [baseCall({ recordKind: "stub", isPruned: true, prunedAt: THIS_YEAR_CALL } as Partial<UnifiedCall>)],
      "all",
    );

    await waitFor(() => expect(screen.getAllByTestId("pruned-date").length).toBeGreaterThan(0));
    const pruned = within(screen.getAllByTestId("pruned-date")[0]);
    expect(pruned.getByText(/Sep 22, 7:57 AM/)).toBeTruthy();
  });
});
