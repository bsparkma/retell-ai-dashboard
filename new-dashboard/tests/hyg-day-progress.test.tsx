/**
 * THE DAY-CARD PROGRESS PILL — every overall state, and the one that is not a
 * state at all.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE TEST TO READ HARDEST: "PROGRESS UNAVAILABLE" IS NEVER "NOT STARTED"
 * ═════════════════════════════════════════════════════════════════════════════
 * `not_started` is the server saying no visit exists. A card whose progress did
 * not load has no claim at all, and reading it as "nobody has started" could
 * send a second hygienist into a visit that is half done. So a failed read, and
 * an AptNum the answer left out, are both asserted to draw the dashed
 * "Progress unavailable" chip — and asserted NOT to draw "Not started".
 *
 * NO NETWORK, NO BACKEND, NO PHI. Names are synthetic; PatNums are the staging
 * fixtures.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type {
  HygAppointment,
  HygDayProgressResponse,
  HygDayResponse,
  HygVisitProgress,
} from "@shared/hyg/contract";
import { cardProgressFor, progressAptNums, stepMarks, summaryPill } from "@/features/hyg/progress";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

function appt(aptNum: number, hour: number, name: string): HygAppointment {
  return {
    aptNum,
    patNum: 12827,
    identity: "resolved",
    patientName: name,
    start: `2026-09-08 ${String(hour).padStart(2, "0")}:00:00`,
    lengthMin: 60,
    opNum: 2,
    opName: "Hygiene 1",
    isHygiene: true,
    opIsHygiene: true,
    provNum: 1,
    provHyg: 7,
    providerName: "HYG1",
    apptTypeLabel: "Prophy Adult",
    confirmedStatus: "Confirmed",
    aptStatus: "Scheduled",
    isNewPatient: false,
    flags: {
      premed: false,
      medicalAlerts: false,
      allergies: null,
      lastPerioDate: null,
      xraysDue: null,
      examNeeded: null,
      openTcCase: null,
    },
  };
}

const DAY: HygDayResponse = {
  success: true,
  office: "roland",
  officeName: "Roland Family Dental",
  date: "2026-09-08",
  operatories: [{ opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 }],
  appointments: [
    appt(900001, 7, "Kiwi S."),
    appt(900002, 8, "Papaya P."),
    appt(900003, 9, "Mango M."),
    appt(900004, 10, "Guava G."),
    appt(900005, 11, "Lychee L."),
    appt(900006, 13, "Quince Q."),
  ],
  warnings: [],
  flagSources: { premed: "od", medicalAlerts: "od" },
  excludedByStatus: 0,
  scope: "hygiene",
  excludedByScope: 0,
  truncated: false,
  patientNamesTruncated: false,
  identitiesPending: 0,
  stats: {
    odListReads: 4,
    odPatientReads: 0,
    patientsRequested: 0,
    patientCacheHits: 0,
    patientCacheDeduped: 0,
    durationMs: 100,
    phaseMs: {},
  },
};

type Step = HygVisitProgress["steps"];
function steps(
  note: string,
  slip: string,
  perio: string,
  tc: string,
  checkoutAlerted = false,
): NonNullable<Step> {
  return {
    note: { state: note },
    slip: { state: slip },
    perio: { state: perio },
    tc: { state: tc, checkoutAlerted, checkoutFinal: false },
  } as NonNullable<Step>;
}

const PROGRESS: HygDayProgressResponse = {
  success: true,
  office: "roland",
  progress: [
    { aptNum: 900001, overall: "sent", steps: steps("written", "written", "not_applicable", "written") },
    { aptNum: 900002, overall: "ready_to_send", steps: steps("ready", "ready", "not_applicable", "not_applicable") },
    { aptNum: 900003, overall: "in_progress", steps: steps("written", "drafting", "sending", "ready", true) },
    { aptNum: 900004, overall: "needs_attention", steps: steps("written", "failed", "not_applicable", "none") },
    { aptNum: 900005, overall: "not_started", steps: null },
    // 900006 deliberately ABSENT from the answer.
  ],
};

// ─── Mocks ───────────────────────────────────────────────────────────────────

const fixtures = vi.hoisted(() => ({
  progress: null as unknown,
  progressFail: null as unknown,
  calls: [] as Array<{ office: string; aptNums: number[] }>,
  /** When set, the NEXT progress call waits on this instead of answering. */
  hold: null as null | Promise<unknown>,
  /** The day as served; `date` is echoed from the request. */
  day: null as unknown,
  /** One name batch, then the fill hangs. Null = the fill hangs from the start. */
  fill: null as unknown,
  fillCalls: 0,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const target = {
    getOffices: async () => [{ officeId: "roland", officeName: "Roland Family Dental" }],
  };
  return {
    ...real,
    api: new Proxy(target, {
      get: (t, prop) => (prop in t ? Reflect.get(t, prop) : () => new Promise(() => {})),
    }),
  };
});

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchDay: vi.fn(async (_office: string, date: string) => ({
      ...(fixtures.day as HygDayResponse),
      date,
    })),
    fetchDayIdentities: vi.fn(async () => {
      fixtures.fillCalls += 1;
      if (fixtures.fill && fixtures.fillCalls === 1) return fixtures.fill as never;
      return new Promise(() => {}) as never;
    }),
    fetchDayProgress: vi.fn(async (office: string, aptNums: readonly number[]) => {
      fixtures.calls.push({ office, aptNums: [...aptNums] });
      if (fixtures.hold) {
        const held = fixtures.hold;
        fixtures.hold = null;
        await held;
      }
      if (fixtures.progressFail) throw fixtures.progressFail;
      return fixtures.progress as HygDayProgressResponse;
    }),
  };
});

