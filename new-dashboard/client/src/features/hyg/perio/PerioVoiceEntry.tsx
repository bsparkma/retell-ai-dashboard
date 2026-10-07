/**
 * Perio voice entry (queue item 35) — the arm toggle and what it heard.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THINGS GO
 * ═════════════════════════════════════════════════════════════════════════════
 *   - Audio: microphone → Azure Speech, directly from this browser, using a
 *     10-minute token the hyg backend mints (lib/speech/speechSession.ts). Never
 *     to CareIN, never to disk.
 *   - Text: Azure → this component's memory → `parseVoiceFinal` → commands.
 *     The commands go to the sheet's OWN entry reducer (`onCommands`), so what
 *     was said becomes readings in the chart she is already editing — and from
 *     there only through the chart's existing save, stage, and confirm-to-send.
 *     The words themselves are never sent anywhere and never stored.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ARMED, PER VISIT (decision V-6)
 * ═════════════════════════════════════════════════════════════════════════════
 * The microphone is open only while ARMED, and ARMED is loud. It is component
 * state and nothing else: the sheet mounts this with a key per visit, so every
 * visit starts DISARMED, and there is no setting anywhere that remembers it.
 * It disarms on: leaving the page, the tab going hidden, the page being
 * unloaded, 9.5 minutes after the token was minted (the token lives 10), the
 * chart locking for a send, and any recognition error.
 *
 * ITEM 36: while ARMED, the HUD (PerioVoiceHud) covers the sheet. It is rendered
 * from here and only while `armed`, so every disarm above closes it too. It is
 * fed what this component already knows — the sheet's entry state, the last
 * parse, the mint time — and adds no request, no route and no stored value.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Mic, MicOff, Square } from "lucide-react";

import type { OfficeId } from "@shared/hyg/contract";
import { HygApiError, mintHygVoiceToken } from "@/features/hyg/api";
import type { SpeechSession } from "@/lib/speech/speechSession";
import { cn } from "@/lib/utils";
import { reducePerioEntry, type PerioEntryState } from "./entry";
import { PerioVoiceHud } from "./PerioVoiceHud";
import { voiceOutcome, type HudHeard } from "./voiceHud";
import {
  PERIO_VOICE_PHRASES,
  describeVoiceCommands,
  parseVoiceFinal,
  type VoiceCommand,
} from "./voiceGrammar";

/** Disarm before the 10-minute token can expire mid-sentence. */
export const VOICE_AUTO_DISARM_MS = 9.5 * 60 * 1000;

function describeArmError(err: unknown): string {
  if (err instanceof HygApiError) {
    if (err.status === 404) return "Voice entry is not switched on for this server. Keep charting by keyboard.";
    return err.message;
  }
  if (err instanceof Error && /permission|notallowed/i.test(err.name + err.message)) {
    return "The browser did not allow the microphone. Allow it for this site, then arm again.";
  }
  return err instanceof Error ? err.message : "Voice entry could not start. Keep charting by keyboard.";
}

export interface PerioVoiceEntryProps {
  office: OfficeId;
  /** A chart that is sending, stopped or written takes no readings — and voice disarms. */
  locked: boolean;
  /** ITEM 36: the sheet's entry state, for the HUD to show. Read only. */
  entry: PerioEntryState;
  /** Apply one parsed final to the sheet. The sheet owns WHERE it lands. */
  onCommands: (commands: VoiceCommand[]) => void;
  /** Hand the keyboard back to the grid after a tap here. */
  onReturnFocus?: () => void;
}

