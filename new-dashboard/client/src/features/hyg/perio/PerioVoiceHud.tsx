/**
 * Perio voice HUD (queue item 36) — the big screen while voice is ARMED.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PURE PRESENTATION
 * ═════════════════════════════════════════════════════════════════════════════
 * It renders state item 35 already keeps and nothing else: the sheet's entry
 * state, what the last final did (`HudHeard`, worked out by the sheet's own
 * reducer in voiceHud.ts), and when the token's 9.5 minutes run out. It imports
 * no API module, issues no request, stores nothing, and its one button is the
 * existing disarm. A test pins all of that.
 *
 * It is mounted by PerioVoiceEntry ONLY while armed, so every way voice disarms
 * — the Disarm here or on the banner, leaving the page, a hidden tab, 9.5
 * minutes, the chart locking for a send — takes the HUD down with it and leaves
 * the sheet exactly as charted.
 *
 * It does NOT take focus: the grid keeps the keyboard, so a key still charts
 * while the HUD is up, through the same reducer as ever.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Square } from "lucide-react";

import { PERIO_FLAG_LABELS } from "@shared/hyg/perio";
import { cn } from "@/lib/utils";
import type { PerioEntryState } from "./entry";
import {
  HUD_CUES,
  hudCard,
  hudPass,
  hudPassProgress,
  hudRemaining,
  hudWindow,
  type HudCard,
  type HudHeard,
} from "./voiceHud";

/*
 * The approved mockup's palette, as literal classes so Tailwind sees them:
 * teal #0E7C7B for "where you are", ARMED red #C2362B for "the mic is live".
 */

export interface PerioVoiceHudProps {
  entry: PerioEntryState;
  heard: HudHeard | null;
  /** Epoch ms when voice disarms itself (mint + 9.5 min). */
  endsAt: number;
  onDisarm: () => void;
}

function Depth({ value }: { value: number | null }) {
  return <>{value === null ? "·" : value}</>;
}

function ToothCard({ card }: { card: HudCard }) {
  const now = card.tag === "NOW";
  return (
    <li
      data-testid={`hyg-perio-hud-tooth-${card.tooth}`}
      data-tag={card.tag}
      className={cn(
        "flex min-w-0 flex-col items-center rounded-2xl border bg-card px-2 py-3 text-card-foreground",
        now ? "z-10 scale-105 border-transparent shadow-lg ring-4 ring-[#0E7C7B]" : "border-border",
        card.tag === "NEXT" ? "opacity-50" : "",
        card.tag === "SKIPPED" ? "opacity-60" : "",
      )}
    >
      <div className="flex w-full items-center justify-between gap-1 px-1">
        <span className="font-['Sora',sans-serif] text-2xl font-extrabold">#{card.tooth}</span>
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-bold tracking-wider",
            now ? "bg-[#0E7C7B] text-white" : "bg-muted text-muted-foreground",
          )}
        >
          {card.tag}
        </span>
      </div>

      {card.tag === "SKIPPED" ? (
        <div className="py-6 text-lg font-semibold text-muted-foreground">skipped</div>
      ) : (
        <>
          <div className="mt-2 grid w-full grid-cols-3 gap-1" data-testid={`hyg-perio-hud-active-${card.tooth}`}>
            {card.active.map((s) => (
              <div key={s.surface} className="flex flex-col items-center">
                <span className="text-[11px] font-semibold text-muted-foreground">{s.surface}</span>
                <span
                  data-site={s.surface}
                  data-ringed={card.ringed === s.surface ? "true" : undefined}
                  className={cn(
                    "flex h-14 w-full items-center justify-center rounded-xl font-['Sora',sans-serif] font-extrabold tabular-nums",
                    now ? "text-4xl" : "text-3xl",
                    card.ringed === s.surface ? "ring-4 ring-[#0E7C7B]" : "",
                  )}
                >
                  <Depth value={s.depth} />
                </span>
              </div>
            ))}
          </div>
          <div
            className="mt-1 grid w-full grid-cols-3 gap-1 text-center text-xs text-muted-foreground tabular-nums"
            data-testid={`hyg-perio-hud-other-${card.tooth}`}
          >
            {card.other.map((s) => (
              <span key={s.surface} data-site={s.surface}>
                {s.surface} <Depth value={s.depth} />
              </span>
            ))}
          </div>
        </>
      )}

      {card.flags.length > 0 ? (
        <div
          className="mt-2 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:text-red-300"
          data-testid={`hyg-perio-hud-flags-${card.tooth}`}
        >
          {card.flags.map((f) => PERIO_FLAG_LABELS[f].toLowerCase()).join(" · ")}
        </div>
      ) : null}
    </li>
  );
}