import HygDay from "@/pages/hyg/HygDay";
import { HygApiError } from "@/features/hyg/api";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderDay() {
  const memory = memoryLocation({ path: "/hyg/day", record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <OfficeProvider>
            <HygDay />
          </OfficeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

/** The card for one synthetic patient. */
function card(name: string): HTMLElement {
  const el = screen.getByText(name).closest('[data-testid="hyg-appointment-card"]');
  if (!(el instanceof HTMLElement)) throw new Error("no card for " + name);
  return el;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carein.office", "roland");
  fixtures.progress = PROGRESS;
  fixtures.progressFail = null;
  fixtures.calls = [];
  fixtures.hold = null;
  fixtures.day = DAY;
  fixtures.fill = null;
  fixtures.fillCalls = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── The page ────────────────────────────────────────────────────────────────

describe("day cards: the progress pill", () => {
  it("asks once, after the day, with that day's own office and AptNums", async () => {
    renderDay();
    await screen.findByTestId("hyg-progress-sent");
    expect(fixtures.calls).toEqual([
      { office: "roland", aptNums: [900001, 900002, 900003, 900004, 900005, 900006] },
    ]);
  });

  it("draws every overall state in its own words", async () => {
    renderDay();
    await screen.findByTestId("hyg-progress-sent");

    expect(within(card("Kiwi S.")).getByTestId("hyg-progress-sent").textContent).toBe("Sent");
    expect(within(card("Papaya P.")).getByTestId("hyg-progress-ready_to_send").textContent).toBe(
      "Ready to send",
    );
    expect(within(card("Mango M.")).getByTestId("hyg-progress-in_progress").textContent).toBe(
      "In progress",
    );
    expect(within(card("Guava G.")).getByTestId("hyg-progress-needs_attention").textContent).toBe(
      "Needs attention",
    );
    expect(within(card("Lychee L.")).getByTestId("hyg-progress-not_started").textContent).toBe(
      "Not started",
    );
  });

  it("marks steps with words: In chart, —, Failed, Checkout alerted; n/a hidden", async () => {
    renderDay();
    await screen.findByTestId("hyg-progress-sent");

    const sent = card("Kiwi S.");
    expect(within(sent).getByTestId("hyg-step-note").textContent).toBe("Note ✓ In chart");
    expect(within(sent).getByTestId("hyg-step-tc").textContent).toBe("TC ✓ Handed off");
    expect(within(sent).queryByTestId("hyg-step-perio")).toBeNull();

    const ready = card("Papaya P.");
    expect(within(ready).getByTestId("hyg-step-note").textContent).toBe("Note: Ready");
    expect(within(ready).getByTestId("hyg-step-slip").textContent).toBe("Router: Ready");
    expect(within(ready).queryByTestId("hyg-step-tc")).toBeNull();

    const busy = card("Mango M.");
    expect(within(busy).getByTestId("hyg-step-slip").textContent).toBe("Router: Drafting");
    expect(within(busy).getByTestId("hyg-step-perio").textContent).toBe("Perio: Sending…");
    expect(within(busy).getByTestId("hyg-step-tc").textContent).toBe("TC: Checkout alerted");

    const failed = card("Guava G.");
    expect(within(failed).getByTestId("hyg-step-slip").textContent).toBe("Router: Failed");
    // The dash carries a spoken word for anyone not reading the glyph.
    expect(within(failed).getByTestId("hyg-step-tc").textContent).toBe("TC — not started");

    // A visit that does not exist has no steps to mark.
    expect(within(card("Lychee L.")).queryByTestId("hyg-progress-steps")).toBeNull();
  });

  it("an AptNum missing from the answer is UNAVAILABLE, never Not started", async () => {
    renderDay();
    await screen.findByTestId("hyg-progress-sent");
    const missing = card("Quince Q.");
    expect(within(missing).getByTestId("hyg-progress-unavailable").textContent).toBe(
      "Progress unavailable",
    );
    expect(within(missing).queryByText("Not started")).toBeNull();
    expect(within(missing).queryByTestId("hyg-progress-steps")).toBeNull();
  });

  it("a failed progress read makes EVERY card unavailable — and keeps the schedule", async () => {
    fixtures.progressFail = new HygApiError("Internal error", 500, "INTERNAL_ERROR");
    renderDay();
    await waitFor(() => expect(screen.getAllByTestId("hyg-progress-unavailable")).toHaveLength(6));
    expect(screen.queryByText("Not started")).toBeNull();
    expect(screen.queryByTestId("hyg-progress-steps")).toBeNull();
    // The day itself is untouched: every patient still in their slot.
    expect(screen.getByText("Kiwi S.")).toBeTruthy();
    expect(screen.queryByTestId("hyg-day-error")).toBeNull();
    expect(screen.getByTestId("hyg-day-list")).toBeTruthy();
  });

  it("the card stays ONE link: no nested interactive element", async () => {
    renderDay();
    await screen.findByTestId("hyg-progress-sent");
    const cards = screen.getAllByTestId("hyg-appointment-card");
    expect(cards).toHaveLength(6);
    for (const c of cards) {
      expect(c.tagName).toBe("A");
      expect(c.querySelectorAll("a, button, input, select, textarea, [role=button], [tabindex]")).toHaveLength(0);
      expect(c.className).toContain("min-h-[88px]");
    }
  });

  it("the pill never truncates: it is nowrap and does not shrink", async () => {
    fixtures.progressFail = new HygApiError("x", 500, "INTERNAL_ERROR");
    renderDay();
    const pills = await screen.findAllByTestId("hyg-progress-unavailable");
    for (const p of pills) {
      expect(p.className).toContain("whitespace-nowrap");
      expect(p.className).toContain("shrink-0");
      expect(p.className).not.toContain("truncate");
    }
  });

  it("Refresh re-asks for progress along with the day", async () => {
    renderDay();
    await screen.findByTestId("hyg-progress-sent");
    expect(fixtures.calls).toHaveLength(1);
    act(() => {
      screen.getByTestId("hyg-day-refresh").click();
    });
    await waitFor(() => expect(fixtures.calls).toHaveLength(2));
    await screen.findByTestId("hyg-progress-sent");
  });

  it("names filling in do NOT re-ask: a merge is not a new day", async () => {
    // Two cards waiting on a name; the fill answers once with both.
    fixtures.day = {
      ...DAY,
      appointments: DAY.appointments.map((a, i) =>
        i < 2 ? { ...a, identity: "pending" as const, patientName: null } : a,
      ),
      identitiesPending: 2,
    };
    fixtures.fill = {
      success: true,
      office: "roland",
      date: "2026-09-08",
      scope: "hygiene",
      patients: [
        { patNum: 12827, patientName: "Kiwi S.", premed: false, medicalAlerts: false },
      ],
      unavailable: [],
      pending: 1,
      stats: DAY.stats,
    };
    renderDay();
    // Both pending cards share the fixture PatNum, so both fill in.
    await screen.findAllByText("Kiwi S.");
    await screen.findAllByTestId("hyg-progress-sent");
    expect(fixtures.fillCalls).toBeGreaterThanOrEqual(1);
    expect(fixtures.calls).toHaveLength(1);
  });

  it("an answer for the PREVIOUS day is never drawn on the next one", async () => {
    let release: () => void = () => {};
    fixtures.hold = new Promise<void>((r) => {
      release = r;
    });
    renderDay();
    await waitFor(() => expect(fixtures.calls).toHaveLength(1));

    // Step to the next day while the first answer is still in flight. The next
    // day's progress read then fails, so the only way a "Sent" appears is if
    // the first day's late answer was drawn.
    fixtures.progressFail = new HygApiError("x", 500, "INTERNAL_ERROR");
    act(() => {
      screen.getByLabelText("Next day").click();
    });
    await waitFor(() => expect(fixtures.calls).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("hyg-progress-unavailable")).toHaveLength(6));

    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("hyg-progress-sent")).toBeNull();
    expect(screen.getAllByTestId("hyg-progress-unavailable")).toHaveLength(6);
  });

  it("re-asks on focus and on becoming visible, and not while hidden", async () => {
    renderDay();
    await screen.findByTestId("hyg-progress-sent");
    expect(fixtures.calls).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(fixtures.calls).toHaveLength(2));

    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(fixtures.calls).toHaveLength(2);

    hidden.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(fixtures.calls).toHaveLength(3));
    hidden.mockRestore();
  });

  it("re-asks every 60s while visible — and recovers from a failure when it does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fixtures.progressFail = new HygApiError("x", 500, "INTERNAL_ERROR");
    renderDay();
    await waitFor(() => expect(screen.getAllByTestId("hyg-progress-unavailable")).toHaveLength(6));
    expect(fixtures.calls).toHaveLength(1);

    fixtures.progressFail = null;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fixtures.calls).toHaveLength(2));
    await screen.findByTestId("hyg-progress-sent");
    // Only the one missing from the answer is still unavailable.
    expect(screen.getAllByTestId("hyg-progress-unavailable")).toHaveLength(1);
  });
});

