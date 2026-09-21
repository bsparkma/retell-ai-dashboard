/**
 * Where a perio send stands (item 12), and the undo.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FIVE SENTENCES THIS PANEL MUST NEVER BLUR
 * ═════════════════════════════════════════════════════════════════════════════
 *   Written     every site was READ BACK from Open Dental and matched. Not "sent".
 *   Incomplete  the exam IS in Open Dental and does NOT match. Loud: an incomplete
 *               perio chart understates disease. The sites are named, and the
 *               undo is offered.
 *   Refused     Open Dental said no to the exam. Nothing was created; nothing to undo.
 *   Deleted     the exam this send created was removed, with every reading in it.
 *   Paused      Open Dental did not answer, or the page was left. Nothing is lost,
 *               and nothing is re-sent before a read.
 *
 * The delete is its own dialog with its own tick-box, because it is the one action
 * on this page that removes something from a patient's chart.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Trash2 } from "lucide-react";

import {
  perioChangeLine,
  perioMismatchLine,
  type HygPerioSendResponse,
  type PerioSendView,
} from "@shared/hyg/perioSend";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatRemaining } from "./PerioSendConfirm";

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** The teeth a stopped send could not match — marked on the grid beside the error. */
export function perioMismatchTeeth(send: PerioSendView | null): number[] {
  if (!send || send.state !== "incomplete") return [];
  return Array.from(new Set(send.mismatches.map((m) => m.tooth))).sort((a, b) => a - b);
}