function Ribbon({ heard }: { heard: HudHeard | null }) {
  if (heard === null) {
    return (
      <div className="rounded-2xl border border-border bg-muted px-5 py-4 text-xl text-muted-foreground" data-testid="hyg-perio-hud-ribbon" data-kind="listening">
        Listening… say the first depth.
      </div>
    );
  }
  if (heard.kind === "accepted") {
    return (
      <div
        className="flex items-start gap-3 rounded-2xl border border-emerald-600/40 bg-emerald-500/10 px-5 py-4"
        data-testid="hyg-perio-hud-ribbon"
        data-kind="accepted"
      >
        <CheckCircle2 size={32} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0">
          <div className="font-['Sora',sans-serif] text-2xl font-bold">{heard.heard}</div>
          <div className="text-lg text-muted-foreground">{heard.happened}</div>
        </div>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border border-amber-500/60 bg-amber-500/10 px-5 py-4 text-amber-900 dark:text-amber-200"
      data-testid="hyg-perio-hud-ribbon"
      data-kind={heard.kind}
      data-reason={heard.kind === "rejected" ? heard.reason : undefined}
    >
      <AlertTriangle size={32} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-['Sora',sans-serif] text-2xl font-bold">
          Heard “{heard.heard}” — nothing charted
        </div>
        <div className="text-lg">{heard.message}</div>
      </div>
    </div>
  );
}

export function PerioVoiceHud({ entry, heard, endsAt, onDisarm }: PerioVoiceHudProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pass = hudPass(entry.cursor);
  const progress = hudPassProgress(entry.chart, pass);
  const cards = hudWindow(entry.cursor.tooth).map((t) => hudCard(entry.chart, t, entry.cursor));

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Voice perio"
      data-testid="hyg-perio-hud"
      data-pass={pass.side}
      className="fixed inset-0 z-40 overflow-y-auto bg-background/95 backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 sm:px-8">
        <header className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <span
            className="flex items-center gap-2 rounded-full bg-[#C2362B] px-4 py-1.5 text-lg font-black tracking-widest text-white"
          >
            <span className="h-3 w-3 animate-pulse rounded-full bg-current" /> ARMED
          </span>
          <h2 className="font-['Sora',sans-serif] text-3xl font-extrabold">Voice perio</h2>
          <span className="text-xl text-muted-foreground" data-testid="hyg-perio-hud-pass">
            {pass.label} · {progress.charted} of {progress.total} charted
            {progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ""}
          </span>
          <span className="ml-auto font-['Sora',sans-serif] text-2xl font-bold tabular-nums" data-testid="hyg-perio-hud-remaining" title="Voice disarms itself when this runs out">
            {hudRemaining(endsAt, now)}
          </span>
          <button
            type="button"
            onClick={onDisarm}
            data-testid="hyg-perio-hud-disarm"
            className="flex min-h-12 items-center gap-2 rounded-xl bg-[#C2362B] px-5 text-lg font-semibold text-white hover:bg-[#A42D24]"
          >
            <Square size={16} /> Disarm
          </button>
        </header>

        <Ribbon heard={heard} />

        <ol className="grid grid-cols-5 gap-3 py-2" data-testid="hyg-perio-hud-strip">
          {cards.map((card) => (
            <ToothCard key={card.tooth} card={card} />
          ))}
        </ol>

        <section className="rounded-2xl border border-border bg-muted/60 px-5 py-3" data-testid="hyg-perio-hud-cues">
          <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Say it like this</div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {HUD_CUES.map((cue) => (
              <span key={cue} className="rounded-lg border border-border bg-background px-2.5 py-1 text-base font-medium">
                “{cue}”
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
