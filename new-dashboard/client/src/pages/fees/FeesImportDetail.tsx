/**
 * /fees/imports/:batchId — the preview.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS SCREEN'S WHOLE JOB IS TO BE DOUBTED
 * ═════════════════════════════════════════════════════════════════════════════
 * A fee schedule is a payer contract, and the parser had to interpret parts of
 * it. The reference importer this module was ported from made those
 * interpretations SILENTLY — it took the first money token on a multi-column
 * row whatever tier the office held, and wrote one line's single amount against
 * every code on it. Nobody could have caught either, because nothing said a
 * choice had been made.
 *
 * So the design rule here is the inverse: every row the parser had to interpret
 * is visually distinct AND shows the line it came from, because the raw line is
 * the only thing that lets a reader judge whether the interpretation was right.
 * A warning without its source line is a warning nobody can act on.
 *
 * Three specifics that are not decoration:
 *
 *  1. $0.00 RENDERS AS $0.00. Never blank, never an em dash. In a fee schedule
 *     zero means not covered, bundled, or no fee — a fact the office needs. The
 *     reference discarded every zero with a `> 0` guard; drawing one as an
 *     empty cell would put that defect back one layer up.
 *
 *  2. DUPLICATE CODES ARE GROUPED, so both fees are seen side by side. A payer
 *     schedule really does list D2740 twice — a base page and an amendment
 *     page — and the two numbers being forty rows apart is how somebody scrolls
 *     past the disagreement. The schema keeps both rows on purpose (no UNIQUE
 *     on (batch_id, proc_code)); this is the half of that decision the reader
 *     actually sees.
 *
 *  3. FILE-LEVEL WARNINGS RENDER AT THE TOP, above the rows. They are facts
 *     about the upload rather than about any one fee — "line 12 named three
 *     codes, so no fees were read from it" describes something that is NOT in
 *     the table below, and putting it beside the rows would file an absence
 *     among presences.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BANNER IS LOAD-BEARING, AND AS OF SLICE 3 IT IS CONDITIONAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 2 said "Preview only — nothing has been sent to Open Dental" on every
 * batch, and its header recorded that this banner would be "the first thing
 * that must change" when posting landed, because "a reader who has learned to
 * trust it is exactly who would be misled if it were left behind".
 *
 * This is that change. The line is now shown only for a batch that has NOT been
 * posted; a posted, failed-partway or rolled-back one gets a different banner
 * and the posting panel underneath, which says what actually reached the
 * practice. `post_failed` counts as posted for this purpose — a run that
 * stopped at row 300 still put 299 fees in, and that is the worst possible
 * moment for this page to claim otherwise.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { AlertTriangle, ArrowLeft, Info, Loader2, XCircle } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { can } from "@/lib/permissions";
import {
  decideRow,
  getImport,
  groupRowsByCode,
  formatFeeCents,
  formatBytes,
  FeesApiError,
  FEES_OFFICE_IDS,
  FEES_OFFICE_LABELS,
  isFeesOfficeId,
  type FeesImportBatch,
  type FeesImportRow,
  type FeesOfficeId,
} from "@/features/fees/api";
import { PostingPanel } from "@/features/fees/PostingPanel";
import { cn } from "@/lib/utils";

type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; batch: FeesImportBatch; rows: FeesImportRow[] }
  | { kind: "error"; error: FeesApiError };

/**
 * Which offices to try for this batch id.
 *
 * Under a concrete selection, that one. Under "All", BOTH — a batch id is a
 * uuid the server minted and the detail endpoint scopes by office in the WHERE,
 * so asking the wrong office returns 404 rather than another office's data.
 * Trying both is how a link pasted from a merged list still opens; it cannot
 * leak anything, because a 404 is all the wrong office can ever produce.
 */
function officesToTry(selection: string): FeesOfficeId[] {
  if (selection === ALL_OFFICES) return [...FEES_OFFICE_IDS];
  return isFeesOfficeId(selection) ? [selection] : [...FEES_OFFICE_IDS];
}