export function PerioDeleteExamDialog({
  open,
  send,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  send: PerioSendView;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (examNum: number) => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const examNum = send.examNum;
  if (examNum === null) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setUnderstood(false);
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="hyg-perio-delete-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-4 w-4" />
            Delete exam {examNum} from Open Dental?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-foreground">
              <p>
                This removes perio exam <strong>{examNum}</strong>, dated {send.examDate}, and{" "}
                <strong>every reading in it</strong> from Open Dental. It was created by this send on{" "}
                {when(send.startedAt)}, and nothing else has been written to it from CareIN.
              </p>
              <p className="text-muted-foreground">
                The chart stays on this visit and goes back on the Ready to send list, unchanged, so it
                can be sent again. It cannot be undone in Open Dental.
              </p>
              <label className="flex min-h-11 items-center gap-2 rounded-lg border border-destructive/40 px-2">
                <input
                  type="checkbox"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                  data-testid="hyg-perio-delete-understood"
                  className="h-5 w-5"
                />
                I understand exam {examNum} and all its readings will be removed from Open Dental.
              </label>
              {error ? (
                <p className="text-sm text-destructive" data-testid="hyg-perio-delete-error">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button type="button" onClick={onCancel} disabled={busy} className={cn(TAP, "border-transparent text-muted-foreground")}>
            Keep the exam
          </button>
          <button
            type="button"
            onClick={() => onConfirm(examNum)}
            disabled={!understood || busy}
            data-testid="hyg-perio-delete-confirm"
            className={cn(
              TAP,
              understood && !busy
                ? "border-destructive bg-destructive text-destructive-foreground"
                : "cursor-not-allowed border-border text-muted-foreground",
            )}
          >
            {busy ? <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" /> : null}
            Delete exam {examNum}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PerioSendPanel({
  response,
  running,
  error,
  canRestage,
  onContinue,
  onDelete,
  onRestage,
  onRemoveReplaced = null,
}: {
  response: HygPerioSendResponse;
  running: boolean;
  error: string | null;
  /** The chart is Failed and its last send left nothing in Open Dental to deal with first. */
  canRestage: boolean;
  onContinue: () => void;
  onDelete: () => void;
  onRestage: () => void;
  /** Item 13: finish a swap whose DELETE did not land. Null when there is nothing to finish. */
  onRemoveReplaced?: (() => void) | null;
}) {
  const s = response.send;
  if (!s) return null;
  // Item 13: the exam in Open Dental now, and whether the one it replaced went.
  const live = response.live;
  const replacedStillThere =
    live !== null && live.supersedesExamNum !== null && live.supersedesDeletedAt === null;
  const inFlight = s.state === "posting" || s.state === "filling";
  const strings = s.arches.filter((a) => a.path === "string").length;

  const tone =
    s.state === "written"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : s.state === "incomplete"
        ? "border-destructive bg-destructive/10"
        : s.state === "refused"
          ? "border-amber-500/40 bg-amber-500/5"
          : s.state === "deleted"
            ? "border-border bg-muted/30"
            : "border-primary/40 bg-primary/5";

  const status =
    s.state === "written"
      ? s.supersedesExamNum !== null
        ? `Corrected in Open Dental: exam ${s.examNum} replaces exam ${s.supersedesExamNum}, every site read back`
        : `Written to Open Dental: exam ${s.examNum}, every site read back and matching`
      : s.state === "incomplete"
        ? s.examNum !== null
          ? `Exam ${s.examNum} is in Open Dental and INCOMPLETE`
          : "This send stopped, and Open Dental needs checking"
        : s.state === "refused"
          ? "Open Dental refused the exam. Nothing was created."
          : s.state === "deleted"
            ? `Exam ${s.examNum} was deleted from Open Dental`
            : running
              ? s.state === "posting"
                ? "Writing the exam to Open Dental…"
                : "Writing and reading back from Open Dental…"
              : // Item 15: the same send can be running from the visit page, so this
                // says only what THIS page knows.
                "Paused here. Nothing is being written from this page right now.";

  return (
    <section className={cn("rounded-xl border p-3", tone)} data-testid="hyg-perio-send">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className={cn(
            "flex items-center gap-1.5 text-sm font-semibold",
            s.state === "incomplete" ? "text-destructive" : "text-foreground",
          )}
          data-testid="hyg-perio-send-status"
        >
          {s.state === "written" ? (
            <CheckCircle2 size={16} className="text-emerald-600" />
          ) : s.state === "incomplete" || s.state === "refused" ? (
            <AlertTriangle size={16} className={s.state === "incomplete" ? "text-destructive" : "text-amber-600"} />
          ) : inFlight && running ? (
            <Loader2 size={16} className="animate-spin" />
          ) : null}
          {status}
        </p>
        <p className="text-xs tabular-nums text-muted-foreground" data-testid="hyg-perio-send-counts">
          {strings} {strings === 1 ? "arch" : "arches"} in the exam request
          {s.rowsPlanned > 0 ? ` · ${s.rowsWritten} of ${s.rowsPlanned} rows written` : ""}
        </p>
      </div>

      {inFlight ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="hyg-perio-send-remaining">
          About {formatRemaining(s.requestsRemaining)} left. Leaving pauses the send; CareIN reads Open Dental
          before it writes anything again.
        </p>
      ) : null}

      {response.paused && inFlight ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="hyg-perio-send-paused">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {response.paused}
        </p>
      ) : null}

      {s.state === "incomplete" ? (
        <div className="mt-2 space-y-2" data-testid="hyg-perio-incomplete">
          <p className="text-sm font-medium text-destructive">
            An incomplete perio chart understates disease. The chart on this page is NOT what Open Dental holds.
          </p>
          {s.mismatches.length > 0 ? (
            <ul className="space-y-0.5 rounded-lg border border-destructive/40 bg-background p-2 text-xs" data-testid="hyg-perio-mismatches">
              {s.mismatches.slice(0, 12).map((m, i) => (
                <li key={i} className="text-foreground">
                  {perioMismatchLine(m)}
                </li>
              ))}
              {s.mismatches.length > 12 ? (
                <li className="text-muted-foreground">and {s.mismatches.length - 12} more</li>
              ) : null}
            </ul>
          ) : (
            <p className="text-xs text-foreground" data-testid="hyg-perio-halt">
              {s.errorMessage}
            </p>
          )}
          {s.canDelete ? (
            <button
              type="button"
              onClick={onDelete}
              data-testid="hyg-perio-delete-open"
              className={cn(TAP, "inline-flex items-center gap-1.5 border-destructive bg-destructive text-destructive-foreground")}
            >
              <Trash2 size={14} /> Delete exam {s.examNum} from Open Dental
            </button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Or correct the exam in Open Dental&apos;s perio chart. CareIN will not write to it again.
          </p>
        </div>
      ) : null}

      {s.state === "refused" ? (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-foreground" data-testid="hyg-perio-refused">
            {s.errorMessage}
          </p>
          {canRestage ? (
            <button
              type="button"
              onClick={onRestage}
              data-testid="hyg-perio-restage"
              className={cn(TAP, "inline-flex items-center gap-1.5 border-border text-foreground")}
            >
              <RotateCcw size={14} /> Put the chart back on the list
            </button>
          ) : null}
        </div>
      ) : null}

      {/*
        ITEM 13: the swap's last step did not land. The CHART is correct — the
        corrected exam verified — and a duplicate is still there. Said out loud,
        with the one action that finishes it.
      */}
      {replacedStillThere && s.state === "written" ? (
        <div className="mt-2 space-y-1.5 rounded-lg border border-amber-500/50 bg-amber-500/5 p-2" data-testid="hyg-perio-replaced-left">
          <p className="text-sm text-amber-900 dark:text-amber-300">
            The exam this correction replaced, <strong>{live?.supersedesExamNum}</strong>, is still in Open
            Dental. The chart above is correct; that one is a duplicate on the same date.
          </p>
          {onRemoveReplaced ? (
            <button
              type="button"
              onClick={onRemoveReplaced}
              data-testid="hyg-perio-remove-replaced"
              className={cn(TAP, "inline-flex items-center gap-1.5 border-amber-600 text-amber-900 dark:text-amber-300")}
            >
              <Trash2 size={14} /> Remove exam {live?.supersedesExamNum}
            </button>
          ) : null}
        </div>
      ) : null}

      {s.state === "written" && s.supersedesExamNum !== null && !replacedStillThere ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="hyg-perio-amended">
          {s.amendDiff.length} {s.amendDiff.length === 1 ? "site" : "sites"} corrected ·{" "}
          {s.amendDiff.slice(0, 3).map(perioChangeLine).join("; ")}
          {s.amendDiff.length > 3 ? ` and ${s.amendDiff.length - 3} more` : ""} · exam{" "}
          {s.supersedesExamNum} deleted
        </p>
      ) : null}

      {s.state === "deleted" ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="hyg-perio-deleted">
          Deleted by {s.deletedBy} on {when(s.deletedAt)}, with every reading in it. The chart is staged again.
        </p>
      ) : null}

      {s.state === "written" ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {s.deepSites > 0 ? `${s.deepSites} ${s.deepSites === 1 ? "site" : "sites"} of 10 mm or more went in row by row. ` : ""}
          Confirmed by {s.startedBy}.
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-destructive" data-testid="hyg-perio-send-error">
          {error}
        </p>
      ) : null}

      {inFlight && !running ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onContinue}
            data-testid="hyg-perio-continue"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            <RotateCcw size={14} /> Continue
          </button>
          {/* An unfinished send that already created its exam can be undone instead of finished. */}
          {s.canDelete ? (
            <button
              type="button"
              onClick={onDelete}
              data-testid="hyg-perio-delete-open"
              className={cn(TAP, "inline-flex items-center gap-1.5 border-destructive text-destructive")}
            >
              <Trash2 size={14} /> Delete exam {s.examNum} instead
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
