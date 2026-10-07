/**
 * PERIO VOICE HUD ON THE SHEET (item 36).
 *
 *   closes   the HUD is up exactly while voice is ARMED: every disarm path --
 *            the HUD's Disarm, the banner's, navigation, a hidden tab, 9.5
 *            minutes, a recognition error, the chart locking for a send --
 *            takes it down, and the sheet keeps everything charted
 *   strip    undo / skip / jump move the strip, through the sheet's reducer
 *   flow     the HUD adds no request; the chart's own save is still the only
 *            way a reading leaves, and no stage or send is ever started
 *
 * The mock harness is item 35's (hyg-perio-voice-page.test.tsx), copied rather
 * than shared so that file stays untouched. Its original header follows.
 *
 * -- item 35 --
 * PERIO VOICE ENTRY ON THE SHEET (item 35).
 *
 *   row 1  flag off ⇒ no voice UI at all, and no token is ever asked for. The
 *          server computes the flag (routes/auth.test.js); the 404 is pinned in
 *          backend/routes/hyg/hygVoice.test.js.
 *   row 2  the client takes ONLY { success, token, region } — anything more is
 *          refused before the page sees it.
 *   row 6  ARMED is per visit: every visit starts disarmed, nothing remembers
 *          it, and it disarms on navigation, a hidden tab, and 9.5 minutes
 *          after the mint.
 *   data   what is said lands ONLY in the sheet's own chart, through the chart's
 *          existing save (and from there the existing stage → confirm → send);
 *          the words themselves reach no request and no storage.
 *
 * The speech session is mocked: these tests "speak" by calling its handlers.
 * NO NETWORK, NO BACKEND, NO PHI — the one name below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { type HygAppointment, type StagedWrite } from "@shared/hyg/contract";
import { chartingOrder, emptyPerioChart, perioSite, type PerioChart } from "@shared/hyg/perio";

(globalThis as Record<string, unknown>).React = React;

const state = vi.hoisted(() => ({ hygVoice: false }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Hyg User",
      email: "hygienist@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: ["hyg"] },
      role: "hygiene" as const,
      isSuperAdmin: false,
      permissions: ["hyg.read", "hyg.write"],
      homeOffice: null,
      voiceLab: false,
      hygVoice: state.hygVoice,
    })),
  };
});

const server = vi.hoisted(() => ({
  chart: null as unknown,
  stagedWrite: null as unknown,
  saves: [] as unknown[],
  /** Every argument list any hyg API function was called with, by name. */
  calls: [] as Array<{ name: string; args: unknown[] }>,
  mint: null as null | (() => Promise<unknown>),
}));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12827,
  identity: "resolved",
  patientName: "Test, Voice",
  start: "2026-10-07 08:00:00",
  lengthMin: 60,
  opNum: 2,
  opName: "Hygiene 1",
  isHygiene: true,
  opIsHygiene: true,
  provNum: 1,
  provHyg: 7,
  providerName: "HYG1",
  apptTypeLabel: "Perio Maint",
  confirmedStatus: "Confirmed",
  aptStatus: "Scheduled",
  isNewPatient: false,
  flags: {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

function staged(state: StagedWrite["state"]): StagedWrite {
  return {
    id: "staged-perio",
    kind: "perio",
    state,
    title: "Perio chart",
    summary: state,
    preview: [],
    previewFingerprint: "fp",
    errorMessage: null,
    writtenRef: null,
    stagedBy: null,
    stagedAt: null,
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-10-07T13:10:00.000Z",
  };
}

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const perio = await import("@shared/hyg/perio");
  const record = (name: string, args: unknown[]) => server.calls.push({ name, args });

  const response = (aptNum: number) => {
    const chart = (server.chart ?? perio.emptyPerioChart()) as PerioChart;
    return {
      success: true as const,
      office: "roland" as const,
      aptNum,
      visitStarted: true,
      chart,
      stagedWrite: server.stagedWrite as StagedWrite | null,
      counts: perio.countPerioChart(chart),
      chartStored: server.chart !== null,
    };
  };

  return {
    ...real,
    fetchPerio: vi.fn(async (...args: unknown[]) => {
      record("fetchPerio", args);
      return response(Number(args[1]));
    }),
    fetchPerioPrior: vi.fn(async (...args: unknown[]) => {
      record("fetchPerioPrior", args);
      return {
        success: true,
        office: "roland",
        aptNum: Number(args[1]),
        date: "2026-10-07",
        appointment: APPOINTMENT,
        prior: { status: "none" },
        drift: { status: "not_applicable" },
        preSkip: { status: "unavailable" },
      };
    }),
    fetchPerioSend: vi.fn(async (...args: unknown[]) => {
      record("fetchPerioSend", args);
      return {
        success: true,
        office: "roland",
        aptNum: Number(args[1]),
        stagedWrite: server.stagedWrite,
        send: null,
        live: null,
        paused: null,
      };
    }),
    openVisit: vi.fn(async (...args: unknown[]) => {
      record("openVisit", args);
      return {} as never;
    }),
    savePerio: vi.fn(async (...args: unknown[]) => {
      record("savePerio", args);
      const chart = args[2] as PerioChart;
      server.saves.push(chart);
      server.chart = perio.normalizePerioChart(chart);
      return response(Number(args[1]));
    }),
    mintHygVoiceToken: vi.fn(async (...args: unknown[]) => {
      record("mintHygVoiceToken", args);
      if (server.mint) return server.mint();
      return { success: true, token: "tok-hyg-1", region: "southcentralus" };
    }),
  };
});