/** A local date-time an office reads, from an ISO string. */
function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function FeesImportDetail() {
  const [, params] = useRoute("/fees/imports/:batchId");
  const batchId = params?.batchId ?? "";
  const { office: selection, loading: rosterLoading } = useOffice();
  const auth = useAuth();
  /**
   * UX ONLY. The server's requireReadWrite is the boundary; this decides
   * whether the Post button is offered with its reason or offered at all. A
   * reader without fees.write still opens the page and sees everything.
   */
  const canWrite = can(
    auth.status === "authenticated" ? auth.user.permissions : undefined,
    "fees.write",
  );

  const [state, setState] = useState<DetailState>({ kind: "loading" });
  /** Bumped when a decision, a post or a rollback changes what the rows say. */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (rosterLoading || batchId === "") return;
    const abort = new AbortController();
    // NOT a loading state on a re-read. Blanking the page every time somebody
    // accepts a row would make the list jump under the cursor they are about to
    // click again.
    if (reloadToken === 0) setState({ kind: "loading" });

    const candidates = officesToTry(selection);

    (async () => {
      let lastError: FeesApiError | null = null;
      for (const office of candidates) {
        try {
          const result = await getImport(office, batchId, abort.signal);
          if (abort.signal.aborted) return;
          setState({ kind: "ready", batch: result.batch, rows: result.rows });
          return;
        } catch (err: unknown) {
          if (abort.signal.aborted) return;
          const asApi =
            err instanceof FeesApiError
              ? err
              : new FeesApiError(
                  err instanceof Error ? err.message : "Could not load this import",
                  0,
                  null,
                );
          lastError = asApi;
          // A 404 from one office is not an answer while another is untried.
          // Anything else — 403, a network failure — is, and retrying the other
          // office would only produce the same refusal a second time.
          if (asApi.status !== 404) break;
        }
      }
      if (!abort.signal.aborted) {
        setState({
          kind: "error",
          error: lastError ?? new FeesApiError("No such import.", 404, "BATCH_NOT_FOUND"),
        });
      }
    })();

    return () => abort.abort();
  }, [batchId, selection, rosterLoading, reloadToken]);

  return (
    <div className="p-6" data-testid="fees-import-detail">
      <Link
        href="/fees"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        data-testid="fees-detail-back"
      >
        <ArrowLeft size={16} aria-hidden />
        All imports
      </Link>

      {state.kind === "loading" && (
        <div
          className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="fees-detail-loading"
        >
          <Loader2 size={16} className="animate-spin" aria-hidden />
          Loading this import…
        </div>
      )}

      {state.kind === "error" && (
        <div
          className="mt-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          data-testid="fees-detail-error"
        >
          <div className="text-sm font-medium text-foreground">{state.error.message}</div>
          {state.error.code !== null && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">{state.error.code}</div>
          )}
        </div>
      )}

      {state.kind === "ready" && (
        <Preview
          batch={state.batch}
          rows={state.rows}
          canWrite={canWrite}
          onSettled={reload}
        />
      )}
    </div>
  );
}

/**
 * Statuses in which the preview-only banner would be a lie.
 *
 * `post_failed` is on this list deliberately. A run that stopped partway still
 * put fees into the practice, and a screen telling that reader "nothing has
 * been sent" is the worst moment for this page to be wrong.
 */
const POSTED_STATUSES: readonly string[] = ["posting", "posted", "post_failed", "rolled_back"];

/** A batch whose rows can still be decided. */
const EDITABLE_STATUSES: readonly string[] = ["parsed", "ready"];

