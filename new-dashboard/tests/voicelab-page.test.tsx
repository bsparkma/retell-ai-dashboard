/**
 * Voice lab page (queue item 34).
 *
 *   row 1  flag off ⇒ no UI renders: no Home link, and /voicelab is the 404
 *          page (which never asks for a token). The server computes the flag,
 *          production always false — see backend/routes/auth.test.js.
 *   row 6  the page's only CareIN request is the bodyless token mint; what
 *          was said stays in page memory.
 *
 * The speech session is mocked: these tests drive recognitions by hand.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const state = vi.hoisted(() => ({ voiceLab: false }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Lab User",
      email: "lab@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: ["voice"] },
      role: "admin" as const,
      isSuperAdmin: false,
      permissions: ["admin.all", "voice.read", "voice.write"],
      homeOffice: null,
      voiceLab: state.voiceLab,
    })),
  };
});

const voiceLabToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: new Proxy(
      {},
      { get: (_t, key) => (key === "voiceLabToken" ? voiceLabToken : () => new Promise(() => {})) },
    ),
  };
});

vi.mock("@/features/tc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/api")>();
  const pending = () => new Promise(() => {});
  return Object.fromEntries(
    Object.entries(real).map(([key, value]) => [key, typeof value === "function" ? pending : value]),
  );
});

/** The fake speech session: records its handlers so a test can speak. */
interface FakeRecognized {
  text: string;
  /** Item 37: the lexical form; null when the result carried none. */
  lexical: string | null;
  atMs: number;
  offsetTicks: number;
  durationTicks: number;
  sdkLatencyMs: number | null;
}
interface FakeHandlers {
  onPartial: (r: FakeRecognized) => void;
  onFinal: (r: FakeRecognized) => void;
  onError: (message: string) => void;
}
const speech = vi.hoisted(() => ({
  starts: [] as Array<{ token: string; region: string; phrases: readonly string[] }>,
  handlers: null as FakeHandlers | null,
  stop: vi.fn(async () => {}),
  /** When set, start waits on this before resolving. */
  gate: null as Promise<void> | null,
}));

vi.mock("@/lib/speech/speechSession", () => ({
  startSpeechSession: vi.fn(async (token: string, region: string, phrases: readonly string[], handlers: FakeHandlers) => {
    speech.starts.push({ token, region, phrases });
    speech.handlers = handlers;
    if (speech.gate) await speech.gate;
    return { streamStartMs: 0, stop: speech.stop };
  }),
}));

import Home from "@/pages/Home";
import { Router as AppRouter } from "@/App";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ModuleProvider } from "@/contexts/ModuleContext";
import { OfficeProvider } from "@/contexts/OfficeContext";
import { SlotMarkersProvider } from "@/features/slotMarkers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PHRASE_LIST } from "@/pages/voicelab/scoring";

