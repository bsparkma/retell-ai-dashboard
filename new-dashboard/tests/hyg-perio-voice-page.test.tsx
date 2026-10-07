/**
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
import { VOICE_AUTO_DISARM_MS } from "@/features/hyg/perio/PerioVoiceEntry";

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

describe("row 1: flag off ⇒ no UI", () => {
  it("renders no voice entry and never asks for a token", async () => {
    renderPerio();
    await screen.findByTestId("hyg-perio-grid");
    // Give /auth/me its turn: the answer is in, and it says off.
    await waitFor(() => expect(server.calls.some((c) => c.name === "fetchPerio")).toBe(true));
    await act(async () => {});
    expect(screen.queryByTestId("hyg-perio-voice")).toBeNull();
    expect(screen.queryByText(/arm voice/i)).toBeNull();
    expect(mintHygVoiceToken).not.toHaveBeenCalled();
    expect(speech.starts).toEqual([]);
  });
});

describe("with HYG_VOICE on", () => {
  beforeEach(() => {
    state.hygVoice = true;
  });

  it("every visit opens DISARMED, and nothing remembers an arm", async () => {
    renderPerio();
    expect(await screen.findByTestId("hyg-perio-voice-state")).toHaveProperty("dataset.armed", "false");
    expect(screen.getByText("VOICE OFF")).toBeTruthy();
    const keysBefore = Object.keys(localStorage).sort();
    await armVoice();
    expect(Object.keys(localStorage).sort(), "arming stores nothing").toEqual(keysBefore);
    expect(sessionStorage.length).toBe(0);
  });

  it("arming mints a token for THIS office with no body, and opens the session with the full phrase list", async () => {
    renderPerio();
    await armVoice();
    expect(screen.getByText("VOICE ARMED")).toBeTruthy();
    expect(mintHygVoiceToken).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mintHygVoiceToken).mock.calls[0]).toEqual(["roland"]);
    expect(speech.starts).toEqual([{ token: "tok-hyg-1", region: "southcentralus", phrases: PERIO_VOICE_PHRASES }]);
  });

  it("a spoken final lands in the SHEET'S chart, in charting order, and is stored by the chart's own save", async () => {
    renderPerio();
    await armVoice();
    speak("three two three bleeding");
    expect(screen.getByTestId("hyg-perio-voice-applied").textContent).toContain("3, 2, 3, bleeding");

    const order = chartingOrder(emptyPerioChart().sweep);
    await waitFor(
      () => {
        const last = server.saves[server.saves.length - 1] as PerioChart | undefined;
        expect(last && perioSite(last, order[2].tooth, order[2].surface).depth).toBe(3);
      },
      { timeout: 4000 },
    );
    const saved = server.saves[server.saves.length - 1] as PerioChart;
    expect([0, 1, 2].map((i) => perioSite(saved, order[i].tooth, order[i].surface).depth)).toEqual([3, 2, 3]);
    expect(perioSite(saved, order[2].tooth, order[2].surface).bleeding).toBe(true);
    // The ONLY ways it left the page: the chart's own save. No stage, no send.
    const names = new Set(server.calls.map((c) => c.name));
    expect([...names].sort()).toEqual(
      ["fetchPerio", "fetchPerioPrior", "fetchPerioSend", "mintHygVoiceToken", "openVisit", "savePerio"].filter((n) =>
        names.has(n),
      ),
    );
    expect(names.has("stageWrite")).toBe(false);
    expect(names.has("startPerioSend")).toBe(false);
    assertWordsStayedInTheBrowser(["three two three", "bleeding three"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ACCEPTANCE 4 on screen: a rejected final is flagged and charts NOTHING", async () => {
    renderPerio();
    await armVoice();
    for (const [said, why] of [
      ["1010", /one number/],
      ["80", /one number/],
      ["fourteen", /0–12/],
      ["banana", /not a depth/],
    ] as const) {
      speak(said);
      expect(screen.getByTestId("hyg-perio-voice-rejected").textContent).toMatch(why);
      expect(screen.getByTestId("hyg-perio-voice-rejected").textContent).toMatch(/nothing was charted/i);
    }
    // Long enough for a save to have fired had anything changed.
    await new Promise((r) => setTimeout(r, 900));
    expect(server.saves).toEqual([]);
    expect(screen.getByTestId("hyg-perio-progress").textContent).not.toMatch(/[1-9]\d* of/);
  });

  it("disarms on navigation away from the sheet — the microphone is closed", async () => {
    const memory = renderPerio();
    await armVoice();
    act(() => memory.navigate("/hyg?office=roland"));
    await screen.findByTestId("hyg-day-stub");
    await waitFor(() => expect(speech.stop).toHaveBeenCalled());
    expect(screen.queryByTestId("hyg-perio-voice")).toBeNull();
  });

  it("resets per VISIT: moving to another appointment closes the mic and starts it DISARMED", async () => {
    const memory = renderPerio();
    await armVoice();
    act(() => memory.navigate("/hyg/visit/900002/perio?office=roland&date=2026-10-07"));
    await waitFor(() => expect(speech.stop).toHaveBeenCalled());
    await waitFor(() => expect(armedState()).toBe("false"));
    expect(screen.getByText("VOICE OFF")).toBeTruthy();
  });

  it("a final arriving AFTER disarm (mid-stop, or from a stale session) charts nothing", async () => {
    renderPerio();
    await armVoice();
    const handlers = speech.handlers;
    fireEvent.click(screen.getByTestId("hyg-perio-voice-toggle"));
    await waitFor(() => expect(armedState()).toBe("false"));
    act(() => handlers?.onFinal({ text: "four four four", atMs: 1, offsetTicks: 0, durationTicks: 0, sdkLatencyMs: null }));
    expect(screen.queryByTestId("hyg-perio-voice-applied")).toBeNull();
    await new Promise((r) => setTimeout(r, 900));
    expect(server.saves).toEqual([]);
  });

  it("disarms when the tab is hidden", async () => {
    renderPerio();
    await armVoice();
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(armedState()).toBe("false"));
    expect(speech.stop).toHaveBeenCalled();
    expect(screen.getByTestId("hyg-perio-voice-notice").textContent).toMatch(/page was hidden/);
  });

  it("disarms itself 9.5 minutes after the MINT, before the 10-minute token can expire", async () => {
    expect(VOICE_AUTO_DISARM_MS).toBe(9.5 * 60 * 1000);
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const realSetTimeout = window.setTimeout;
    vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number" && ms > 60_000) {
        scheduled.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);

    renderPerio();
    await armVoice();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBeLessThanOrEqual(VOICE_AUTO_DISARM_MS);
    expect(scheduled[0].ms).toBeGreaterThan(VOICE_AUTO_DISARM_MS - 5_000);

    act(() => scheduled[0].fn());
    await waitFor(() => expect(armedState()).toBe("false"));
    expect(speech.stop).toHaveBeenCalled();
    expect(screen.getByTestId("hyg-perio-voice-notice").textContent).toMatch(/token is about to run out/);
  });

  it("a chart locked for a send cannot be armed", async () => {
    server.chart = emptyPerioChart();
    server.stagedWrite = staged("Written");
    renderPerio();
    const toggle = await screen.findByTestId("hyg-perio-voice-toggle");
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(toggle);
    expect(mintHygVoiceToken).not.toHaveBeenCalled();
  });

  it("row 2: a token answer carrying anything beyond { success, token, region } is refused, not used", async () => {
    const real = await vi.importActual<typeof import("@/features/hyg/api")>("@/features/hyg/api");
    const answer = (body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));

    vi.stubGlobal("fetch", answer({ success: true, token: "t", region: "southcentralus", key: "SPEECH-KEY" }));
    await expect(real.mintHygVoiceToken("roland")).rejects.toMatchObject({ code: "CONTRACT_MISMATCH" });

    const ok = answer({ success: true, token: "t", region: "southcentralus" });
    vi.stubGlobal("fetch", ok);
    await expect(real.mintHygVoiceToken("roland")).resolves.toEqual({ success: true, token: "t", region: "southcentralus" });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/hyg\/voice\/token\?office=roland$/);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("a spent budget is said honestly, and nothing is armed", async () => {
    const real = await vi.importActual<typeof import("@/features/hyg/api")>("@/features/hyg/api");
    server.mint = async () => {
      throw new real.HygApiError(
        "Today's perio voice budget is used up (60 of 60 minutes reserved). It resets at midnight Central.",
        429,
        "HYG_VOICE_BUDGET_EXHAUSTED",
      );
    };
    renderPerio();
    fireEvent.click(await screen.findByTestId("hyg-perio-voice-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("hyg-perio-voice-notice").textContent).toMatch(/budget is used up/),
    );
    expect(armedState()).toBe("false");
    expect(speech.starts).toEqual([]);
  });
});
