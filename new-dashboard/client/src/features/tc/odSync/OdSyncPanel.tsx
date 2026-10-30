/**
 * The Pipeline's Open Dental sync strip (CO-4b), one per office in scope.
 *
 * "Sync now" (rate-limited on the server, once per 5 minutes per office), the
 * last run's time and what it did ("3 completed, 1 moved, 2 flagged"), the
 * Scheduled cases it cannot follow because nobody linked an appointment, the
 * automatic changes that still stand — each with "Moved by Open Dental sync" and
 * Undo — and the flags. Everything shown is what the server answered; a run in
 * flight is polled until it finishes.
 *
 * An office with the sync off and nothing standing renders nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, RotateCcw, Unlink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { tcErrorMessage } from "@/features/tc/api";
import type { OfficeId } from "@shared/tc/contract";
import {
  getOdSyncStatus,
  odSyncActionText,
  odSyncFlagText,
  odSyncSummaryText,
  odSyncWhen,
  startOdSync,
  undoOdSync,
  type OdSyncStatus,
} from "./odSyncApi";

const OFFICE_LABELS: Record<OfficeId, string> = { roland: "Roland", valley: "Riley" };
const POLL_MS = 3000;

export function OdSyncPanel({
  office,
  showOfficeName = false,
  onCasesChanged,
}: {
  office: OfficeId;
  showOfficeName?: boolean;
  /** The board must re-read its cases: a run moved some, or an Undo moved one back. */
  onCasesChanged: () => void;
}) {
  const [status, setStatus] = useState<OdSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await getOdSyncStatus(office);
      setStatus(next);
      setError(null);
      // A run just finished: what it moved is on the board now.
      if (wasRunning.current && !next.running) onCasesChanged();
      wasRunning.current = next.running;
    } catch (e) {
      setError(tcErrorMessage(e));
    }
  }, [office, onCasesChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!status?.running) return;
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [status, load]);

  const syncNow = async () => {
    setStarting(true);
    try {
      await startOdSync(office);
      wasRunning.current = true;
      toast.success("Syncing with Open Dental…");
      await load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await load();
    } finally {
      setStarting(false);
    }
  };

  const undo = async (caseId: string) => {
    setUndoing(caseId);
    try {
      await undoOdSync(office, caseId);
      toast.success("Undone");
      onCasesChanged();
      await load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setUndoing(null);
    }
  };

  if (error && !status) {
    return (
      <p className="mb-3 flex items-center gap-2 text-sm text-red-700 dark:text-red-300" data-testid={`od-sync-error-${office}`}>
        <AlertTriangle className="w-4 h-4" /> Open Dental sync: {error}
      </p>
    );
  }
  if (!status) return null;
  if (!status.enabled && status.changes.length === 0) return null;

  const last = status.lastRun;
  const coolingDown = status.nextAllowedAt !== null;
  const busy = status.running || starting;

  return (
    <section
      className="mb-4 rounded-xl border border-border bg-card p-3 text-sm space-y-2"
      data-testid={`od-sync-panel-${office}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            Open Dental sync{showOfficeName ? ` · ${OFFICE_LABELS[office]}` : ""}
          </p>
          <p className="text-xs text-muted-foreground" data-testid={`od-sync-last-run-${office}`}>
            {status.running ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Syncing with Open Dental…
              </span>
            ) : !last ? (
              "Not run yet"
            ) : last.status === "ok" && last.summary ? (
              `Last run ${odSyncWhen(last.finishedAt ?? last.startedAt)} (${last.trigger}): ${odSyncSummaryText(last.summary)}`
            ) : last.status === "failed" ? (
              <span className="text-red-700 dark:text-red-300">
                Last run {odSyncWhen(last.startedAt)} couldn&apos;t reach Open Dental — nothing was changed.
              </span>
            ) : (
              `Last run ${odSyncWhen(last.startedAt)} did not finish — nothing after it was applied.`
            )}
          </p>
        </div>
        {status.enabled ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy || coolingDown}
            onClick={() => void syncNow()}
            title={coolingDown ? `Sync now is available again at ${odSyncWhen(status.nextAllowedAt)}` : undefined}
            data-testid={`od-sync-now-${office}`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {coolingDown && !busy ? `Sync now (after ${odSyncWhen(status.nextAllowedAt)})` : "Sync now"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Sync is off for this office</span>
        )}
      </div>

      {status.enabled && status.unanchoredCount > 0 && (
        <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300" data-testid={`od-sync-unanchored-${office}`}>
          <Unlink className="w-3.5 h-3.5 shrink-0" />
          {status.unanchoredCount} scheduled {status.unanchoredCount === 1 ? "case" : "cases"} can&apos;t be tracked (no appointment linked)
        </p>
      )}

      {status.changes.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid={`od-sync-changes-${office}`}>
          {status.changes.map((c) => (
            <li key={c.caseId} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
              <span className="min-w-0">
                <span className="font-medium text-foreground">{c.patientName}</span>{" "}
                <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                  Moved by Open Dental sync · {odSyncWhen(c.action.at)}
                </span>
                <span className="block text-xs text-muted-foreground">{odSyncActionText(c.action)}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5"
                disabled={undoing !== null}
                onClick={() => void undo(c.caseId)}
                data-testid="od-sync-undo"
              >
                {undoing === c.caseId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                Undo
              </Button>
            </li>
          ))}
        </ul>
      )}

      {status.flagged.length > 0 && (
        <ul className="space-y-1" data-testid={`od-sync-flagged-${office}`}>
          {status.flagged.map((f) => (
            <li key={f.caseId} className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 w-3.5 h-3.5 shrink-0" />
              <span>
                <span className="font-medium">{f.patientName}</span> — {odSyncFlagText(f.flag)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The card's line: the badge with its Undo, or the flag. Renders nothing when
 * the sync has nothing standing on the case.
 */
export function OdSyncCardLine({
  office,
  caseId,
  state,
  onUndone,
}: {
  office: OfficeId;
  caseId: string;
  state: { action: { kind: string; at: string } | null; flag: { reason: string } | null } | null | undefined;
  onUndone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  if (state.action) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5" data-testid="od-sync-card-badge">
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
          Moved by Open Dental sync · {odSyncWhen(state.action.at)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          disabled={busy}
          // The card opens on click and drags on pointer-down; Undo owns both.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={async (e) => {
            e.stopPropagation();
            setBusy(true);
            try {
              await undoOdSync(office, caseId);
              toast.success("Undone");
              onUndone?.();
            } catch (err) {
              toast.error(tcErrorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
          data-testid="od-sync-card-undo"
        >
          Undo
        </Button>
      </div>
    );
  }
  if (state.flag) {
    return (
      <div
        className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-amber-800 dark:text-amber-300"
        data-testid="od-sync-card-flag"
      >
        <AlertTriangle className="w-3 h-3 shrink-0" /> Open Dental no longer matches — check
      </div>
    );
  }
  return null;
}
