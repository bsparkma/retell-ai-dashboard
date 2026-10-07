/**
 * Voice lab — a STAGING-ONLY page that measures streaming dictation (queue
 * item 34). Digit words only: no patient, no Open Dental, no model.
 *
 * WHERE THINGS GO
 *   - Audio: microphone → Azure Speech, directly from this browser, using a
 *     10-minute token the backend mints. Never to CareIN, never to disk.
 *   - Text: Azure → this page's memory. Gone on reload. Nothing about what was
 *     said is sent to CareIN; the only request this page makes to CareIN is
 *     the bodyless token mint.
 *
 * ARMED / DISARMED. The microphone is open only while ARMED. Leaving the page,
 * hiding the tab, or the token nearing expiry all disarm it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Copy, Mic, MicOff, Play, SkipForward, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import NotFound from "@/pages/NotFound";
import {
  PHRASE_LIST,
  SCRIPTED_RUN_LENGTH,
  deriveLatencies,
  formatSummary,
  pickPrompts,
  summarize,
  type DigitWord,
  type RunSummary,
  type Trial,
} from "./scoring";
import { startSpeechSession, type RecognizedSpeech, type SpeechSession } from "@/lib/speech/speechSession";

/** Disarm before the 10-minute token can expire mid-sentence. */
export const AUTO_DISARM_MS = 9.5 * 60 * 1000;

/** Free mode keeps the most recent finals on screen; older ones drop off. */
const FREE_LOG_LIMIT = 30;

interface FreeEntry {
  id: number;
  text: string;
  finalMs: number;
  firstPartialMs: number | null;
}

interface ScriptedState {
  prompts: DigitWord[];
  trials: Trial[];
}

function describeTokenError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The voice lab is not enabled on this server.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Could not get a speech token.";
}

function fmtMs(v: number | null): string {
  return v === null ? "—" : `${Math.round(v)} ms`;
}

