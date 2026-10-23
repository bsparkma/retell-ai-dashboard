/**
 * A short two-note chime for "sound + banner" alerts (queue item 51).
 *
 * Synthesised with the Web Audio API, so there is no audio file to ship or
 * cache. NEVER THROWS: a browser that blocks audio until the page has been
 * interacted with (autoplay policy), or has no AudioContext at all, simply
 * stays quiet — the banner still shows, so the alert is not lost.
 */

type AudioContextCtor = new () => AudioContext;

let shared: AudioContext | null = null;

function context(): AudioContext | null {
  if (shared) return shared;
  const w = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    shared = null;
  }
  return shared;
}

/** Play the chime. Returns whether a sound was started. */
export function playChime(): boolean {
  const ctx = context();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime;
    // Two soft notes, a fifth apart: noticeable at a desk, not an alarm.
    [
      { freq: 880, at: 0 },
      { freq: 1318.5, at: 0.16 },
    ].forEach(({ freq, at }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + at);
      gain.gain.exponentialRampToValueAtTime(0.18, start + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start + at);
      osc.stop(start + at + 0.32);
    });
    return true;
  } catch {
    return false;
  }
}

/** TESTS ONLY: forget the shared context so a test can install a fake. */
export function resetChimeForTests(): void {
  shared = null;
}