/** The fake speech session: records its handlers so a test can speak. */
interface Recognized {
  text: string;
  atMs: number;
  offsetTicks: number;
  durationTicks: number;
  sdkLatencyMs: number | null;
}
const speech = vi.hoisted(() => ({
  starts: [] as Array<{ token: string; region: string; phrases: readonly string[] }>,
  handlers: null as null | {
    onPartial: (r: Recognized) => void;
    onFinal: (r: Recognized) => void;
    onError: (message: string) => void;
  },
  stop: vi.fn(async () => {}),
}));

vi.mock("@/lib/speech/speechSession", () => ({
  startSpeechSession: vi.fn(
    async (token: string, region: string, phrases: readonly string[], handlers: typeof speech.handlers) => {
      speech.starts.push({ token, region, phrases });
      speech.handlers = handlers;
      return { streamStartMs: 0, stop: speech.stop };
    },
  ),
}));

import HygPerio from "@/pages/hyg/HygPerio";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { mintHygVoiceToken } from "@/features/hyg/api";
import { PERIO_VOICE_PHRASES } from "@/features/hyg/perio/voiceGrammar";
import { PerioVoiceEntry, VOICE_AUTO_DISARM_MS } from "@/features/hyg/perio/PerioVoiceEntry";
import { initialPerioEntry } from "@/features/hyg/perio/entry";

function renderPerio(path = "/hyg/visit/900001/perio?office=roland&date=2026-10-07") {
  const memory = memoryLocation({ path, record: true });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <AuthProvider>
          <Route path="/hyg/visit/:aptNum/perio" component={HygPerio} />
          <Route path="/hyg">
            <p data-testid="hyg-day-stub">day</p>
          </Route>
        </AuthProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return memory;
}

function speak(text: string) {
  act(() => {
    speech.handlers?.onPartial({ text, atMs: 900, offsetTicks: 0, durationTicks: 0, sdkLatencyMs: null });
    speech.handlers?.onFinal({ text, atMs: 1000, offsetTicks: 5_000_000, durationTicks: 3_000_000, sdkLatencyMs: 300 });
  });
}

async function armVoice() {
  const toggle = await screen.findByTestId("hyg-perio-voice-toggle");
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByTestId("hyg-perio-voice-state").dataset.armed).toBe("true"));
}

function armedState(): string | undefined {
  return screen.queryByTestId("hyg-perio-voice-state")?.dataset.armed;
}

/** The words said must reach no request, no stored value. Numbers in a chart are not words. */
function assertWordsStayedInTheBrowser(phrases: string[]) {
  const sent = JSON.stringify(server.calls);
  for (const p of phrases) expect(sent).not.toContain(p);
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const value = store.getItem(store.key(i) ?? "") ?? "";
      for (const p of phrases) expect(value).not.toContain(p);
    }
  }
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  state.hygVoice = false;
  server.chart = null;
  server.stagedWrite = null;
  server.saves = [];
  server.calls = [];
  server.mint = null;
  speech.starts = [];
  speech.handlers = null;
  speech.stop.mockClear();
  vi.mocked(mintHygVoiceToken).mockClear();
  // Nothing on this page may reach the real network; the hyg API is mocked above.
  fetchSpy = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});