export default function VoiceLab() {
  const auth = useAuth();
  const enabled = auth.status === "authenticated" && auth.user.voiceLab === true;

  const [armed, setArmed] = useState(false);
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<string>("");
  const [freeLog, setFreeLog] = useState<FreeEntry[]>([]);
  const [scripted, setScripted] = useState<ScriptedState | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [copied, setCopied] = useState(false);

  const sessionRef = useRef<SpeechSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPartialAtRef = useRef<number | null>(null);
  const scriptedRef = useRef<ScriptedState | null>(null);
  const nextIdRef = useRef(1);
  /**
   * Bumped by every disarm. An arm that was still waiting on the token or the
   * microphone when the person left (or disarmed) sees a different number when
   * its session finally opens, and closes it at once — a late session must
   * never leave a live microphone behind a page that is gone.
   */
  const generationRef = useRef(0);
  scriptedRef.current = scripted;

  const disarm = useCallback(async (reason?: string) => {
    generationRef.current += 1;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const session = sessionRef.current;
    sessionRef.current = null;
    setArmed(false);
    setPartial("");
    firstPartialAtRef.current = null;
    if (reason) setError(reason);
    if (session) await session.stop();
  }, []);

  /** Record one scripted outcome and advance; finishing computes the summary. */
  const recordTrial = useCallback((trial: Trial) => {
    const current = scriptedRef.current;
    if (!current || current.trials.length >= current.prompts.length) return;
    const trials = [...current.trials, trial];
    const next = { prompts: current.prompts, trials };
    scriptedRef.current = next;
    setScripted(next);
    if (trials.length === current.prompts.length) setSummary(summarize(trials));
  }, []);

  const onPartial = useCallback((r: RecognizedSpeech) => {
    if (firstPartialAtRef.current === null) firstPartialAtRef.current = r.atMs;
    setPartial(r.text);
  }, []);

  const onFinal = useCallback(
    (r: RecognizedSpeech) => {
      const firstPartialArrivalMs = firstPartialAtRef.current;
      firstPartialAtRef.current = null;
      setPartial("");
      // An empty final is Azure hearing noise, not an answer. Ignore it rather
      // than score it; the Skip button is how a person records a real miss.
      if (r.text.trim() === "") return;
      const session = sessionRef.current;
      const { finalMs, firstPartialMs } = deriveLatencies({
        offsetTicks: r.offsetTicks,
        durationTicks: r.durationTicks,
        finalArrivalMs: r.atMs,
        sdkLatencyMs: r.sdkLatencyMs,
        firstPartialArrivalMs,
        fallbackStreamStartMs: session ? session.streamStartMs : r.atMs,
      });

      const run = scriptedRef.current;
      if (run && run.trials.length < run.prompts.length) {
        recordTrial({ prompted: run.prompts[run.trials.length], recognized: r.text, finalMs, firstPartialMs });
        return;
      }
      const id = nextIdRef.current++;
      setFreeLog((log) => [{ id, text: r.text, finalMs, firstPartialMs }, ...log].slice(0, FREE_LOG_LIMIT));
    },
    [recordTrial],
  );

  const arm = useCallback(async () => {
    if (sessionRef.current || arming) return;
    setArming(true);
    setError(null);
    const generation = generationRef.current;
    try {
      const { token, region } = await api.voiceLabToken();
      // The token's 10 minutes start NOW, not when the microphone prompt is
      // answered — so the auto-disarm counts from here.
      const mintedAt = Date.now();
      if (generation !== generationRef.current) return;
      const session = await startSpeechSession(token, region, PHRASE_LIST, {
        onPartial,
        onFinal,
        onError: (message) => void disarm(`Recognition stopped: ${message}`),
      });
      if (generation !== generationRef.current) {
        await session.stop();
        return;
      }
      sessionRef.current = session;
      setArmed(true);
      timerRef.current = setTimeout(
        () => void disarm("Disarmed automatically: the speech token is about to expire. Arm again to continue."),
        Math.max(0, AUTO_DISARM_MS - (Date.now() - mintedAt)),
      );
    } catch (err) {
      setError(describeTokenError(err));
    } finally {
      setArming(false);
    }
  }, [arming, disarm, onFinal, onPartial]);

  // Leaving the page (route change, reload, tab hidden) disarms the microphone.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void disarm("Disarmed: the page was hidden.");
    };
    const onPageHide = () => void disarm();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      void disarm();
    };
  }, [disarm]);

  const startRun = () => {
    const run = { prompts: pickPrompts(SCRIPTED_RUN_LENGTH, Math.random), trials: [] };
    scriptedRef.current = run;
    setScripted(run);
    setSummary(null);
    setCopied(false);
    firstPartialAtRef.current = null;
  };

  const skipPrompt = () => {
    const run = scriptedRef.current;
    if (!run || run.trials.length >= run.prompts.length) return;
    recordTrial({ prompted: run.prompts[run.trials.length], recognized: "", finalMs: null, firstPartialMs: null });
  };

  const endRun = () => {
    const run = scriptedRef.current;
    if (run && run.trials.length > 0) setSummary(summarize(run.trials));
    scriptedRef.current = null;
    setScripted(null);
  };

  const copyResults = async () => {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(formatSummary(summary));
      setCopied(true);
    } catch {
      setError("Could not copy — select the results text and copy it by hand.");
    }
  };

  if (!enabled) return <NotFound />;

  const running = scripted !== null && scripted.trials.length < scripted.prompts.length;
  const currentPrompt = running ? scripted.prompts[scripted.trials.length] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6" data-testid="voicelab-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Voice lab</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Staging only. Measures streaming dictation of digit words. Audio goes from this browser straight to Azure
          Speech; results stay on this page and vanish on reload. No patient, no chart, nothing saved.
        </p>
      </div>

      <div
        className={
          armed
            ? "flex items-center justify-between rounded-xl border-2 border-red-600 bg-red-600 p-6 text-white"
            : "flex items-center justify-between rounded-xl border-2 border-border bg-muted p-6 text-foreground"
        }
        data-testid="voicelab-arm-state"
        data-armed={armed ? "true" : "false"}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3">
          {armed ? <Mic size={32} /> : <MicOff size={32} />}
          <div>
            <div className="text-3xl font-black tracking-wider">{armed ? "ARMED" : "DISARMED"}</div>
            <div className="text-sm opacity-90">{armed ? "Microphone is live" : "Microphone is off"}</div>
          </div>
        </div>
        {armed ? (
          <Button variant="secondary" size="lg" onClick={() => void disarm()} data-testid="voicelab-disarm">
            <Square size={16} /> Disarm
          </Button>
        ) : (
          <Button size="lg" onClick={() => void arm()} disabled={arming} data-testid="voicelab-arm">
            <Mic size={16} /> {arming ? "Arming…" : "Arm microphone"}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-foreground" data-testid="voicelab-error">
          {error}
        </div>
      )}

      {/* Scripted run — the measurement. */}
      <section className="space-y-3 rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">Scripted run</h2>
          {running ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={skipPrompt} data-testid="voicelab-skip">
                <SkipForward size={16} /> Nothing recognised — skip
              </Button>
              <Button variant="outline" onClick={endRun} data-testid="voicelab-end-run">
                End run
              </Button>
            </div>
          ) : (
            <Button onClick={startRun} disabled={!armed} data-testid="voicelab-start-run">
              <Play size={16} /> Start {SCRIPTED_RUN_LENGTH}-prompt run
            </Button>
          )}
        </div>
        {!armed && !running && <p className="text-sm text-muted-foreground">Arm the microphone to start a run.</p>}
        {running && currentPrompt && (
          <div className="py-6 text-center">
            <div className="text-sm text-muted-foreground" data-testid="voicelab-progress">
              Prompt {scripted.trials.length + 1} of {scripted.prompts.length} — say:
            </div>
            <div className="mt-2 text-6xl font-black text-foreground" data-testid="voicelab-prompt">
              {currentPrompt}
            </div>
            <div className="mt-3 h-6 text-base text-muted-foreground">{partial}</div>
          </div>
        )}
        {summary && (
          <div className="space-y-3" data-testid="voicelab-summary">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Accuracy" value={summary.accuracyPct === null ? "—" : `${summary.accuracyPct}%`} />
              <Stat label="Final median" value={fmtMs(summary.final.medianMs)} />
              <Stat label="Final p95" value={fmtMs(summary.final.p95Ms)} />
              <Stat label="First partial median" value={fmtMs(summary.firstPartial.medianMs)} />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-foreground" data-testid="voicelab-summary-text">
              {formatSummary(summary)}
            </pre>
            <Button variant="outline" onClick={() => void copyResults()} data-testid="voicelab-copy">
              <Copy size={16} /> {copied ? "Copied" : "Copy results"}
            </Button>
          </div>
        )}
      </section>

      {/* Free mode — anything goes, nothing is kept. */}
      {!running && (
        <section className="space-y-3 rounded-xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground">Free mode</h2>
          <p className="text-sm text-muted-foreground">
            While armed, say anything (“three four five”). Partials and finals appear here with their timings.
          </p>
          <div className="min-h-6 text-base italic text-muted-foreground" data-testid="voicelab-partial">
            {armed ? partial || "…listening" : ""}
          </div>
          <ul className="divide-y divide-border" data-testid="voicelab-free-log">
            {freeLog.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="font-medium text-foreground">{e.text}</span>
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  final {fmtMs(e.finalMs)} · first partial {fmtMs(e.firstPartialMs)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href="/home" className="text-sm text-muted-foreground underline">
        Back to home
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}
