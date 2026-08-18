/**
 * /rcm/remittances — the workbench's front door (Slice 6a).
 *
 * Every payment batch this office holds, whether an 835 parsed it or a model
 * read it out of a PDF. Before this screen existed the only visible evidence
 * that an upload had worked was a counter on an office card: Beau uploaded a
 * real 835 to staging and had nowhere to look at what it contained.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEEDS ATTENTION IS THE DEFAULT VIEW
 * ─────────────────────────────────────────────────────────────────────────────
 * Same philosophy as the voice worklist: the default is the WORK, not the
 * archive — and the work is an ACTION somebody still owes, never a fact the
 * file happens to carry. `attentionReasons` are obligations and are the only
 * thing that puts a row here; `attentionObservations` are facts, rendered
 * beside them in a lighter weight. Merging the two is what left a remittance
 * whose every claim had been reviewed sitting in this view for ever (see
 * attentionFor in routes/rcm/remittances.js).
 *
 * The predicate is computed server-side and arrives on the row, so this list,
 * its count and the detail screen cannot disagree about whether something is
 * finished. The "All" tab is one click away and its count is always visible, so
 * the filter never hides how much it is hiding.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE LIST PER OFFICE, NEVER A MERGED ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * Office is a correctness boundary in this module, not a filter. `/api/rcm` has
 * no all-offices query at all — every route runs through requireOffice — so
 * "All Offices" is a client-side fan-out that keeps the answers SEPARATE. A
 * combined row would invite acting on it, and there is no combined chart to act
 * against.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  ChevronRight,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import {
  listRemittances,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type Remittance,
  type RcmOfficeId,
} from "@/features/rcm/api";
import {
  attentionLabel,
  batchStatusLabel,
  batchStatusTone,
  day,
  money,
  SOURCE_LABELS,
  SOURCE_TITLES,
} from "@/features/rcm/format";

type Filter = "attention" | "all";

export default function RemittanceList() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();
  // NEEDS ATTENTION FIRST. Shared across the office cards on purpose: a biller
  // works one queue, not one queue per practice.
  const [filter, setFilter] = useState<Filter>("attention");

  if (scope.loading) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="remittances-loading"
      >
        <Loader2 size={16} className="animate-spin" />
        Loading offices…
      </div>
    );
  }

  if (scope.error) {
    return (
      <div className="p-6" data-testid="remittances-roster-error">
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not load the office list</div>
          <p className="mt-1 text-sm text-muted-foreground">{scope.error}</p>
          <button
            onClick={reload}
            className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6" data-testid="rcm-remittances">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "Sora, sans-serif" }}
          >
            Remittances
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every carrier payment this practice has taken in, and what it says. Nothing here has
            been posted to a chart.
          </p>
        </div>

        <div className="flex rounded-lg border border-border p-0.5" role="tablist">
          {(
            [
              ["attention", "Needs attention"],
              ["all", "All"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              data-testid={`remittance-filter-${value}`}
              onClick={() => setFilter(value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {scope.offices.length === 0 ? (
        <div
          className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center"
          data-testid="remittances-no-offices"
        >
          <div className="text-sm font-medium text-foreground">No RCM offices</div>
          <p className="mt-1 text-sm text-muted-foreground">
            None of this practice's offices are set up for revenue cycle work yet.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {scope.offices.map((office) => (
            <OfficeRemittances key={office} office={office} filter={filter} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfficeRemittances({ office, filter }: { office: RcmOfficeId; filter: Filter }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; rows: Remittance[]; total: number; attention: number }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    listRemittances(office, { limit: 100 })
      .then((page) => {
        if (!cancelled) {
          setState({
            kind: "loaded",
            rows: page.remittances,
            total: page.total,
            attention: page.needsAttentionCount,
          });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The server's own words. A tenant without the module says exactly that
        // rather than the page inventing "something went wrong".
        const message =
          err instanceof RcmApiError && err.notEntitled
            ? "This practice is not set up for the RCM module."
            : err instanceof Error
              ? err.message
              : "Could not load remittances.";
        setState({ kind: "failed", message });
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  useEffect(load, [load]);

  const rows =
    state.kind === "loaded"
      ? filter === "attention"
        ? state.rows.filter((r) => r.needsAttention)
        : state.rows
      : [];

  return (
    <section data-testid={`remittances-${office}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {state.kind === "loaded" && (
            // The count is ALWAYS visible, on both tabs. A filter that does not
            // say how much it is hiding is a filter people forget is on.
            <span data-testid={`remittance-counts-${office}`}>
              {state.attention} needing attention · {state.total} total
            </span>
          )}
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted"
            aria-label={`Refresh ${RCM_OFFICE_LABELS[office]}`}
          >
            <RefreshCw size={12} className={state.kind === "loading" ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {state.kind === "failed" ? (
        <div
          className="mt-3 flex items-start gap-2 rounded-xl border border-border bg-card p-5 text-sm text-destructive"
          data-testid={`remittances-error-${office}`}
        >
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{state.message}</span>
        </div>
      ) : state.kind === "loading" ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          className="mt-3 rounded-xl border border-dashed border-border bg-card p-8 text-center"
          data-testid={`remittances-empty-${office}`}
        >
          <Inbox size={20} className="mx-auto text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">
            {filter === "attention" && state.total > 0
              ? "Nothing needs attention here. Switch to All to see everything."
              : "No remittances yet. Upload an 835 or an EOB from the Revenue Cycle overview."}
          </p>
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          {/* A grid whose template is declared ONCE and used by both the header
              and every row — the worklist lesson from the voice side, where
              per-row grids with max-content columns drifted out of alignment. */}
          <div className="hidden grid-cols-[minmax(11rem,1.4fr)_7rem_8rem_5rem_9rem_minmax(9rem,1fr)_1.5rem] gap-3 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
            <span>Payer / check</span>
            <span>Date</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Claims</span>
            <span>Status</span>
            {/* Not "Needs attention": the column carries BOTH what is owed
                (amber) and what was merely observed (grey), and a grey chip
                under a "needs attention" heading would be the same small lie
                the predicate itself used to tell. */}
            <span>Outstanding · observed</span>
            <span />
          </div>
          {rows.map((r) => (
            <RemittanceRow key={r.batchId} office={office} remittance={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function RemittanceRow({ office, remittance: r }: { office: RcmOfficeId; remittance: Remittance }) {
  return (
    <Link
      href={`/rcm/remittances/${r.batchId}`}
      data-testid={`remittance-row-${r.batchId}`}
      className="grid grid-cols-1 items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40 md:grid-cols-[minmax(11rem,1.4fr)_7rem_8rem_5rem_9rem_minmax(9rem,1fr)_1.5rem]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{r.payer}</span>
          {r.source && (
            <span
              title={SOURCE_TITLES[r.source]}
              className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              data-testid={`remittance-source-${r.batchId}`}
            >
              {SOURCE_LABELS[r.source]}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {r.checkNumber || r.eftNumber || r.traceNumber || "No check or trace number"}
        </div>
      </div>

      <span className="text-sm text-muted-foreground">{day(r.depositDate)}</span>

      <div className="text-right">
        <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
          {money(r.totalAmountCents)}
        </div>
        {/* THE BALANCE CHECK, in the row rather than only on the detail: the
            batch's own total against the sum of its claims. A mismatch is the
            first thing a biller wants to see, and the difference is the number
            they chase — so it is shown, not merely flagged. */}
        {!r.balance.balanced && (
          <div
            className="font-mono text-xs tabular-nums text-rose-600 dark:text-rose-400"
            data-testid={`remittance-imbalance-${r.batchId}`}
          >
            {money(r.balance.differenceCents)} off
          </div>
        )}
      </div>

      <span className="text-right font-mono text-sm tabular-nums text-muted-foreground">
        {r.claimCount}
      </span>

      <span
        className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${batchStatusTone(r.status)}`}
      >
        {batchStatusLabel(r.status)}
      </span>

{/*
        WHAT IS OWED, AND WHAT IS MERELY TRUE — told apart by weight.
        Amber chips are outstanding actions and are the only thing that put this
        row in the queue. Grey chips are facts about the file: a biller reads
        them to decide how hard to look, and none of them is work she can
        discharge. Rendering both in amber is how "reviewed everything, still
        flagged as needing attention" happened.
      */}
      <div className="flex flex-wrap gap-1">
        {r.attentionReasons.length === 0 && r.attentionObservations.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <>
            {r.attentionReasons.map((reason) => (
              <span
                key={reason}
                title={attentionLabel(reason)}
                data-testid={`attention-reason-${reason}`}
                className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              >
                {attentionLabel(reason)}
              </span>
            ))}
            {r.attentionObservations.map((reason) => (
              <span
                key={reason}
                title={attentionLabel(reason)}
                data-testid={`attention-observation-${reason}`}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {reason === "claims_flagged" && r.reviewReasonCount > 0
                  ? `${r.reviewReasonCount} flagged`
                  : reason === "claims_unmatched" && r.unmatchedClaimCount > 0
                    ? `${r.unmatchedClaimCount} unmatched`
                    : attentionLabel(reason)}
              </span>
            ))}
          </>
        )}
      </div>

      <ChevronRight size={16} className="hidden justify-self-end text-muted-foreground md:block" />
    </Link>
  );
}

/** Exported for the overview page's "open the workbench" affordance. */
export function RemittancesLink({ office }: { office: RcmOfficeId }) {
  return (
    <Link
      href="/rcm/remittances"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
      data-testid={`open-remittances-${office}`}
    >
      <ScrollText size={14} />
      Open the review workbench
    </Link>
  );
}

/** A small icon used by the empty state copy above; kept for tree-shaking clarity. */
export const REMITTANCE_ICON = FileText;
