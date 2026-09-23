/**
 * The posting panel on a batch preview: pick a target, press Post, watch it,
 * and undo it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE THREE THINGS THIS COMPONENT REFUSES TO LIE ABOUT
 * ═════════════════════════════════════════════════════════════════════════════
 *  1. `post_failed` ALWAYS SHOWS rowsWritten. A run that died at row 300 of 500
 *     put 299 fees into a real practice's database. A screen that says only
 *     "failed" is how somebody concludes nothing happened and posts again.
 *  2. ROLLING BACK A NEW SCHEDULE CANNOT DELETE IT. Open Dental has no DELETE
 *     for /feescheds, so the rollback empties the schedule and hides it. The
 *     confirm dialog says so BEFORE the click, and the result repeats it after.
 *  3. THE DISABLED POST BUTTON SAYS WHY. `postBlockedReason` returns the
 *     sentence, and the server refuses with the same facts — this is the
 *     courtesy, not the guard.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CONFIRM DIALOG IS THE REVIEW IN REVIEW-THEN-SEND
 * ═════════════════════════════════════════════════════════════════════════════
 * It states the OFFICE, the TARGET SCHEDULE, the ROW COUNT and the TOTAL,
 * because those are the four facts somebody would want back if the post went to
 * the wrong place. Roland and Riley hold different contracts with the same
 * payers, so naming the office is not decoration.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, RotateCcw, Send, XCircle } from "lucide-react";

import {
  listFeeSchedules,
  getProgress,
  setTarget,
  postImport,
  rollbackImport,
  isInFlight,
  postBlockedReason,
  formatFeeCents,
  FeesApiError,
  FEES_OFFICE_LABELS,
  type FeeSchedule,
  type FeesOfficeId,
  type FeesPostProgress,
  type FeesRollbackResult,
} from "@/features/fees/api";
import { cn } from "@/lib/utils";

/**
 * How often the UI asks while a post runs.
 *
 * A fee costs two Open Dental requests against a credential paced at ~1.2s, so
 * progress moves roughly every 2.5 seconds. Polling faster would ask the same
 * question several times per answer; polling slower would make a 6-fee import
 * look frozen. 2s is just inside the rate at which the number actually changes.
 */
const POLL_MS = 2000;

interface Props {
  office: FeesOfficeId;
  batchId: string;
  /** Whether this user holds fees.write. UX only — the server is the gate. */
  canWrite: boolean;
  /** Told when a post or rollback finishes, so the rows can be re-read. */
  onSettled?: () => void;
}

type Confirm =
  | { kind: "none" }
  | { kind: "post"; progress: FeesPostProgress }
  | { kind: "rollback"; progress: FeesPostProgress };

