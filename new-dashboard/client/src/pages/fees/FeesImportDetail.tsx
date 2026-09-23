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
 * THE BANNER IS LOAD-BEARING
 * ═════════════════════════════════════════════════════════════════════════════
 * "Preview only — nothing has been sent to Open Dental." It is true today and
 * it stays true until the posting slice: this module has no Open Dental access
 * of any kind, which the backend guard (feesNoOdAccess.test.js) proves rather
 * than asserts. When posting lands, that banner is the first thing that must
 * change — and a reader who has learned to trust it is exactly who would be
 * misled if it were left behind.
 */
import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { AlertTriangle, ArrowLeft, Info, Loader2, XCircle } from "lucide-react";

import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import {
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

  const [state, setState] = useState<DetailState>({ kind: "loading" });

  useEffect(() => {
    if (rosterLoading || batchId === "") return;
    const abort = new AbortController();
    setState({ kind: "loading" });

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
  }, [batchId, selection, rosterLoading]);

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

      {state.kind === "ready" && <Preview batch={state.batch} rows={state.rows} />}
    </div>
  );
}

function Preview({ batch, rows }: { batch: FeesImportBatch; rows: readonly FeesImportRow[] }) {
  const groups = groupRowsByCode(rows);

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

      {/* ── The banner. See the header — this is load-bearing. ─────────────── */}
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
            This is what CareIN read out of the file. Posting these fees to a practice's fee
            schedule is a separate step that does not exist yet.
          </p>
        </div>
      </div>

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
