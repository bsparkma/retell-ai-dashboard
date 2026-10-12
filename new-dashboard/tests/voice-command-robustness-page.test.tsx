/**
 * VOICE COMMAND ROBUSTNESS ON THE SHEET (item 37) — the page half.
 *
 *   lexical   the voice entry parses a final's LEXICAL text, so the cursor goes
 *             where the spoken words said
 *   display   the HUD's heard ribbon SHOWS the display text — what Azure wrote —
 *             for an accepted final, a grammar rejection and a sheet refusal
 *   fallback  a final with no lexical form is parsed from its display text, and
 *             every staging capture still lands on the right tooth and site
 *
 * The speech session and the hyg API are mocked; PerioVoiceEntry is driven with
 * the sheet's own reducer, so where a command lands is the sheet's answer.
 * NO NETWORK, NO BACKEND, NO PHI. Items 35 and 36's page suites are untouched.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { emptyPerioChart } from "@shared/hyg/perio";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    mintHygVoiceToken: vi.fn(async () => ({ success: true, token: "tok-hyg-37", region: "southcentralus" })),
  };
});

interface Final {
  text: string;
  lexical?: string | null;
  atMs: number;
  offsetTicks: number;
  durationTicks: number;
  sdkLatencyMs: number | null;
}
const speech = vi.hoisted(() => ({
  handlers: null as null | { onPartial: (r: Final) => void; onFinal: (r: Final) => void; onError: (m: string) => void },
  stop: vi.fn(async () => {}),
}));

vi.mock("@/lib/speech/speechSession", () => ({
  startSpeechSession: vi.fn(async (_t: string, _r: string, _p: readonly string[], handlers: typeof speech.handlers) => {
    speech.handlers = handlers;
    return { streamStartMs: 0, stop: speech.stop };
  }),
}));

import { PerioVoiceEntry } from "@/features/hyg/perio/PerioVoiceEntry";
import { initialPerioEntry, reducePerioEntry, type PerioEntryState } from "@/features/hyg/perio/entry";
import { CAPTURED_FINALS } from "./fixtures/voiceCaptures";

function Sheet({ start }: { start?: PerioEntryState }) {
  const [entry, setEntry] = React.useState<PerioEntryState>(() => start ?? initialPerioEntry(emptyPerioChart()));
  return (
    <>
      <output data-testid="cursor">{`${entry.cursor.tooth} ${entry.cursor.surface}`}</output>
      <PerioVoiceEntry
        office="roland"
        locked={false}
        entry={entry}
        onCommands={(commands) => setEntry((e) => reducePerioEntry(e, { type: "voice", commands }))}
      />
    </>
  );
}

async function arm(start?: PerioEntryState) {
  render(<Sheet start={start} />);
  fireEvent.click(screen.getByTestId("hyg-perio-voice-toggle"));
  await waitFor(() => expect(screen.getByTestId("hyg-perio-voice-state").dataset.armed).toBe("true"));
}

function say(text: string, lexical?: string | null) {
  act(() => {
    speech.handlers?.onFinal({ text, lexical, atMs: 1000, offsetTicks: 0, durationTicks: 0, sdkLatencyMs: null });
  });
}

const cursor = () => screen.getByTestId("cursor").textContent;
const ribbon = () => screen.getByTestId("hyg-perio-hud-ribbon");
const said = () => screen.queryByTestId("hyg-perio-hud-said")?.textContent ?? null;

beforeEach(() => {
  speech.handlers = null;
  speech.stop.mockClear();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("item 37: the sheet parses the lexical text and shows the display text", () => {
  it("“Jump to 2:30” with lexical “jump to two thirty” moves to tooth 30; the ribbon shows “Jump to 2:30.”", async () => {
    await arm();
    say("Jump to 2:30.", "jump to two thirty");
    expect(cursor()).toMatch(/^30 /);
    expect(ribbon().dataset.kind).toBe("accepted");
    expect(ribbon().textContent).toContain("jump to #30");
    expect(said()).toBe("Recognized “Jump to 2:30.”");
  });

  it("the LEXICAL text wins when the two disagree: display “11” vs lexical “eleven” charts an 11", async () => {
    await arm();
    say("11", "eleven");
    expect(ribbon().dataset.kind).toBe("accepted");
    expect(ribbon().textContent).toContain("11");
    expect(said()).toBe("Recognized “11”");
  });

  it("a grammar rejection is amber, names the parsed word, and shows the display text", async () => {
    await arm();
    say("Jump to tooth 33.", "jump to tooth thirty three");
    expect(ribbon().dataset.kind).toBe("rejected");
    expect(ribbon().dataset.reason).toBe("bad_tooth");
    expect(ribbon().textContent).toContain("Heard “thirty three” — nothing charted");
    expect(said()).toBe("Recognized “Jump to tooth 33.”");
    expect(cursor()).toBe("1 DB");
    // Item 35's own strip line still says it too.
    expect(screen.getByTestId("hyg-perio-voice-rejected").textContent).toMatch(/Teeth are 1–32/);
  });

  it("a clock time said where a depth goes is refused as one number, and charts nothing", async () => {
    await arm();
    say("3 2:30", null);
    expect(ribbon().dataset.kind).toBe("rejected");
    expect(ribbon().dataset.reason).toBe("concatenated");
    expect(cursor()).toBe("1 DB");
  });

  it("a sheet refusal shows the display text too", async () => {
    await arm(reducePerioEntry(initialPerioEntry(emptyPerioChart()), { type: "mode", mode: "gm" }));
    say("Three.", "three");
    expect(ribbon().dataset.kind).toBe("refused");
    expect(said()).toBe("Recognized “Three.”");
  });
});

describe("item 37: with NO lexical form, the display text is parsed — every staging capture still lands", () => {
  it.each(CAPTURED_FINALS)("%j", async (display, expected) => {
    await arm();
    say(display, null);
    expect(ribbon().dataset.kind, display).toBe("accepted");
    if (expected.type === "jump") expect(cursor()).toMatch(new RegExp(`^${expected.tooth} `));
    else expect(cursor()).toBe("3 MB");
    expect(said()).toBe(`Recognized “${display}”`);
  });
});