function hud(): HTMLElement | null {
  return screen.queryByTestId("hyg-perio-hud");
}

function nowTooth(): number {
  const now = screen.getByTestId("hyg-perio-hud-strip").querySelector('[data-tag="NOW"]');
  return Number(now?.getAttribute("data-testid")?.replace("hyg-perio-hud-tooth-", ""));
}

function stripTeeth(): number[] {
  return [...screen.getByTestId("hyg-perio-hud-strip").querySelectorAll("li")].map((li) =>
    Number(li.getAttribute("data-testid")?.replace("hyg-perio-hud-tooth-", "")),
  );
}

describe("item 36: the HUD", () => {
  beforeEach(() => {
    state.hygVoice = true;
  });

  it("is not there while DISARMED, and opens the moment voice ARMS", async () => {
    renderPerio();
    await screen.findByTestId("hyg-perio-voice-toggle");
    expect(hud()).toBeNull();
    await armVoice();
    expect(hud()).not.toBeNull();
    expect(screen.getByTestId("hyg-perio-hud-ribbon").dataset.kind).toBe("listening");
    expect(screen.getByTestId("hyg-perio-hud-remaining").textContent).toMatch(/^9:(29|30)$/);
    expect(stripTeeth()).toEqual([1, 2, 3, 4, 5]);
    expect(nowTooth()).toBe(1);
  });

  it("does not take the keyboard: the grid keeps focus, and a key still charts", async () => {
    renderPerio();
    const grid = await screen.findByTestId("hyg-perio-grid");
    await armVoice();
    fireEvent.keyDown(grid, { key: "5", code: "Digit5" });
    await waitFor(() => expect(screen.getByTestId("hyg-perio-hud-active-1").textContent).toContain("5"));
  });

  describe("every disarm path closes it, and the sheet keeps what was charted", () => {
    async function armAndChart() {
      const memory = renderPerio();
      await armVoice();
      speak("three two three");
      expect(screen.getByTestId("hyg-perio-hud-ribbon").dataset.kind).toBe("accepted");
      return memory;
    }

    async function expectClosedWithReadingsKept() {
      await waitFor(() => expect(hud()).toBeNull());
      expect(speech.stop).toHaveBeenCalled();
      const order = chartingOrder(emptyPerioChart().sweep);
      await waitFor(
        () => {
          const last = server.saves[server.saves.length - 1] as PerioChart | undefined;
          expect(last && [0, 1, 2].map((i) => perioSite(last, order[i].tooth, order[i].surface).depth)).toEqual([3, 2, 3]);
        },
        { timeout: 4000 },
      );
    }

    it("the HUD's own Disarm", async () => {
      await armAndChart();
      fireEvent.click(screen.getByTestId("hyg-perio-hud-disarm"));
      await waitFor(() => expect(armedState()).toBe("false"));
      await expectClosedWithReadingsKept();
      expect(screen.getByTestId("hyg-perio-grid")).toBeTruthy();
    });

    it("the banner's Disarm", async () => {
      await armAndChart();
      fireEvent.click(screen.getByTestId("hyg-perio-voice-toggle"));
      await expectClosedWithReadingsKept();
    });

    it("a hidden tab", async () => {
      await armAndChart();
      act(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expectClosedWithReadingsKept();
    });

    it("a recognition error", async () => {
      await armAndChart();
      act(() => speech.handlers?.onError("network went away"));
      await expectClosedWithReadingsKept();
      expect(screen.getByTestId("hyg-perio-voice-notice").textContent).toMatch(/network went away/);
    });

    it("navigation away", async () => {
      const memory = await armAndChart();
      act(() => memory.navigate("/hyg?office=roland"));
      await screen.findByTestId("hyg-day-stub");
      await waitFor(() => expect(hud()).toBeNull());
      expect(speech.stop).toHaveBeenCalled();
    });

    it("9.5 minutes after the mint", async () => {
      const scheduled: Array<{ fn: () => void; ms: number }> = [];
      const realSetTimeout = window.setTimeout;
      vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (typeof ms === "number" && ms > 60_000) {
          scheduled.push({ fn, ms });
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return realSetTimeout(fn, ms, ...rest);
      }) as typeof setTimeout);
      await armAndChart();
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].ms).toBeLessThanOrEqual(VOICE_AUTO_DISARM_MS);
      act(() => scheduled[0].fn());
      await expectClosedWithReadingsKept();
    });
  });

  it("the chart locking for a send closes it (the entry, driven directly)", async () => {
    const entry = initialPerioEntry(emptyPerioChart());
    const props = { office: "roland" as const, entry, onCommands: () => {} };
    const { rerender } = render(<PerioVoiceEntry {...props} locked={false} />);
    fireEvent.click(screen.getByTestId("hyg-perio-voice-toggle"));
    await waitFor(() => expect(hud()).not.toBeNull());
    rerender(<PerioVoiceEntry {...props} locked />);
    await waitFor(() => expect(hud()).toBeNull());
    expect(speech.stop).toHaveBeenCalled();
    expect(screen.getByTestId("hyg-perio-voice-notice").textContent).toMatch(/locked while it is sent/);
  });

  it("undo, skip and jump move the strip", async () => {
    renderPerio();
    await armVoice();

    speak("three two three");
    expect(nowTooth()).toBe(2);
    expect(screen.getByTestId("hyg-perio-hud-tooth-1").dataset.tag).toBe("DONE");
    expect(screen.getByTestId("hyg-perio-hud-ribbon").textContent).toContain("charted to tooth 1 · moved to tooth 2");

    speak("four");
    expect(screen.getByTestId("hyg-perio-hud-active-2").textContent).toContain("4");
    speak("undo");
    expect(screen.getByTestId("hyg-perio-hud-active-2").textContent).not.toContain("4");
    expect(screen.getByTestId("hyg-perio-hud-ribbon").textContent).toContain("took back 2 DB");

    speak("skip this tooth");
    expect(screen.getByTestId("hyg-perio-hud-tooth-2").dataset.tag).toBe("SKIPPED");
    expect(nowTooth()).toBe(3);
    expect(screen.getByTestId("hyg-perio-hud-pass").textContent).toContain("1 of 16 charted · 1 skipped");

    speak("jump to tooth fourteen");
    expect(nowTooth()).toBe(14);
    expect(stripTeeth()).toEqual([12, 13, 14, 15, 16]);

    speak("go back to tooth three MB");
    expect(nowTooth()).toBe(3);
    expect(stripTeeth()).toEqual([1, 2, 3, 4, 5]);
    expect(
      screen.getByTestId("hyg-perio-hud-active-3").querySelector('[data-ringed="true"]')?.getAttribute("data-site"),
    ).toBe("MB");
  });

  it("a rejected final shows amber in the HUD, item 35's own line still says it, and nothing is charted", async () => {
    renderPerio();
    await armVoice();
    speak("1010");
    const ribbon = screen.getByTestId("hyg-perio-hud-ribbon");
    expect(ribbon.dataset.kind).toBe("rejected");
    expect(ribbon.textContent).toContain("Heard “1010” — nothing charted");
    expect(screen.getByTestId("hyg-perio-voice-rejected").textContent).toMatch(/nothing was charted/i);
    speak("jump to tooth two");
    speak("skip this tooth");
    speak("jump to tooth two");
    expect(screen.getByTestId("hyg-perio-hud-ribbon").dataset.kind).toBe("refused");
    expect(screen.getByTestId("hyg-perio-hud-ribbon").textContent).toMatch(/#2 is skipped/);
    await new Promise((r) => setTimeout(r, 900));
    const saved = server.saves as PerioChart[];
    expect(saved.every((c) => chartingOrder(c.sweep).every((o) => perioSite(c, o.tooth, o.surface).depth === null))).toBe(true);
  });

  it("the HUD adds no request: the chart's own save is still the only way out, and no stage or send starts", async () => {
    renderPerio();
    await armVoice();
    speak("three two three bleeding");
    speak("jump to tooth fourteen");
    await waitFor(() => expect(server.saves.length).toBeGreaterThan(0), { timeout: 4000 });
    const names = new Set(server.calls.map((c) => c.name));
    expect(
      [...names].every((n) =>
        ["fetchPerio", "fetchPerioPrior", "fetchPerioSend", "mintHygVoiceToken", "openVisit", "savePerio"].includes(n),
      ),
    ).toBe(true);
    expect(vi.mocked(mintHygVoiceToken)).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    assertWordsStayedInTheBrowser(["three two three", "jump to tooth"]);
  });
});
