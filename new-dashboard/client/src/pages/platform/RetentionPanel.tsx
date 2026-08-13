/**
 * The call store: retention policy, the nightly prune, and the legacy purge.
 *
 * This panel replaces a signed-in browser console and hand-typed fetch calls.
 * Everything it does calls an endpoint that already existed — the prune and the
 * purge are still POST /api/admin/call-store/*, not forked, because a job that
 * destroys records must not have two copies of its safety rules.
 *
 * PLATFORM-WIDE, NOT PER-PRACTICE. The call store is one JSON file for the whole
 * process and has no tenant dimension, which is why this lives on its own
 * top-level tab rather than under a selected practice.
 *
 * THE THREE HONEST STATEMENTS this panel is built around:
 *   1. Extending NEVER restores already-pruned calls. A stub cannot be
 *      un-stubbed, and the number of calls already reduced is shown beside the
 *      choice so the loss is not abstract.
 *   2. Shortening has a COUNT, computed server-side by the pruner's own
 *      selector — not an estimate this page derived.
 *   3. Where the current window comes from. "30 because nobody has chosen" and
 *      "30 because somebody chose it on Tuesday" are different facts.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Clock,
  Database,
  Loader2,
  PlayCircle,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { PruneResult, PurgeResult, RetentionImpact, RetentionState } from "@/lib/api";
import { loadError } from "../Platform";

/** The literal the server requires for a live purge. Mirrors legacyPurge.js. */
const PURGE_CONFIRM_TOKEN = "DELETE";

/**
 * Thousands-separated. Every count on this panel is in the thousands, and these
 * are the numbers somebody reads before agreeing to destroy records — "1137"
 * and "1,137" are not equally easy to size up at a glance.
 */
function n(value: number): string {
  return value.toLocaleString();
}

/**
 * A daily cron expression as a time of day.
 *
 * Only the plain `m h * * *` shape is translated. Anything else — a weekday
 * restriction, a step, a range — is shown VERBATIM rather than described
 * approximately: an operator reading "3:30 AM" when the job actually runs on
 * weekdays only would be worse off than one reading a cron expression.
 */
function scheduleLabel(cron: string): string {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron.trim());
  if (!m) return cron;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return cron;
  const d = new Date(2000, 0, 1, hour, minute);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function sourceBlurb(state: RetentionState): string {
  const { source, envDays, dbDays, updatedBy, updatedAt } = state.policy;
  if (source === "db") {
    const who = updatedBy ?? "a platform administrator";
    const when = updatedAt ? new Date(updatedAt).toLocaleDateString() : "an earlier date";
    return `Set to ${dbDays} days by ${who} on ${when}.`;
  }
  if (source === "env") {
    return `Nobody has chosen a window, so the CALL_RETENTION_DAYS app setting (${envDays}) applies.`;
  }
  return "Nobody has chosen a window and CALL_RETENTION_DAYS is unset, so the 30-day default applies.";
}

