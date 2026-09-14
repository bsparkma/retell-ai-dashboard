/**
 * Where a perio send stands (H4 slice 11).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE HONEST SENTENCES THIS PANEL MUST NEVER BLUR
 * ═════════════════════════════════════════════════════════════════════════════
 *   Written   — every row was READ BACK from Open Dental. Not "sent": read back.
 *   Stopped   — a row was refused or could not be confirmed, in Open Dental's own
 *               words, beside that row. Nothing more is written until Resume.
 *   Paused    — Open Dental did not answer, or the page was left. Nothing is lost,
 *               and nothing is re-sent before a read.
 *
 * "Safe to leave" is printed because it is TRUE of this design: every row's
 * state is on the server before its write goes out, leaving only stops the page
 * from asking for the next step, and a resumed step reads Open Dental before it
 * posts a single row. If that stops being true, this sentence must go.
 */
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";

import { type HygPerioSendResponse, type PerioSendRow } from "@shared/hyg/perio";
import { cn } from "@/lib/utils";

/** "about 2 minutes" — an estimate at one request a second, and worded as one. */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "a moment";
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

function rowName(row: PerioSendRow): string {
  return row.target === "exam" ? "Exam header" : `#${row.tooth} ${row.sequenceType}`;
}

export function PerioSendPanel({
  send,
  running,
  error,
  onResume,
}: {
  send: HygPerioSendResponse;
  running: boolean;
  error: string | null;
  onResume: () => void;
}) {
  const p = send.progress;
  if (!p) return null;
  const pct = p.rowsTotal === 0 ? 0 : Math.round((p.rowsConfirmed / p.rowsTotal) * 100);
  const failed = send.rows.filter((r) => r.state === "failed");

  const status = p.done
    ? `Written to Open Dental: exam ${p.examNum ?? ""}, every row read back`
    : p.halted
      ? "Stopped. Nothing more is being written."
      : running
        ? "Writing to Open Dental, one row at a time…"
        : "Paused. Nothing is being written right now.";

  return (
    <section
      className={cn(
        "rounded-xl border p-3",
        p.done
          ? "border-emerald-500/40 bg-emerald-500/5"
          : p.halted
            ? "border-destructive/40 bg-destructive/5"
            : "border-primary/40 bg-primary/5",
      )}
      data-testid="hyg-perio-send"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground" data-testid="hyg-perio-send-status">
          {p.done ? (
            <CheckCircle2 size={16} className="text-emerald-600" />
          ) : p.halted ? (
            <AlertTriangle size={16} className="text-destructive" />
          ) : running ? (
            <Loader2 size={16} className="animate-spin" />
          ) : null}
          {status}
        </p>
        <p className="text-xs tabular-nums text-muted-foreground" data-testid="hyg-perio-send-counts">
          {p.rowsConfirmed} of {p.rowsTotal} rows read back · {p.sitesConfirmed} of {p.sitesTotal} sites
        </p>
      </div>

      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={p.rowsTotal}
        aria-valuenow={p.rowsConfirmed}
      >
        <div
          className={cn("h-full", p.halted ? "bg-destructive" : p.done ? "bg-emerald-600" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>

      {!p.done ? (
        <>
          {/* No estimate on a stopped send: nothing is being written, so "left" would be a guess. */}
          {!p.halted ? (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="hyg-perio-send-remaining">
              About {formatRemaining(p.secondsRemaining)} left, at Open Dental&apos;s one request a second.
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground" data-testid="hyg-perio-safe-to-leave">
            <span className="font-medium text-foreground">Safe to leave.</span> Every row is recorded as
            it lands. Leaving pauses the send; pressing Resume on this chart picks it up, and CareIN
            reads Open Dental before it sends any row again.
          </p>
        </>
      ) : null}

      {send.paused && !p.halted ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="hyg-perio-send-paused">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {send.paused}
        </p>
      ) : null}

      {p.halted && p.haltMessage ? (
        <p className="mt-2 text-sm text-destructive" data-testid="hyg-perio-halt">
          {p.haltMessage}
        </p>
      ) : null}

      {failed.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs" data-testid="hyg-perio-failed-rows">
          {failed.map((row) => (
            <li key={row.seq} className="rounded-md border border-destructive/30 px-2 py-1 text-muted-foreground">
              {/* The server's message already names the row; only a bare one gets a label. */}
              {row.errorMessage && row.errorMessage.startsWith(rowName(row).replace("Exam header", "The exam header")) ? (
                row.errorMessage
              ) : (
                <>
                  <span className="font-semibold text-foreground">{rowName(row)}</span> — {row.errorMessage}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-destructive" data-testid="hyg-perio-send-error">
          {error}
        </p>
      ) : null}

      {!p.done && !running ? (
        <button
          type="button"
          onClick={onResume}
          data-testid="hyg-perio-resume"
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          <RotateCcw size={14} /> Resume
        </button>
      ) : null}
    </section>
  );
}