function Preview({
  batch,
  rows,
  canWrite,
  onSettled,
}: {
  batch: FeesImportBatch;
  rows: readonly FeesImportRow[];
  canWrite: boolean;
  onSettled: () => void;
}) {
  const groups = groupRowsByCode(rows);
  const decidable = EDITABLE_STATUSES.includes(batch.status);

  return (
    <>
      <div className="mt-4">
        <h1
          className="text-2xl font-bold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          {batch.filename}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {FEES_OFFICE_LABELS[batch.office] ?? batch.office} · {batch.sourceType.toUpperCase()} ·{" "}
          {formatBytes(batch.fileSizeBytes)} · uploaded {formatWhen(batch.createdAt)} by{" "}
          {batch.createdBy}
        </p>
      </div>

      {/* ── The banner. See the header — this is load-bearing, and as of slice 3
             it is CONDITIONAL. "Nothing has been sent to Open Dental" was true
             of every batch while posting did not exist; it is now true only of
             one that has not been posted. A reader who has learned to trust
             this line is exactly who would be misled by leaving it up after the
             fees are in their practice's database. ─────────────────────────── */}
      {POSTED_STATUSES.includes(batch.status) ? (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-4"
          data-testid="fees-posted-banner"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <div className="text-sm font-medium text-foreground">
              {batch.status === "rolled_back"
                ? "This import was posted and then rolled back."
                : "These fees have been written to Open Dental."}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              What is below is what CareIN read out of the file. The panel underneath says what
              actually reached the practice.
            </p>
          </div>
        </div>
      ) : (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-4"
          data-testid="fees-preview-banner"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <div className="text-sm font-medium text-foreground">
              Preview only — nothing has been sent to Open Dental.
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              This is what CareIN read out of the file. Nothing reaches the practice until somebody
              presses Post below.
            </p>
          </div>
        </div>
      )}

      {/* The posting panel: target, Post, progress, rollback. Absent for a file
          that never parsed — there is nothing to post. */}
      {batch.status !== "failed" && (
        <PostingPanel
          office={batch.office}
          batchId={batch.batchId}
          canWrite={canWrite}
          onSettled={onSettled}
        />
      )}

      {/* ── A failed batch has no rows, and says why. ──────────────────────── */}
      {batch.status === "failed" && (
        <div
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          data-testid="fees-detail-failed"
        >
          <div className="flex items-start gap-2">
            <XCircle size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
            <div>
              <div className="text-sm font-medium text-foreground">
                This file could not be read.
              </div>
              <p className="mt-1 text-sm text-muted-foreground" data-testid="fees-detail-failure-reason">
                {batch.failureReason ?? "No reason was recorded."}
              </p>
              {batch.failureCode !== null && (
                <div
                  className="mt-1 font-mono text-xs text-muted-foreground"
                  data-testid="fees-detail-failure-code"
                >
                  {batch.failureCode}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── File-level warnings, above the rows. See the header, note 3. ──── */}
      {batch.warnings.length > 0 && (
        <div
          className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
          data-testid="fees-file-warnings"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="shrink-0 text-amber-600" aria-hidden />
            <span className="text-sm font-medium text-foreground">
              {batch.warnings.length} {batch.warnings.length === 1 ? "note" : "notes"} about this
              file
            </span>
          </div>
          <ul className="mt-2 space-y-1.5">
            {batch.warnings.map((warning, i) => (
              <li
                key={`${warning.code}-${i}`}
                className="text-sm text-muted-foreground"
                data-testid="fees-file-warning"
              >
                {warning.message}
                <span className="ml-2 font-mono text-xs opacity-70">{warning.code}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── The rows ──────────────────────────────────────────────────────── */}
      {batch.status === "parsed" && (
        <section className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {batch.rowCount} {batch.rowCount === 1 ? "fee" : "fees"}, in file order
            </h2>
            {batch.warningCount > 0 && (
              <span className="text-sm text-muted-foreground" data-testid="fees-detail-warning-count">
                {batch.warningCount} {batch.warningCount === 1 ? "warning" : "warnings"} in total
              </span>
            )}
          </div>

          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {groups.map((group) => {
              const duplicated = group.rows.length > 1;
              return (
                <li
                  key={group.procCode}
                  data-testid="fees-row-group"
                  data-proc-code={group.procCode}
                  data-conflicting={group.conflicting ? "true" : "false"}
                  className={cn(
                    "p-4",
                    // A code listed twice at two DIFFERENT fees is a decision
                    // somebody has to make; twice at the same fee is only
                    // untidy. Drawing them alike would spend the reader's
                    // attention on the one that does not need it.
                    group.conflicting && "border-l-4 border-l-amber-500 bg-amber-500/5",
                  )}
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {group.procCode}
                    </span>
                    {duplicated && (
                      <span
                        className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
                        data-testid="fees-duplicate-badge"
                      >
                        {group.conflicting
                          ? `listed ${group.rows.length} times at different fees`
                          : `listed ${group.rows.length} times`}
                      </span>
                    )}
                  </div>

                  {/* Side by side, so the disagreement is one glance rather
                      than forty rows of scrolling. */}
                  <div className="mt-2 space-y-2">
                    {group.rows.map((row) => (
                      <div
                        key={row.rowId}
                        data-testid="fees-row"
                        data-warned={row.warnings.length > 0 ? "true" : "false"}
                        className={cn(
                          "rounded-md px-3 py-2",
                          row.warnings.length > 0
                            ? "border border-amber-500/40 bg-amber-500/5"
                            : "bg-muted/40",
                        )}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span
                            className="text-base font-semibold tabular-nums text-foreground"
                            data-testid="fees-row-amount"
                          >
                            {formatFeeCents(row.feeCents)}
                          </span>
                          {row.warnings.length > 0 && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                              <AlertTriangle size={12} aria-hidden />
                              {row.warnings.length === 1
                                ? "1 warning"
                                : `${row.warnings.length} warnings`}
                            </span>
                          )}
                        </div>

                        {row.warnings.length > 0 && (
                          <>
                            <ul className="mt-1.5 space-y-1">
                              {row.warnings.map((warning, i) => (
                                <li
                                  key={`${warning.code}-${i}`}
                                  className="text-sm text-muted-foreground"
                                  data-testid="fees-row-warning"
                                >
                                  {warning.message}
                                  <span className="ml-2 font-mono text-xs opacity-70">
                                    {warning.code}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {/* THE RAW LINE. A warning without the line it came
                                from is a warning nobody can judge — this is the
                                whole reason the column is stored. */}
                            <pre
                              className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground"
                              data-testid="fees-row-raw-line"
                            >
                              {row.rawLine}
                            </pre>

                            {/* THE DECISION. A warned row blocks the post until
                                somebody who has read the line above says
                                whether the number is the fee this office holds.
                                The gate is enforced server-side; these are the
                                controls, not the guard. */}
                            <RowDecision
                              office={batch.office}
                              batchId={batch.batchId}
                              row={row}
                              editable={decidable && canWrite}
                              onDecided={onSettled}
                            />
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>

          {groups.length === 0 && (
            <div
              className="mt-3 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground"
              data-testid="fees-detail-no-rows"
            >
              This import stored no fees.
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * Accept or exclude ONE warned row.
 *
 * `accepted` — the reader looked at the raw line above and confirms the parsed
 *              value is the fee this office holds.
 * `excluded` — it is not, and the row must never be written. The database
 *              refuses to store a FeeNum on an excluded row, so the promise is
 *              kept there rather than by a filter somebody might reorder.
 * `reset`    — offered only once a decision exists, because a decision made by
 *              mistake must be undoable BEFORE the post. Afterwards the only
 *              remedy is a rollback.
 *
 * Clean rows never render this: the gate is warned-AND-undecided, not a
 * checklist, so a hundred-row file with two flagged rows needs exactly two
 * clicks.
 */
function RowDecision({
  office,
  batchId,
  row,
  editable,
  onDecided,
}: {
  office: FeesOfficeId;
  batchId: string;
  row: FeesImportRow;
  editable: boolean;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decision = row.decision ?? "pending";

  const choose = async (next: "accepted" | "excluded" | "reset") => {
    setBusy(true);
    setError(null);
    try {
      await decideRow(office, batchId, row.rowId, next);
      onDecided();
    } catch (err: unknown) {
      setError(err instanceof FeesApiError ? err.message : "Could not record that");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="fees-row-decision" data-decision={decision}>
      {decision === "pending" ? (
        <>
          <span className="text-xs text-muted-foreground">Is this the fee you hold?</span>
          <button
            type="button"
            disabled={!editable || busy}
            onClick={() => void choose("accepted")}
            data-testid="fees-row-accept"
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={!editable || busy}
            onClick={() => void choose("excluded")}
            data-testid="fees-row-exclude"
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            Do not post it
          </button>
        </>
      ) : (
        <>
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground"
            data-testid="fees-row-decided"
          >
            {decision === "accepted" ? "Accepted" : "Excluded"}
            {row.decidedBy ? ` · ${row.decidedBy}` : ""}
          </span>
          {editable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void choose("reset")}
              data-testid="fees-row-reset"
              className="text-xs font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-50"
            >
              Undo
            </button>
          )}
        </>
      )}
      {error !== null && (
        <span className="text-xs text-destructive" data-testid="fees-row-decision-error">
          {error}
        </span>
      )}
    </div>
  );
}
