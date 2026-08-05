/**
 * TC GlobalSearch (PM ruling 9) — the ⌘K command palette.
 *
 * Covers the three things that make it an enhancement rather than a reskin of
 * DentaFlow's click-only header input: debounced requests, stale responses
 * being dropped, and a failed search surfacing a real error instead of an
 * empty list. Plus result mapping and the ⌘K / Escape keyboard contract.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

// Classic-runtime React global (see tests/tc-followups-queue.test.tsx).
(globalThis as Record<string, unknown>).React = React;

// jsdom ships neither ResizeObserver nor scrollIntoView; cmdk uses both.
if (!("ResizeObserver" in globalThis)) {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const apiMock = vi.hoisted(() => ({
  listCases: vi.fn(),
  tcErrorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong.",
  ),
}));
vi.mock("@/features/tc/api", () => apiMock);

const officeMock = vi.hoisted(() => ({ office: "roland" as string }));
vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  useOffice: () => ({
    office: officeMock.office,
    offices: [
      { officeId: "roland", officeName: "Roland Family Dental" },
      { officeId: "valley", officeName: "Valley Family Dental" },
    ],
    loading: false,
    setOffice: vi.fn(),
  }),
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("wouter", () => ({
  useLocation: () => ["/tc/dashboard", navigateMock],
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import type { OfficeId } from "@shared/tc/contract";
import type { TcCaseSummary } from "@/features/tc/api";
import { MIN_QUERY_LENGTH, matchCases } from "@/features/tc/search/matchCases";
import { SEARCH_DEBOUNCE_MS, useTcCaseSearch } from "@/features/tc/search/useTcCaseSearch";
import { TcGlobalSearch } from "@/features/tc/search/TcGlobalSearch";

function makeCase(overrides: Partial<TcCaseSummary> & { caseId: string }): TcCaseSummary {
  return {
    legacyId: null,
    officeId: "roland",
    patientName: "Pat Fixture",
    patientAge: null,
    phone: null,
    email: null,
    odPatientId: null,
    caseType: "Crown",
    category: "single_tooth",
    status: "presented",
    urgency: "medium",
    doctorName: "Dr. Fixture",
    diagnosingProvider: null,
    assignedTc: "Alex Fixture",
    caseValueCents: 100_000,
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
    statusChangedAt: "2026-08-01T12:00:00.000Z",
    nurtureCadence: "standard",
    inLongTailMode: false,
    nurtureEnrolledAt: null,
    nurturePhaseChangedAt: null,
    nurturePhase1DaysOverride: null,
    nurturePhase2DaysOverride: null,
    nurtureUnsubscribed: false,
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  officeMock.office = "roland";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── Pure matching / mapping ────────────────────────────────────────────────

describe("matchCases", () => {
  const cases = [
    makeCase({
      caseId: "c1",
      patientName: "Alice Alvarez",
      caseType: "Implant",
      caseValueCents: 250_000,
      status: "considering",
    }),
    makeCase({
      caseId: "c2",
      patientName: "Bob Nguyen",
      caseType: "",
      doctorName: "Dr. Alvarez",
      caseValueCents: 900_000,
    }),
    makeCase({
      caseId: "c3",
      patientName: "Cara Alvarez",
      caseType: "Bridge",
      caseValueCents: 50_000,
    }),
    makeCase({ caseId: "c4", patientName: "Dan Smith", phone: "(479) 555-0100" }),
  ];

  it("maps matches to palette rows with status and integer cents", () => {
    const results = matchCases(cases, "alice");
    expect(results).toEqual([
      {
        caseId: "c1",
        patientName: "Alice Alvarez",
        status: "considering",
        caseValueCents: 250_000,
        subtitle: "Implant",
        officeId: "roland",
      },
    ]);
  });

  it("ranks patient-name matches above doctor matches, then by value", () => {
    const results = matchCases(cases, "alvarez");
    expect(results.map((r) => r.caseId)).toEqual(["c1", "c3", "c2"]);
  });

  it("falls back to doctor then category for the subtitle", () => {
    const [row] = matchCases(cases, "nguyen");
    expect(row?.subtitle).toBe("Dr. Alvarez");
  });

  it("matches phone digits regardless of formatting", () => {
    expect(matchCases(cases, "5550100").map((r) => r.caseId)).toEqual(["c4"]);
  });

  it("returns nothing below the minimum query length", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(matchCases(cases, "a")).toEqual([]);
    expect(matchCases(cases, "  ")).toEqual([]);
  });
});

// ── Debounce + stale-response handling ─────────────────────────────────────

const ROLAND: OfficeId[] = ["roland"];

describe("useTcCaseSearch", () => {
  it("issues one request per settled query, not one per keystroke", async () => {
    vi.useFakeTimers();
    apiMock.listCases.mockResolvedValue([makeCase({ caseId: "c1", patientName: "Alice" })]);

    const { rerender } = renderHook(({ q }: { q: string }) => useTcCaseSearch(ROLAND, q, true), {
      initialProps: { q: "al" },
    });

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
    });
    expect(apiMock.listCases).not.toHaveBeenCalled();

    rerender({ q: "ali" });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
    });
    expect(apiMock.listCases).not.toHaveBeenCalled();

    rerender({ q: "alic" });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(apiMock.listCases).toHaveBeenCalledTimes(1);
    expect(apiMock.listCases).toHaveBeenCalledWith("roland");
  });

  it("never fetches below the minimum query length or with an empty office scope", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ offices, q }: { offices: OfficeId[]; q: string }) => useTcCaseSearch(offices, q, true),
      { initialProps: { offices: ROLAND, q: "a" } },
    );

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 4);
    });
    expect(apiMock.listCases).not.toHaveBeenCalled();

    rerender({ offices: [], q: "alice" });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 4);
    });
    expect(apiMock.listCases).not.toHaveBeenCalled();
  });

  it("fans out over every office in scope and labels rows with their office", async () => {
    vi.useFakeTimers();
    apiMock.listCases.mockImplementation((office: OfficeId) =>
      Promise.resolve([
        makeCase({
          caseId: `c-${office}`,
          officeId: office,
          patientName: `Alice ${office}`,
          caseValueCents: office === "valley" ? 200_000 : 100_000,
        }),
      ]),
    );

    const { result } = renderHook(() =>
      useTcCaseSearch(["roland", "valley"] as OfficeId[], "alice", true),
    );

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(apiMock.listCases).toHaveBeenCalledTimes(2);
    expect(result.current.results.map((r) => r.officeId)).toEqual(["valley", "roland"]);
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeNull();
  });

  it("shows a partial notice when one office fails but keeps the rows that loaded", async () => {
    vi.useFakeTimers();
    apiMock.listCases.mockImplementation((office: OfficeId) =>
      office === "valley"
        ? Promise.reject(new Error("Valley is offline"))
        : Promise.resolve([makeCase({ caseId: "c1", patientName: "Alice Alvarez" })]),
    );

    const { result } = renderHook(() =>
      useTcCaseSearch(["roland", "valley"] as OfficeId[], "alice", true),
    );

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.results.map((r) => r.patientName)).toEqual(["Alice Alvarez"]);
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toContain("Valley");
  });

  it("drops a stale response that lands after a newer query resolved", async () => {
    vi.useFakeTimers();
    const first = deferred<TcCaseSummary[]>();
    const second = deferred<TcCaseSummary[]>();
    apiMock.listCases
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useTcCaseSearch(ROLAND, q, true),
      { initialProps: { q: "alice" } },
    );

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    rerender({ q: "bob" });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(apiMock.listCases).toHaveBeenCalledTimes(2);

    // Newer query resolves first.
    await act(async () => {
      second.resolve([makeCase({ caseId: "c2", patientName: "Bob Nguyen" })]);
      await second.promise;
    });
    expect(result.current.results.map((r) => r.patientName)).toEqual(["Bob Nguyen"]);

    // The stale "alice" request lands afterwards and must be ignored.
    await act(async () => {
      first.resolve([makeCase({ caseId: "c1", patientName: "Alice Alvarez" })]);
      await first.promise;
    });
    expect(result.current.results.map((r) => r.patientName)).toEqual(["Bob Nguyen"]);
    expect(result.current.loading).toBe(false);
  });

  it("surfaces a real error message instead of an empty result list", async () => {
    vi.useFakeTimers();
    apiMock.listCases.mockRejectedValue(new Error("Treatment Coordinator is offline"));

    const { result } = renderHook(() => useTcCaseSearch(ROLAND, "alice", true));

    // waitFor would deadlock against fake timers — flush microtasks instead.
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBe("Treatment Coordinator is offline");
    expect(result.current.results).toEqual([]);
    expect(result.current.searched).toBe(true);
  });
});

// ── Keyboard contract ──────────────────────────────────────────────────────

describe("TcGlobalSearch", () => {
  it("opens on Cmd/Ctrl-K and closes on Escape", async () => {
    apiMock.listCases.mockResolvedValue([]);
    render(<TcGlobalSearch />);

    expect(screen.queryByPlaceholderText(/Search cases by patient/)).toBeNull();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Search cases by patient/);
    expect(input).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Search cases by patient/)).toBeNull(),
    );

    // Ctrl-K works too.
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(await screen.findByPlaceholderText(/Search cases by patient/)).toBeTruthy();
  });

  it("ignores the shortcut while the user is typing in a field", () => {
    render(<TcGlobalSearch />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();

    fireEvent.keyDown(field, { key: "k", metaKey: true });

    expect(screen.queryByPlaceholderText(/Search cases by patient/)).toBeNull();
    field.remove();
  });

  it("tells the user to pick an office when the selection has no TC office", async () => {
    officeMock.office = "voice-only-location";
    render(<TcGlobalSearch />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    expect(await screen.findByText("Pick an office to search its cases.")).toBeTruthy();
    expect(apiMock.listCases).not.toHaveBeenCalled();
  });
});