// ─── The words, without the page ─────────────────────────────────────────────

describe("progress presentation helpers", () => {
  it("summaryPill: loading draws nothing; unavailable has its own words", () => {
    expect(summaryPill({ kind: "loading" })).toBeNull();
    expect(summaryPill({ kind: "unavailable" })).toEqual({
      label: "Progress unavailable",
      tone: "unavailable",
    });
  });

  it("stepMarks: a failed TC handoff reads Failed even after a checkout alert", () => {
    const marks = stepMarks({
      aptNum: 1,
      overall: "needs_attention",
      steps: steps("written", "written", "not_applicable", "failed", true),
    });
    expect(marks.map((m) => m.text)).toEqual(["Note ✓ In chart", "Router ✓ In chart", "TC: Failed"]);
    expect(marks[2].tone).toBe("attention");
  });

  it("cardProgressFor: null AptNum and a failed read are unavailable, not not_started", () => {
    const byApt = new Map<number, HygVisitProgress>();
    expect(cardProgressFor(null, { status: "ready", byApt })).toEqual({ kind: "unavailable" });
    expect(cardProgressFor(5, { status: "failed", byApt })).toEqual({ kind: "unavailable" });
    expect(cardProgressFor(5, { status: "ready", byApt })).toEqual({ kind: "unavailable" });
    expect(cardProgressFor(5, { status: "loading", byApt })).toEqual({ kind: "loading" });
  });

  it("progressAptNums: dedupes, drops null, caps at 200", () => {
    expect(progressAptNums([{ aptNum: 3 }, { aptNum: null }, { aptNum: 3 }, { aptNum: 9 }])).toEqual([3, 9]);
    const many = Array.from({ length: 250 }, (_, i) => ({ aptNum: i + 1 }));
    expect(progressAptNums(many)).toHaveLength(200);
  });
});
