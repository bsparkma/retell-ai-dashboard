/**
 * The "sound + banner" chime (queue item 51) never throws: no AudioContext,
 * or one that refuses, is silence — never a crash in the alert path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { playChime, resetChimeForTests } from "@/features/tc/notifications/chime";

const g = globalThis as Record<string, unknown>;
const original = { AudioContext: g.AudioContext, webkitAudioContext: g.webkitAudioContext };

afterEach(() => {
  g.AudioContext = original.AudioContext;
  g.webkitAudioContext = original.webkitAudioContext;
  resetChimeForTests();
});

class FakeParam {
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  value = 0;
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = "sine";
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

describe("playChime", () => {
  it("no Web Audio at all: silent, no throw", () => {
    g.AudioContext = undefined;
    g.webkitAudioContext = undefined;
    expect(playChime()).toBe(false);
  });

  it("a browser that refuses to build a context: silent, no throw", () => {
    g.AudioContext = class {
      constructor() {
        throw new Error("blocked");
      }
    };
    expect(playChime()).toBe(false);
  });

  it("plays two notes through a working context", () => {
    const made: FakeNode[] = [];
    g.AudioContext = class {
      currentTime = 0;
      state = "running";
      destination = {};
      resume = vi.fn(async () => undefined);
      createOscillator() {
        const n = new FakeNode();
        made.push(n);
        return n;
      }
      createGain() {
        return new FakeNode();
      }
    };
    expect(playChime()).toBe(true);
    expect(made).toHaveLength(2);
    expect(made.every((n) => n.start.mock.calls.length === 1 && n.stop.mock.calls.length === 1)).toBe(true);
  });
});