/** The dialog that confirms a window change, carrying the count when shortening. */
function WindowConfirmDialog({
  state,
  proposed,
  impact,
  busy,
  onCancel,
  onConfirm,
}: {
  state: RetentionState;
  proposed: number | null;
  impact: RetentionImpact | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const shortening = impact?.shortening === true;
  return (
    <Dialog open={proposed !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="retention-confirm">
        {proposed !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {shortening && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                Keep calls for {proposed} days?
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2">
                  {impact === null ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working out what this
                      would affect…
                    </span>
                  ) : shortening ? (
                    <>
                      <p data-testid="retention-shorten-warning">
                        Shortening from {impact.currentDays} to {proposed} days means{" "}
                        <strong>{n(impact.wouldPrune)}</strong>{" "}
                        {impact.wouldPrune === 1 ? "call that still has" : "calls that still have"}{" "}
                        {impact.wouldPrune === 1 ? "its" : "their"} full record will be reduced to
                        an audit stub at the next nightly run.
                      </p>
                      <p>
                        A stub keeps the call id, the office, and who did what to it. The
                        transcript, summary and caller details are gone and cannot be recovered.
                      </p>
                    </>
                  ) : (
                    <>
                      <p data-testid="retention-extend-warning">
                        Extending to {proposed} days keeps future calls longer. It does{" "}
                        <strong>not</strong> restore the {n(impact.alreadyPruned)} calls already
                        reduced to stubs — a stub cannot be un-stubbed.
                      </p>
                    </>
                  )}
                  <p className="text-xs">Takes effect at the next nightly run, not now.</p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant={shortening ? "destructive" : "default"}
                onClick={onConfirm}
                disabled={busy || impact === null}
                data-testid="retention-confirm-accept"
              >
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Keep for {proposed} days
              </Button>
            </DialogFooter>
          </>
        )}
        {/* `state` is read above via sourceBlurb's caller; referenced here so the
            dialog re-renders when the policy changes underneath it. */}
        <span className="sr-only">{state.policy.days}</span>
      </DialogContent>
    </Dialog>
  );
}

export default function RetentionPanel() {
  const [state, setState] = useState<RetentionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [proposed, setProposed] = useState<number | null>(null);
  const [impact, setImpact] = useState<RetentionImpact | null>(null);
  const [savingWindow, setSavingWindow] = useState(false);

  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<PruneResult | null>(null);

  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeDry, setPurgeDry] = useState<PurgeResult | null>(null);
  const [purgeLive, setPurgeLive] = useState<PurgeResult | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeTyped, setPurgeTyped] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await api.getRetention();
      setState(res);
      setError(null);
    } catch (e) {
      setError(loadError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Ask the server what a window would cost BEFORE the dialog can be accepted. */
  const propose = async (days: number) => {
    setProposed(days);
    setImpact(null);
    try {
      setImpact(await api.getRetentionImpact(days));
    } catch (e) {
      toast.error(loadError(e));
      setProposed(null);
    }
  };

  const commitWindow = async () => {
    if (proposed === null) return;
    setSavingWindow(true);
    try {
      // The response IS the new state, read back from the database.
      setState(await api.setRetentionDays(proposed));
      toast.success(`Calls are now kept for ${proposed} days`);
      setProposed(null);
      setImpact(null);
    } catch (e) {
      toast.error(loadError(e));
    } finally {
      setSavingWindow(false);
    }
  };

  const runPrune = async () => {
    setPruning(true);
    try {
      const result = await api.runCallStorePrune();
      setPruneResult(result);
      // A skip is not a success. The server tells us which one happened.
      if (result.skipped) toast.error(`Prune skipped: ${result.skipped}`);
      else toast.success(`Pruned ${result.stubbed ?? 0} call(s)`);
      await refresh();
    } catch (e) {
      toast.error(loadError(e));
    } finally {
      setPruning(false);
    }
  };

  const runPurge = async (live: boolean) => {
    setPurgeBusy(true);
    try {
      const result = await api.purgeLegacyCalls(
        live ? { dryRun: false, confirm: PURGE_CONFIRM_TOKEN } : { dryRun: true },
      );
      if (live) {
        setPurgeLive(result);
        setPurgeOpen(false);
        setPurgeTyped("");
        toast.success(`Deleted ${result.deleted} record(s)`);
        await refresh();
      } else {
        setPurgeDry(result);
        setPurgeLive(null);
      }
    } catch (e) {
      toast.error(loadError(e));
    } finally {
      setPurgeBusy(false);
    }
  };

  if (error && state === null) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (state === null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading retention policy…
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="retention-panel">
      {/* The control plane could not be read on THIS request. The panel still
          renders, but must not present the fallback as if it were the policy. */}
      {state.controlPlaneError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The control plane could not be read, so the window below may be out of date:{" "}
            {state.controlPlaneError}
          </span>
        </div>
      )}

      {!state.policy.policyKnown && (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="policy-unknown"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The retention window has never been readable since this server started, so the
            nightly prune is <strong>skipping</strong> rather than guessing. Nothing is being
            deleted.
          </span>
        </div>
      )}

      {/* --- the window --- */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">How long calls are kept</h2>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="retention-source">
          {sourceBlurb(state)}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {state.policy.options.map((days) => {
            const current = days === state.policy.days;
            return (
              <Button
                key={days}
                size="sm"
                variant={current ? "default" : "outline"}
                disabled={current || savingWindow}
                onClick={() => void propose(days)}
                data-testid={`retention-option-${days}`}
              >
                {days} days
                {current && <span className="ml-1.5 text-[11px] opacity-80">current</span>}
              </Button>
            );
          })}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Calls in the store</dt>
            <dd className="font-medium text-foreground">{n(state.store.totalCalls)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Full records</dt>
            <dd className="font-medium text-foreground">{n(state.store.liveCalls)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Reduced to stubs</dt>
            <dd className="font-medium text-foreground" data-testid="pruned-count">
              {n(state.store.prunedCalls)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Nightly run</dt>
            <dd className="font-medium text-foreground">
              {state.scheduler.running ? (
                <span className="text-xs" data-testid="schedule-label">
                  {scheduleLabel(state.scheduler.schedule)}{" "}
                  {/* The zone is not decoration: the job runs on OFFICE time, and
                      a container-local reading of "3:30" would be wrong by hours. */}
                  <span className="text-muted-foreground">({state.scheduler.timezone})</span>
                </span>
              ) : (
                <Badge variant="outline" className="text-[11px]">not scheduled</Badge>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* --- run the prune now --- */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-1 flex items-center gap-2">
          <PlayCircle className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Run the prune now</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Reduces every call past the window to an audit stub. Idempotent — running it after the
          nightly pass simply finds nothing to do.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => void runPrune()}
          disabled={pruning}
          data-testid="run-prune"
        >
          {pruning && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Run prune
        </Button>
        {pruneResult && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="prune-result">
            {pruneResult.skipped
              ? `Skipped: ${pruneResult.skipped}`
              : `Scanned ${n(pruneResult.scanned ?? 0)}, reduced ${n(pruneResult.stubbed ?? 0)}, already stubbed ${n(pruneResult.alreadyStubbed ?? 0)}.`}
          </p>
        )}
      </section>

      {/* --- the legacy purge --- */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Legacy purge</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          One-shot deletion of Mango rows whose called line was never mapped to an office. They
          belong to no practice and were never actionable. Twinned rows are refused rather than
          taken — deleting one would drag its attributable Retell twin with it.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runPurge(false)}
            disabled={purgeBusy}
            data-testid="purge-dry-run"
          >
            {purgeBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Dry run
          </Button>
          <Button
            size="sm"
            variant="destructive"
            // A live run is only offered once a dry run has said what it would
            // take. Nobody deletes 1,600 records without reading the count.
            disabled={purgeBusy || purgeDry === null || purgeDry.count === 0}
            onClick={() => setPurgeOpen(true)}
            data-testid="purge-live"
          >
            Delete for real
          </Button>
        </div>

        {purgeDry && (
          <div className="mt-3 rounded-lg border border-border/70 p-3 text-xs" data-testid="purge-dry-result">
            <p className="font-medium text-foreground">
              {n(purgeDry.count)} record(s) would be deleted.
            </p>
            {purgeDry.bySource && (
              <p className="mt-1 text-muted-foreground">
                By source:{" "}
                {Object.entries(purgeDry.bySource)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")}
              </p>
            )}
            <p className="mt-1 text-muted-foreground">
              Skipped because they are twinned: {n(purgeDry.skippedTwinned.length)}
            </p>
          </div>
        )}

        {purgeLive && (
          <div className="mt-3 rounded-lg border border-border/70 p-3 text-xs" data-testid="purge-live-result">
            <p className="font-medium text-foreground">Deleted {n(purgeLive.deleted)} record(s).</p>
            <p className="mt-1 break-all text-muted-foreground">
              Backup written to <code>{purgeLive.backupPath ?? "—"}</code>
            </p>
          </div>
        )}
      </section>

      <WindowConfirmDialog
        state={state}
        proposed={proposed}
        impact={impact}
        busy={savingWindow}
        onCancel={() => {
          setProposed(null);
          setImpact(null);
        }}
        onConfirm={() => void commitWindow()}
      />

      {/* The purge keeps the TYPED confirmation the API itself demands — this is
          an outright delete with no stub left behind, unlike the prune. */}
      <Dialog open={purgeOpen} onOpenChange={(open) => { if (!open) { setPurgeOpen(false); setPurgeTyped(""); } }}>
        <DialogContent data-testid="purge-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Delete {n(purgeDry?.count ?? 0)} legacy records?
            </DialogTitle>
            <DialogDescription>
              These are deleted outright, not reduced to stubs. A backup of the whole store is
              written first and its path is shown afterwards. Type{" "}
              <code className="font-mono">{PURGE_CONFIRM_TOKEN}</code> to continue.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={purgeTyped}
            onChange={(e) => setPurgeTyped(e.target.value)}
            placeholder={PURGE_CONFIRM_TOKEN}
            aria-label="Type DELETE to confirm"
            data-testid="purge-confirm-input"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setPurgeOpen(false); setPurgeTyped(""); }} disabled={purgeBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              // The server demands the token too; this only makes the refusal rare.
              disabled={purgeBusy || purgeTyped !== PURGE_CONFIRM_TOKEN}
              onClick={() => void runPurge(true)}
              data-testid="purge-confirm-accept"
            >
              {purgeBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              <Database className="mr-1.5 h-3.5 w-3.5" />
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
