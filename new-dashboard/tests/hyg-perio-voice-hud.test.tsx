/**
 * PERIO VOICE HUD — the model and the component (item 36).
 *
 *   window   five teeth of the cursor's arch, centred, clamped at #1 and #16
 *            (and #17 / #32 on the lower arch)
 *   pass     the active row follows the cursor's side; lingual swaps the rows
 *   ribbon   an accepted phrase says what it did; every refusal says "nothing
 *            charted" — the grammar's five classes AND the sheet's own refusals
 *   no wire  the HUD issues no request and imports no API module
 *
 * The page-level paths (each disarm closes it; undo / skip / jump move the
 * strip) are in hyg-perio-voice-hud-page.test.tsx.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  emptyPerioChart,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
  type PerioCursor,
} from "@shared/hyg/perio";
import { initialPerioEntry, reducePerioEntry, type PerioEntryState } from "@/features/hyg/perio/entry";
import { parseVoiceFinal, VOICE_REJECT_REASONS, type VoiceCommand } from "@/features/hyg/perio/voiceGrammar";
import {
  HUD_CUES,
  hudCard,
  hudPass,
  hudPassProgress,
  hudRemaining,
  hudWindow,
  voiceOutcome,
  type HudHeard,
} from "@/features/hyg/perio/voiceHud";
import { PerioVoiceHud } from "@/features/hyg/perio/PerioVoiceHud";

(globalThis as Record<string, unknown>).React = React;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function commands(text: string): VoiceCommand[] {
  const parsed = parseVoiceFinal(text);
  if (parsed.kind !== "commands") throw new Error(`"${text}" did not parse: ${parsed.kind}`);
  return parsed.commands;
}

function at(state: PerioEntryState, cursor: PerioCursor): PerioEntryState {
  return reducePerioEntry(state, { type: "select", cursor });
}

describe("the window: five teeth of the arch, clamped at the ends", () => {
  it.each([
    [1, [1, 2, 3, 4, 5]],
    [2, [1, 2, 3, 4, 5]],
    [3, [1, 2, 3, 4, 5]],
    [4, [2, 3, 4, 5, 6]],
    [8, [6, 7, 8, 9, 10]],
    [14, [12, 13, 14, 15, 16]],
    [15, [12, 13, 14, 15, 16]],
    [16, [12, 13, 14, 15, 16]],
  ])("upper #%i → %j", (tooth, expected) => {
    expect(hudWindow(tooth)).toEqual(expected);
  });

  it("never crosses into the other arch — the lower arch clamps at #32 and #17, in screen order", () => {
    expect(hudWindow(32)).toEqual([32, 31, 30, 29, 28]);
    expect(hudWindow(17)).toEqual([21, 20, 19, 18, 17]);
    expect(hudWindow(24)).toEqual([26, 25, 24, 23, 22]);
    for (let t = 1; t <= 32; t += 1) {
      const w = hudWindow(t);
      expect(w).toHaveLength(5);
      expect(w).toContain(t);
      expect(w.every((x) => (t <= 16 ? x <= 16 : x >= 17))).toBe(true);
    }
  });
});

describe("the pass decides which row is large", () => {
  const chart = withPerioSite(withPerioSite(emptyPerioChart(), 3, "MB", { depth: 4 }), 3, "ML", { depth: 6 });

  it("on the facial pass the active row is the buccal three, the lingual three beneath", () => {
    const card = hudCard(chart, 3, { tooth: 3, surface: "B" });
    expect(card.active.map((s) => s.surface).sort()).toEqual(["B", "DB", "MB"]);
    expect(card.other.map((s) => s.surface).sort()).toEqual(["DL", "L", "ML"]);
    expect(card.active.find((s) => s.surface === "MB")?.depth).toBe(4);
    expect(card.ringed).toBe("B");
    expect(hudPass({ tooth: 3, surface: "B" }).label).toBe("Upper buccal pass");
  });

  it("when the pass flips to lingual, the rows swap", () => {
    const card = hudCard(chart, 3, { tooth: 3, surface: "L" });
    expect(card.active.map((s) => s.surface).sort()).toEqual(["DL", "L", "ML"]);
    expect(card.other.map((s) => s.surface).sort()).toEqual(["B", "DB", "MB"]);
    expect(card.active.find((s) => s.surface === "ML")?.depth).toBe(6);
    expect(hudPass({ tooth: 20, surface: "L" }).label).toBe("Lower lingual pass");
  });

  it("on screen: data-pass and the large row follow the cursor's side", () => {
    let entry = at(initialPerioEntry(chart), { tooth: 3, surface: "DB" });
    const { rerender } = render(<PerioVoiceHud entry={entry} heard={null} endsAt={Date.now() + 60_000} onDisarm={() => {}} />);
    expect(screen.getByTestId("hyg-perio-hud").dataset.pass).toBe("facial");
    const facialRow = screen.getByTestId("hyg-perio-hud-active-3");
    expect([...facialRow.querySelectorAll("[data-site]")].map((e) => e.getAttribute("data-site")).sort()).toEqual(["B", "DB", "MB"]);
    expect(facialRow.querySelector('[data-ringed="true"]')?.getAttribute("data-site")).toBe("DB");

    entry = at(entry, { tooth: 3, surface: "ML" });
    rerender(<PerioVoiceHud entry={entry} heard={null} endsAt={Date.now() + 60_000} onDisarm={() => {}} />);
    expect(screen.getByTestId("hyg-perio-hud").dataset.pass).toBe("lingual");
    const lingualRow = screen.getByTestId("hyg-perio-hud-active-3");
    expect([...lingualRow.querySelectorAll("[data-site]")].map((e) => e.getAttribute("data-site")).sort()).toEqual(["DL", "L", "ML"]);
    expect(lingualRow.querySelector('[data-ringed="true"]')?.getAttribute("data-site")).toBe("ML");
    expect(screen.getByTestId("hyg-perio-hud-other-3").textContent).toContain("MB 4");
  });
});

describe("the cards", () => {
  it("tags NOW / DONE / SKIPPED / NEXT, and shows a flags chip only when set", () => {
    let chart: PerioChart = emptyPerioChart();
    for (const s of ["DB", "B", "MB"] as const) chart = withPerioSite(chart, 1, s, { depth: 3 });
    chart = withPerioSite(chart, 1, "MB", { bleeding: true, calculus: true });
    chart = withPerioSkipped(chart, 2, true);
    const cursor: PerioCursor = { tooth: 3, surface: "DB" };
    expect(hudCard(chart, 1, cursor).tag).toBe("DONE");
    expect(hudCard(chart, 1, cursor).flags).toEqual(["bleeding", "calculus"]);
    expect(hudCard(chart, 2, cursor).tag).toBe("SKIPPED");
    expect(hudCard(chart, 3, cursor).tag).toBe("NOW");
    expect(hudCard(chart, 4, cursor).tag).toBe("NEXT");
    // A cursor left ON a skipped tooth still marks where she is, with nothing ringed.
    const onSkipped = hudCard(chart, 2, { tooth: 2, surface: "B" });
    expect(onSkipped).toMatchObject({ tag: "NOW", skipped: true, ringed: null });
    expect(hudCard(chart, 4, cursor).flags).toEqual([]);
    expect(hudPassProgress(chart, hudPass(cursor))).toEqual({ charted: 1, skipped: 1, total: 16 });

    render(<PerioVoiceHud entry={at(initialPerioEntry(chart), cursor)} heard={null} endsAt={Date.now()} onDisarm={() => {}} />);
    expect(screen.getByTestId("hyg-perio-hud-flags-1").textContent).toBe("bleeding · calculus");
    expect(screen.queryByTestId("hyg-perio-hud-flags-4")).toBeNull();
    expect(screen.getByTestId("hyg-perio-hud-pass").textContent).toBe("Upper buccal pass · 1 of 16 charted · 1 skipped");
  });
});

describe("the heard ribbon", () => {
  const start = initialPerioEntry(emptyPerioChart());

  function ribbon(heard: HudHeard | null) {
    cleanup();
    render(<PerioVoiceHud entry={start} heard={heard} endsAt={Date.now() + 60_000} onDisarm={() => {}} />);
    return screen.getByTestId("hyg-perio-hud-ribbon");
  }

  it("accepted: the commands echoed back, and what happened — never the raw transcript", () => {
    const outcome = voiceOutcome(start, commands("three two three bleeding"));
    expect(outcome).toEqual({
      kind: "accepted",
      heard: "3, 2, 3, bleeding",
      happened: "charted to tooth 1 · bleeding on 1 MB · moved to tooth 2",
    });
    const el = ribbon(outcome);
    expect(el.dataset.kind).toBe("accepted");
    expect(el.textContent).toContain("3, 2, 3, bleeding");
    expect(el.textContent).toContain("moved to tooth 2");
  });

  it("names a jump, a skip and an undo", () => {
    expect(voiceOutcome(start, commands("jump to tooth fourteen"))).toMatchObject({ happened: "moved to tooth 14 MB" });
    expect(voiceOutcome(start, commands("skip this tooth"))).toMatchObject({ happened: "skipped tooth 1 · moved to tooth 2" });
    expect(voiceOutcome(start, commands("missing"))).toMatchObject({ happened: "tooth 1 marked missing · moved to tooth 2" });
    const one = reducePerioEntry(start, { type: "voice", commands: commands("four") });
    expect(voiceOutcome(one, commands("undo"))).toMatchObject({ happened: "took back 1 DB" });
  });

  it("listening, before anything is heard", () => {
    expect(ribbon(null).dataset.kind).toBe("listening");
  });

  it.each([
    ["over_max", "fourteen"],
    ["concatenated", "1010"],
    ["out_of_vocabulary", "banana"],
    ["bad_tooth", "jump to tooth 40"],
    ["incomplete", "jump to tooth"],
  ] as const)("rejected by the grammar (%s): amber, \"nothing charted\", and item 35's own guidance", (reason, said) => {
    const parsed = parseVoiceFinal(said);
    if (parsed.kind !== "rejected") throw new Error("expected a rejection");
    expect(parsed.reason).toBe(reason);
    const el = ribbon({ kind: "rejected", reason: parsed.reason, heard: parsed.heard, message: parsed.message });
    expect(el.dataset.kind).toBe("rejected");
    expect(el.dataset.reason).toBe(reason);
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.textContent).toContain(`Heard “${parsed.heard}” — nothing charted`);
    expect(el.textContent).toContain(parsed.message);
  });

  it("covers every grammar rejection class", () => {
    expect([...VOICE_REJECT_REASONS].sort()).toEqual(
      ["bad_tooth", "concatenated", "incomplete", "out_of_vocabulary", "over_max"].sort(),
    );
  });

  it.each([
    ["a skipped tooth", () => reducePerioEntry(start, { type: "toggleSkip" }), "jump to tooth one", /#1 is skipped/],
    ["not in Depth mode", () => reducePerioEntry(start, { type: "mode", mode: "gm" }), "three", /probing depths only/],
    ["nothing to undo", () => start, "undo", /nothing to undo/],
    [
      "the end of the chart",
      () => {
        let s = at(start, { tooth: 32, surface: "DB" });
        s = reducePerioEntry(s, { type: "voice", commands: commands("three") });
        return s;
      },
      "four",
      /end of the chart/,
    ],
  ] as const)("refused by the sheet (%s): the sheet's own sentence, nothing charted", (_label, make, said, why) => {
    const before = make();
    const outcome = voiceOutcome(before, commands(said));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.message).toMatch(why);
    // It says exactly what the sheet would.
    expect(outcome.message).toBe(reducePerioEntry(before, { type: "voice", commands: commands(said) }).refusal);
    const el = ribbon(outcome);
    expect(el.dataset.kind).toBe("refused");
    expect(el.textContent).toMatch(/— nothing charted/);
  });
});

describe("the header", () => {
  it("counts the session down from the mint, and Disarm calls the disarm it is given", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-07T13:00:00Z"));
    const onDisarm = vi.fn();
    render(<PerioVoiceHud entry={initialPerioEntry(emptyPerioChart())} heard={null} endsAt={Date.now() + 570_000} onDisarm={onDisarm} />);
    expect(screen.getByTestId("hyg-perio-hud-remaining").textContent).toBe("9:30");
    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByTestId("hyg-perio-hud-remaining").textContent).toBe("8:29");
    fireEvent.click(screen.getByTestId("hyg-perio-hud-disarm"));
    expect(onDisarm).toHaveBeenCalledTimes(1);
    expect(hudRemaining(1000, 5000)).toBe("0:00");
  });

  it("always shows the cue row", () => {
    render(<PerioVoiceHud entry={initialPerioEntry(emptyPerioChart())} heard={null} endsAt={Date.now()} onDisarm={() => {}} />);
    const cues = screen.getByTestId("hyg-perio-hud-cues").textContent ?? "";
    for (const cue of HUD_CUES) expect(cues).toContain(cue);
    for (const flag of ["bleeding", "suppuration", "plaque", "calculus"]) expect(cues).toContain(flag);
  });
});

describe("no wire: the HUD issues no request", () => {
  it("renders, ticks and re-renders without touching fetch, XHR, beacons or storage", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
    const beacon = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });

    let entry = initialPerioEntry(emptyPerioChart());
    const { rerender } = render(<PerioVoiceHud entry={entry} heard={null} endsAt={Date.now() + 570_000} onDisarm={() => {}} />);
    entry = reducePerioEntry(entry, { type: "voice", commands: commands("three two three") });
    rerender(
      <PerioVoiceHud entry={entry} heard={voiceOutcome(initialPerioEntry(emptyPerioChart()), commands("three two three"))} endsAt={Date.now() + 570_000} onDisarm={() => {}} />,
    );
    act(() => vi.advanceTimersByTime(5_000));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("imports no API module and names no transport (source pin)", () => {
    for (const file of ["PerioVoiceHud.tsx", "voiceHud.ts"]) {
      const src = readFileSync(resolve(import.meta.dirname, "../client/src/features/hyg/perio", file), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.filter((m) => /api|speech|auth|query/i.test(m)), `${file} imports`).toEqual([]);
      expect(src, file).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage/);
    }
  });
});