export function PerioVoiceEntry({ office, locked, entry, onCommands, onReturnFocus }: PerioVoiceEntryProps) {
  const [armed, setArmed] = useState(false);
  const [arming, setArming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  /** The last final that was refused: what was heard, and why. Memory only. */
  const [rejection, setRejection] = useState<string | null>(null);
  /** The last final that was parsed and handed to the sheet, echoed as commands — never as the transcript. */
  const [applied, setApplied] = useState<string | null>(null);
  /** ITEM 36: what the last final did, for the HUD's ribbon. Memory only. */
  const [heard, setHeard] = useState<HudHeard | null>(null);
  /** ITEM 36: when the auto-disarm fires (mint + 9.5 min), for the HUD's countdown. */
  const [endsAt, setEndsAt] = useState<number | null>(null);
  /**
   * The sheet's state as of the last render — the state a final is applied to.
   * Advanced locally after each final so two finals in one tick are each judged
   * against the state the one before left; the next render replaces it anyway.
   */
  const entryRef = useRef(entry);
  entryRef.current = entry;

  const sessionRef = useRef<SpeechSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Bumped by every disarm. An arm still waiting on the token or the microphone
   * when she left sees a different number when its session opens, and closes
   * it at once — a late session must never leave a live microphone behind.
   */
  const generationRef = useRef(0);
  const onCommandsRef = useRef(onCommands);
  onCommandsRef.current = onCommands;
  /**
   * ITEM 36: a final that lands while the chart is locked is dropped by the
   * sheet (HygPerio `onVoice`), so the HUD must not paint it green either —
   * the disarm effect below runs one render later.
   */
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const disarm = useCallback(async (reason?: string) => {
    generationRef.current += 1;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const session = sessionRef.current;
    sessionRef.current = null;
    setArmed(false);
    setArming(false);
    setPartial("");
    if (reason) setNotice(reason);
    if (session) await session.stop();
  }, []);

  const onFinal = useCallback((text: string) => {
    setPartial("");
    const parsed = parseVoiceFinal(text);
    if (parsed.kind === "ignored") return;
    if (parsed.kind === "rejected") {
      setRejection(parsed.message);
      setApplied(null);
      setHeard({ kind: "rejected", reason: parsed.reason, heard: parsed.heard, message: parsed.message });
      return;
    }
    setRejection(null);
    setApplied(describeVoiceCommands(parsed.commands));
    // The ribbon's account of it comes from the sheet's own reducer, run on a copy.
    if (!lockedRef.current) {
      setHeard(voiceOutcome(entryRef.current, parsed.commands));
      entryRef.current = reducePerioEntry(entryRef.current, { type: "voice", commands: parsed.commands });
    }
    onCommandsRef.current(parsed.commands);
  }, []);

  const arm = useCallback(async () => {
    if (sessionRef.current || arming || locked) return;
    setArming(true);
    setNotice(null);
    setRejection(null);
    setHeard(null);
    const generation = generationRef.current;
    try {
      const { token, region } = await mintHygVoiceToken(office);
      // The token's 10 minutes start NOW, not when the microphone prompt is answered.
      const mintedAt = Date.now();
      if (generation !== generationRef.current) return;
      // Loaded on demand: the Speech SDK stays out of the bundle until someone arms.
      const { startSpeechSession } = await import("@/lib/speech/speechSession");
      if (generation !== generationRef.current) return;
      // Every event is tied to THIS arm. After a disarm (or before a late
      // session is closed) the generation has moved on, and a final arriving
      // then — mid-stop, or from a session that opened after she left — is
      // dropped: once the banner says VOICE OFF, nothing more is charted.
      const live = () => generation === generationRef.current;
      const session = await startSpeechSession(token, region, PERIO_VOICE_PHRASES, {
        onPartial: (r) => {
          if (live()) setPartial(r.text);
        },
        onFinal: (r) => {
          if (live()) onFinal(r.text);
        },
        onError: (message) => {
          if (live()) void disarm(`Voice stopped: ${message}`);
        },
      });
      if (generation !== generationRef.current) {
        await session.stop();
        return;
      }
      sessionRef.current = session;
      setArmed(true);
      setEndsAt(mintedAt + VOICE_AUTO_DISARM_MS);
      timerRef.current = setTimeout(
        () => void disarm("Voice disarmed itself: its 10-minute token is about to run out. Arm again to carry on."),
        Math.max(0, VOICE_AUTO_DISARM_MS - (Date.now() - mintedAt)),
      );
    } catch (err) {
      if (generation === generationRef.current) setNotice(describeArmError(err));
    } finally {
      if (generation === generationRef.current) setArming(false);
    }
  }, [arming, locked, office, disarm, onFinal]);

  // Leaving the page, hiding the tab, or unloading it disarms the microphone.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void disarm("Voice disarmed: the page was hidden.");
    };
    const onPageHide = () => void disarm();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      void disarm();
    };
  }, [disarm]);

  // A chart that locks for a send takes no more readings, so the microphone closes.
  useEffect(() => {
    if (locked && (sessionRef.current || arming)) {
      void disarm("Voice disarmed: this chart is locked while it is sent.");
    }
  }, [locked, arming, disarm]);

  const toggle = () => {
    if (armed || arming) void disarm();
    else void arm();
    onReturnFocus?.();
  };

  return (
    <section className="mt-3" data-testid="hyg-perio-voice" data-heard={heard?.kind}>
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 px-4 py-3",
          armed ? "border-red-600 bg-red-600 text-white" : "border-border bg-muted text-foreground",
        )}
        data-testid="hyg-perio-voice-state"
        data-armed={armed ? "true" : "false"}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3">
          {armed ? <Mic size={28} /> : <MicOff size={28} />}
          <div>
            <div className="text-xl font-black tracking-wider">{armed ? "VOICE ARMED" : "VOICE OFF"}</div>
            <div className="text-sm opacity-90">
              {armed
                ? "The microphone is live. Say depths 0–12, a flag, or a command."
                : "Arm to chart depths by voice for this visit. It is never left on."}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={!armed && !arming && locked}
          aria-pressed={armed}
          data-testid="hyg-perio-voice-toggle"
          className={cn(
            "min-h-11 rounded-lg border px-4 text-sm font-semibold transition-colors disabled:opacity-40",
            armed ? "border-white/80 bg-red-800 text-white hover:bg-red-900" : "border-border bg-background hover:bg-accent/50",
          )}
        >
          {armed ? (
            <span className="flex items-center gap-1.5">
              <Square size={14} /> Disarm
            </span>
          ) : arming ? (
            "Arming…"
          ) : (
            <span className="flex items-center gap-1.5">
              <Mic size={14} /> Arm voice
            </span>
          )}
        </button>
      </div>

      {armed ? (
        <p className="mt-1.5 min-h-5 text-sm italic text-muted-foreground" data-testid="hyg-perio-voice-partial">
          {partial || "…listening"}
        </p>
      ) : null}

      {rejection !== null ? (
        <p
          role="alert"
          className="mt-2 flex items-start gap-1.5 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-900 dark:text-amber-300"
          data-testid="hyg-perio-voice-rejected"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          {rejection}
        </p>
      ) : applied !== null ? (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="hyg-perio-voice-applied">
          {/* "Heard", not "charted": the sheet can still refuse it (a skipped
              tooth, a non-depth mode), and its own banner says so when it does. */}
          Heard: <span className="font-medium text-foreground">{applied}</span>
        </p>
      ) : null}

      {notice !== null ? (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="hyg-perio-voice-notice">
          {notice}
        </p>
      ) : null}

      {armed && endsAt !== null ? (
        <PerioVoiceHud
          entry={entry}
          heard={heard}
          endsAt={endsAt}
          onDisarm={() => {
            void disarm();
            onReturnFocus?.();
          }}
        />
      ) : null}
    </section>
  );
}