function renderAt(ui: React.ReactElement, path: string) {
  const memory = memoryLocation({ path, record: true });
  const view = render(
    <WouterRouter hook={memory.hook}>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <ModuleProvider>
              <OfficeProvider>
                <SlotMarkersProvider>{ui}</SlotMarkersProvider>
              </OfficeProvider>
            </ModuleProvider>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
  return { memory, view };
}

function speak(text: string, at = 1_000, lexical: string | null = null) {
  act(() => {
    speech.handlers?.onPartial({ text, lexical: null, atMs: at - 200, offsetTicks: 0, durationTicks: 0, sdkLatencyMs: null });
    speech.handlers?.onFinal({ text, lexical, atMs: at, offsetTicks: 5_000_000, durationTicks: 3_000_000, sdkLatencyMs: 300 });
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

/**
 * Nothing about what was said may leave the page. The app SHELL around the
 * page makes its own requests (slot markers) and keeps its own preferences in
 * localStorage (theme, module), so the assertion is about CONTENT: no request
 * is a write, none names the lab, and neither a request nor a stored value
 * carries a recognised word.
 */
function assertNothingSaidLeftThePage(words: string[]) {
  for (const call of fetchSpy.mock.calls) {
    const [url, init] = call as [unknown, RequestInit | undefined];
    const method = (init?.method ?? "GET").toUpperCase();
    expect(method, String(url)).toBe("GET");
    expect(init?.body ?? null).toBeNull();
    expect(String(url)).not.toMatch(/voicelab/i);
    for (const w of words) expect(String(url)).not.toContain(w);
  }
  for (let i = 0; i < localStorage.length; i++) {
    const value = localStorage.getItem(localStorage.key(i) ?? "") ?? "";
    for (const w of words) expect(value).not.toContain(w);
  }
  for (let i = 0; i < sessionStorage.length; i++) {
    const value = sessionStorage.getItem(sessionStorage.key(i) ?? "") ?? "";
    for (const w of words) expect(value).not.toContain(w);
  }
}

beforeEach(() => {
  localStorage.clear();
  state.voiceLab = false;
  voiceLabToken.mockReset();
  voiceLabToken.mockResolvedValue({ success: true, token: "tok-123", region: "southcentralus" });
  speech.starts = [];
  speech.handlers = null;
  speech.stop.mockClear();
  speech.gate = null;
  // Anything reaching the real network from the page would show up here.
  fetchSpy = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("row 1: flag off ⇒ no UI", () => {
  it("Home shows no voice lab link when the server says the lab is off", async () => {
    renderAt(<Home />, "/home");
    await waitFor(() => expect(screen.getByTestId("module-tile-voice")).toBeTruthy());
    expect(screen.queryByTestId("voicelab-link")).toBeNull();
  });

  it("/voicelab renders the 404 page and never asks for a token", async () => {
    renderAt(<AppRouter />, "/voicelab");
    await waitFor(() => expect(screen.getByText("Page Not Found")).toBeTruthy());
    expect(screen.queryByTestId("voicelab-page")).toBeNull();
    expect(voiceLabToken).not.toHaveBeenCalled();
  });

  it("with the lab on, Home links to it and /voicelab renders DISARMED", async () => {
    state.voiceLab = true;
    renderAt(<Home />, "/home");
    await waitFor(() => expect(screen.getByTestId("voicelab-link")).toBeTruthy());
    cleanup();

    renderAt(<AppRouter />, "/voicelab");
    const banner = await screen.findByTestId("voicelab-arm-state");
    expect(banner.getAttribute("data-armed")).toBe("false");
    expect(banner.textContent).toContain("DISARMED");
    expect(voiceLabToken).not.toHaveBeenCalled(); // the mic is not opened on arrival
  });
});

describe("arming, disarming, and leaving", () => {
  beforeEach(() => {
    state.voiceLab = true;
  });

  it("arming mints a token, opens the session with the phrase list, and shows ARMED", async () => {
    renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("true"));
    expect(voiceLabToken).toHaveBeenCalledTimes(1);
    expect(voiceLabToken).toHaveBeenCalledWith(); // no arguments: nothing to send
    expect(speech.starts).toEqual([{ token: "tok-123", region: "southcentralus", phrases: PHRASE_LIST }]);
    expect(screen.getByTestId("voicelab-arm-state").textContent).toContain("ARMED");

    fireEvent.click(screen.getByTestId("voicelab-disarm"));
    await waitFor(() => expect(speech.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("false");
  });

  it("navigating away disarms — the microphone is closed", async () => {
    const { memory } = renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("true"));
    act(() => memory.navigate("/home"));
    await waitFor(() => expect(speech.stop).toHaveBeenCalledTimes(1));
  });

  it("a session that opens AFTER the person left is closed at once", async () => {
    let release: () => void = () => {};
    speech.gate = new Promise<void>((r) => {
      release = r;
    });
    const { memory } = renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(speech.starts).toHaveLength(1));
    act(() => memory.navigate("/home"));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(speech.stop).toHaveBeenCalledTimes(1));
  });

  it("a spent budget is said honestly and nothing is armed", async () => {
    const { ApiError } = await import("@/lib/api");
    voiceLabToken.mockRejectedValueOnce(
      new ApiError("Today's voice lab budget is used up (30 of 30 minutes reserved).", 429, "VOICE_LAB_BUDGET_EXHAUSTED"),
    );
    renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(screen.getByTestId("voicelab-error").textContent).toContain("budget is used up"));
    expect(speech.starts).toHaveLength(0);
    expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("false");
  });
});

describe("the scripted run and free mode", () => {
  beforeEach(() => {
    state.voiceLab = true;
  });

  it("scores 50 prompts in page memory and sends nothing about them to CareIN", async () => {
    renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("true"));
    fireEvent.click(screen.getByTestId("voicelab-start-run"));

    for (let i = 0; i < 50; i++) {
      const prompt = screen.getByTestId("voicelab-prompt").textContent ?? "";
      expect(screen.getByTestId("voicelab-progress").textContent).toContain(`Prompt ${i + 1} of 50`);
      // Answer the first ten wrongly as "nine" (unless nine was asked), the rest correctly.
      if (i < 10 && prompt !== "nine") speak("nine");
      else if (i < 10) speak("eight");
      else speak(prompt);
    }

    const summary = await screen.findByTestId("voicelab-summary-text");
    expect(summary.textContent).toContain("Prompts: 50");
    expect(summary.textContent).toContain("Accuracy: 80% (40/50)");
    expect(summary.textContent).toContain("End of speech → final: median 300 ms, p95 300 ms (n=50)");

    // The token mint is the only lab call to CareIN; nothing said left the page.
    expect(voiceLabToken).toHaveBeenCalledTimes(1);
    assertNothingSaidLeftThePage(["nine", "eight", "Accuracy"]);
  });

  it("an empty final (noise) is not scored; Skip records a miss", async () => {
    renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("true"));
    fireEvent.click(screen.getByTestId("voicelab-start-run"));
    speak("");
    expect(screen.getByTestId("voicelab-progress").textContent).toContain("Prompt 1 of 50");
    fireEvent.click(screen.getByTestId("voicelab-skip"));
    expect(screen.getByTestId("voicelab-progress").textContent).toContain("Prompt 2 of 50");
  });

  it("free mode lists finals with timings, and they vanish with the page", async () => {
    renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("true"));
    speak("three four five");
    const log = screen.getByTestId("voicelab-free-log");
    expect(log.textContent).toContain("three four five");
    expect(log.textContent).toContain("final 300 ms");
    assertNothingSaidLeftThePage(["three four five"]);

    cleanup();
    renderAt(<AppRouter />, "/voicelab");
    await screen.findByTestId("voicelab-arm-state");
    expect(screen.getByTestId("voicelab-free-log").textContent).toBe("");
  });

  it("item 37: free mode shows BOTH forms of each final — display, and lexical (or that there was none)", async () => {
    renderAt(<AppRouter />, "/voicelab");
    fireEvent.click(await screen.findByTestId("voicelab-arm"));
    await waitFor(() => expect(screen.getByTestId("voicelab-arm-state").getAttribute("data-armed")).toBe("true"));
    speak("Jump to 2:30.", 1_000, "jump to two thirty");
    speak("three four five", 2_000, null);

    // Newest first.
    const [noLexical, withLexical] = screen.getAllByTestId("voicelab-free-entry");
    expect(withLexical.querySelector('[data-testid="voicelab-free-display"]')?.textContent).toBe("display Jump to 2:30.");
    expect(withLexical.querySelector('[data-testid="voicelab-free-lexical"]')?.textContent).toBe("lexical jump to two thirty");
    expect(noLexical.querySelector('[data-testid="voicelab-free-display"]')?.textContent).toBe("display three four five");
    expect(noLexical.querySelector('[data-testid="voicelab-free-lexical"]')?.textContent).toBe("lexical — (not provided)");

    // Page display only: neither form reached CareIN or storage.
    expect(voiceLabToken).toHaveBeenCalledTimes(1);
    assertNothingSaidLeftThePage(["2:30", "two thirty", "three four five"]);
  });
});