export function PostingPanel({ office, batchId, canWrite, onSettled }: Props) {
  const [progress, setProgress] = useState<FeesPostProgress | null>(null);
  const [schedules, setSchedules] = useState<FeeSchedule[] | null>(null);
  const [scheduleError, setScheduleError] = useState<FeesApiError | null>(null);
  const [error, setError] = useState<FeesApiError | null>(null);
  const [confirm, setConfirm] = useState<Confirm>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [rollback, setRollback] = useState<FeesRollbackResult | null>(null);
  const [newName, setNewName] = useState("");
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await getProgress(office, batchId, signal);
        setProgress(res.progress);
        return res.progress;
      } catch (err: unknown) {
        if (err instanceof FeesApiError && err.code === "NETWORK") return null;
        setError(err instanceof FeesApiError ? err : null);
        return null;
      }
    },
    [office, batchId],
  );

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);

  // POLL ONLY WHILE IN FLIGHT. A screen that kept polling a `posted` batch
  // would hammer the endpoint forever for an answer that cannot change.
  useEffect(() => {
    if (progress === null || !isInFlight(progress.status)) return;
    const timer = setInterval(() => {
      void refresh().then((next) => {
        if (next && !isInFlight(next.status)) settled.current?.();
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [progress, refresh]);

  // The target picker's options. Fetched once, and only when a target could
  // still be chosen — a posted batch's schedule is already recorded on it.
  const needsTarget =
    progress !== null && (progress.status === "parsed" || progress.status === "ready");
  useEffect(() => {
    if (!needsTarget || schedules !== null) return;
    const abort = new AbortController();
    listFeeSchedules(office, abort.signal)
      .then((res) => setSchedules(res.schedules))
      .catch((err: unknown) => {
        // A missing Open Dental key or an office switched off is a SETTING, not
        // an outage — surfaced as itself so nobody retries into a wall.
        if (err instanceof FeesApiError) setScheduleError(err);
        setSchedules([]);
      });
    return () => abort.abort();
  }, [needsTarget, schedules, office]);

  const choose = async (choice: { feeSchedNum: number } | { newScheduleName: string }) => {
    setBusy(true);
    setError(null);
    try {
      await setTarget(office, batchId, choice);
      await refresh();
    } catch (err: unknown) {
      if (err instanceof FeesApiError) setError(err);
    } finally {
      setBusy(false);
    }
  };

  const doPost = async () => {
    setBusy(true);
    setError(null);
    setConfirm({ kind: "none" });
    try {
      await postImport(office, batchId);
      await refresh();
    } catch (err: unknown) {
      if (err instanceof FeesApiError) setError(err);
    } finally {
      setBusy(false);
    }
  };

  const doRollback = async () => {
    setBusy(true);
    setError(null);
    setConfirm({ kind: "none" });
    try {
      const result = await rollbackImport(office, batchId);
      setRollback(result);
      await refresh();
      settled.current?.();
    } catch (err: unknown) {
      if (err instanceof FeesApiError) setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (progress === null) {
    return (
      <div
        className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="fees-posting-loading"
      >
        <Loader2 size={16} className="animate-spin" aria-hidden />
        Loading posting status…
      </div>
    );
  }

  // A file that never parsed has nothing to post. Saying so beats rendering an
  // empty panel whose controls are all disabled for reasons nobody stated.
  if (progress.status === "failed") return null;

  const blocked = postBlockedReason(progress, canWrite);

  return (
    <section className="mt-4 rounded-lg border border-border bg-card p-4" data-testid="fees-posting-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Post to Open Dental</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {FEES_OFFICE_LABELS[progress.office] ?? progress.office} ·{" "}
            {progress.writableCount} {progress.writableCount === 1 ? "fee" : "fees"} to write
            {progress.excludedCount > 0 && `, ${progress.excludedCount} excluded`} ·{" "}
            {formatFeeCents(progress.totalCents)} total
          </p>
        </div>
        <StatusChip status={progress.status} />
      </div>

      {/* ── Target ─────────────────────────────────────────────────────────── */}
      {needsTarget && (
        <div className="mt-4" data-testid="fees-target-picker">
          <div className="text-sm font-medium text-foreground">Which fee schedule?</div>
          {scheduleError !== null && (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="fees-schedules-error">
              {scheduleError.message}
              {scheduleError.code !== null && (
                <span className="ml-2 font-mono text-xs">{scheduleError.code}</span>
              )}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {(schedules ?? []).map((s) => (
              <button
                key={s.feeSchedNum}
                type="button"
                disabled={busy || !canWrite}
                onClick={() => void choose({ feeSchedNum: s.feeSchedNum })}
                data-testid={`fees-target-${s.feeSchedNum}`}
                aria-pressed={progress.target?.feeSchedNum === s.feeSchedNum}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
                  progress.target?.feeSchedNum === s.feeSchedNum
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-foreground hover:bg-accent",
                )}
              >
                {s.description}
                {s.isHidden && <span className="ml-1 text-xs opacity-70">(hidden)</span>}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="…or name a new schedule"
              data-testid="fees-new-schedule-name"
              className="min-h-[36px] flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground"
            />
            <button
              type="button"
              disabled={busy || !canWrite || newName.trim() === ""}
              onClick={() => void choose({ newScheduleName: newName.trim() })}
              data-testid="fees-use-new-schedule"
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              Use a new schedule
            </button>
          </div>
          {progress.target?.isNew && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="fees-target-is-new">
              A new schedule called “{progress.target.description}” will be created when you post.
              It is attached to no insurance plan, so it reprices nothing until somebody attaches it.
            </p>
          )}
        </div>
      )}

      {progress.target !== null && !needsTarget && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="fees-target-fixed">
          Target: <span className="font-medium text-foreground">{progress.target.description}</span>
          {progress.target.feeSchedNum !== null && (
            <span className="ml-1 font-mono text-xs">#{progress.target.feeSchedNum}</span>
          )}
        </p>
      )}

      {/* ── In flight ──────────────────────────────────────────────────────── */}
      {progress.status === "posting" && (
        <div className="mt-4" data-testid="fees-post-progress">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Writing fee {Math.min(progress.rowsWritten + 1, progress.writableCount)} of{" "}
            {progress.writableCount}…
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground transition-all"
              style={{
                width: `${progress.writableCount === 0 ? 0 : Math.round((progress.rowsWritten / progress.writableCount) * 100)}%`,
              }}
            />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Open Dental allows about one request a second and this office shares that limit with
            the rest of CareIN, so this takes a few minutes. You can leave the page.
          </p>
        </div>
      )}

      {/* ── post_failed: the honest number ─────────────────────────────────── */}
      {progress.status === "post_failed" && (
        <div
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-testid="fees-post-failed"
        >
          <div className="flex items-start gap-2">
            <XCircle size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
            <div>
              <div className="text-sm font-medium text-foreground">
                The post stopped partway through.
              </div>
              {/* THE NUMBER. Never omitted, never rounded away. */}
              <p className="mt-1 text-sm text-foreground" data-testid="fees-rows-written">
                <strong>
                  {progress.rowsWritten} of {progress.writableCount}
                </strong>{" "}
                {progress.rowsWritten === 1 ? "fee was" : "fees were"} already written to Open
                Dental{progress.target?.description ? ` in ${progress.target.description}` : ""}.
                {progress.rowsWritten > 0 &&
                  " Posting again continues from where it stopped; rolling back removes what was written."}
              </p>
              {progress.postError !== null && (
                <p className="mt-2 text-sm text-muted-foreground" data-testid="fees-post-error">
                  {progress.postError}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── posted ─────────────────────────────────────────────────────────── */}
      {progress.status === "posted" && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3" data-testid="fees-posted">
          <div className="flex items-start gap-2">
            <Check size={18} className="mt-0.5 shrink-0 text-foreground" aria-hidden />
            <div className="text-sm text-foreground">
              <strong>{progress.rowsWritten}</strong>{" "}
              {progress.rowsWritten === 1 ? "fee" : "fees"} written to{" "}
              {progress.target?.description ?? "Open Dental"}
              {progress.postedBy ? ` by ${progress.postedBy}` : ""}.
            </div>
          </div>
        </div>
      )}

      {progress.status === "rolled_back" && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3" data-testid="fees-rolled-back">
          <div className="text-sm text-foreground">
            Rolled back{progress.rolledBackBy ? ` by ${progress.rolledBackBy}` : ""}.
          </div>
          {progress.backup?.restoreNote && (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="fees-restore-note">
              {progress.backup.restoreNote}
            </p>
          )}
        </div>
      )}

      {rollback !== null && (
        <div className="mt-3 rounded-md border border-border bg-card p-3" data-testid="fees-rollback-result">
          <p className="text-sm text-foreground">{rollback.note}</p>
          {rollback.problems.length > 0 && (
            <ul className="mt-2 space-y-1">
              {rollback.problems.map((p, i) => (
                <li key={i} className="text-sm text-muted-foreground">
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error !== null && (
        <div
          className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          data-testid="fees-posting-error"
        >
          <div className="text-sm font-medium text-foreground">{error.message}</div>
          {error.code !== null && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">{error.code}</div>
          )}
        </div>
      )}

      {/* ── Actions ────────────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {progress.status !== "posted" && progress.status !== "rolled_back" && (
          <button
            type="button"
            disabled={blocked !== null || busy}
            onClick={() => setConfirm({ kind: "post", progress })}
            data-testid="fees-post-button"
            className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send size={16} aria-hidden />
            {progress.status === "post_failed" ? "Continue posting" : "Post to Open Dental"}
          </button>
        )}

        {(progress.status === "posted" || progress.status === "post_failed") && (
          <button
            type="button"
            disabled={!canWrite || busy}
            onClick={() => setConfirm({ kind: "rollback", progress })}
            data-testid="fees-rollback-button"
            className="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <RotateCcw size={16} aria-hidden />
            Roll back
          </button>
        )}

        {/* THE DISABLED BUTTON SAYS WHY. */}
        {blocked !== null && progress.status !== "posted" && progress.status !== "rolled_back" && (
          <span className="text-sm text-muted-foreground" data-testid="fees-post-blocked-reason">
            {blocked}
          </span>
        )}
      </div>

      {/* ── Confirms ───────────────────────────────────────────────────────── */}
      {confirm.kind === "post" && (
        <ConfirmBox
          testId="fees-post-confirm"
          title="Post these fees to Open Dental?"
          confirmLabel="Post them"
          onCancel={() => setConfirm({ kind: "none" })}
          onConfirm={() => void doPost()}
        >
          <ul className="space-y-1 text-sm text-foreground">
            <li>
              Office: <strong>{FEES_OFFICE_LABELS[progress.office] ?? progress.office}</strong>
            </li>
            <li>
              Fee schedule:{" "}
              <strong>{confirm.progress.target?.description ?? "—"}</strong>
              {confirm.progress.target?.isNew && " (will be created)"}
            </li>
            <li>
              Fees to write: <strong>{confirm.progress.writableCount}</strong>
              {confirm.progress.excludedCount > 0 &&
                `, ${confirm.progress.excludedCount} excluded`}
            </li>
            <li>
              Total: <strong>{formatFeeCents(confirm.progress.totalCents)}</strong>
            </li>
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            This writes to {FEES_OFFICE_LABELS[progress.office] ?? progress.office}&apos;s live Open
            Dental database. What the schedule holds now is saved first, so this can be rolled back.
          </p>
        </ConfirmBox>
      )}

      {confirm.kind === "rollback" && (
        <ConfirmBox
          testId="fees-rollback-confirm"
          title="Roll this post back?"
          confirmLabel="Roll it back"
          onCancel={() => setConfirm({ kind: "none" })}
          onConfirm={() => void doRollback()}
        >
          <p className="text-sm text-foreground">
            This deletes the <strong>{confirm.progress.rowsWritten}</strong>{" "}
            {confirm.progress.rowsWritten === 1 ? "fee" : "fees"} this import wrote
            {confirm.progress.backup?.isNewSchedule
              ? " and hides the schedule it created."
              : ` and puts back the ${confirm.progress.backup?.rowCount ?? 0} ${
                  confirm.progress.backup?.rowCount === 1 ? "fee" : "fees"
                } that were there before.`}
          </p>
          {/* THE THING WE CANNOT DO, said BEFORE the click. */}
          {confirm.progress.backup?.isNewSchedule && (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="fees-rollback-new-caveat">
              Open Dental cannot delete a fee schedule, so the empty schedule will remain in the
              list. It will be hidden and hold no fees.
            </p>
          )}
        </ConfirmBox>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: FeesPostProgress["status"] }) {
  const tone =
    status === "posted"
      ? "border-border bg-muted text-foreground"
      : status === "post_failed"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : status === "posting"
          ? "border-border bg-card text-foreground"
          : "border-border bg-card text-muted-foreground";
  const label =
    status === "post_failed"
      ? "Post failed"
      : status === "rolled_back"
        ? "Rolled back"
        : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", tone)}
      data-testid="fees-status-chip"
      data-status={status}
    >
      {label}
    </span>
  );
}

function ConfirmBox({
  testId,
  title,
  confirmLabel,
  children,
  onCancel,
  onConfirm,
}: {
  testId: string;
  title: string;
  confirmLabel: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="mt-4 rounded-lg border border-foreground/30 bg-muted/40 p-4"
      role="dialog"
      aria-label={title}
      data-testid={testId}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="mt-2">{children}</div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              data-testid={`${testId}-yes`}
              className="min-h-[36px] rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              data-testid={`${testId}-cancel`}
              className="min-h-[36px] rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
