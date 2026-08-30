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
 * THE FILTER IS THE SERVER'S TOO (Slice 6b)
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 6a filtered a 100-row page IN THE BROWSER while the header counted the
 * whole office, so "12 needing attention · 640 total" was two statements about
 * two different populations — and a remittance needing attention and older than
 * the hundredth newest was invisible AND uncounted, on a screen whose stated
 * premise is that the default is the work.
 *
 * The tab is now a `view` parameter: the server applies the predicate over
 * everything, pages the result, and returns BOTH counts over the same set. The
 * page changes when the tab does, which is why `filter` is in the load's
 * dependencies.
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
import { Link, useSearchParams } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  ChevronRight,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  ScrollText,
  Upload,
} from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import {
  listRemittances,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type Remittance,
  type RcmOfficeId,
  type RemittanceView,
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
import {
  FILTER_COPY,
  isWorklistFilter,
  matchesFilter,
  oldestWaitingFirst,
  SERVER_VIEWS,
  WORKLIST_FILTERS,
  type WorklistFilter,
} from "@/features/rcm/worklist";
import DisabledReason from "@/components/rcm/DisabledReason";

type Filter = WorklistFilter;

/** Rows per page. The server caps at 200; this is what a screen reads well. */
const PAGE_SIZE = 50;

/**
 * How deep a CLIENT-SIDE filter reads before it starts telling a half-truth.
 *
 * The four work-state tabs are applied in the browser (see `worklist.ts`), so
 * they can only see what came back. 200 is the server's own cap; past it the
 * header says what it counted over rather than pretending the number is the
 * office's.
 */
const SCAN_LIMIT = 200;

export default function RemittanceList() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();
  /**
   * The tab. `?view=` is how you ARRIVE at one; state is what keeps you there.
   *
   * The overview's "what needs me" cards link straight into a filtered list, so
   * the filter has to survive a link — and "show me the blocked ones" becomes a
   * URL somebody can send rather than an instruction they have to give.
   *
   * The URL is read, not written. Writing it back would make the tab depend on
   * the router's search hook being wired, and it is not everywhere this
   * component is rendered; a tab that silently stops responding under one
   * router is a worse trade than an address bar that does not follow every
   * click. The effect below still follows a link that arrives while this page
   * is already mounted.
   *
   * NEEDS ATTENTION is the default, and it is shared across the office sections
   * on purpose: a biller works one queue, not one per practice.
   */
  const [search] = useSearchParams();
  const fromUrl = search.get("view");
  const [filter, setFilter] = useState<Filter>(
    isWorklistFilter(fromUrl) ? fromUrl : "attention",
  );
  useEffect(() => {
    if (isWorklistFilter(fromUrl)) setFilter(fromUrl);
  }, [fromUrl]);

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
            Checks
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every carrier payment this practice has taken in, and what each one is waiting for.
            Nothing here has been posted to a chart on its own.
          </p>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          {/*
            ONE UPLOAD SURFACE, AND THIS IS NOT IT.
            ─────────────────────────────────────────────────────────────────
            §15.2 finding 6. The panels used to be on Today AND inline here, and
            the practice owner got lost going round the loop live: he pressed
            Upload on one page, was shown a drawer, went looking for it again
            from the other, and found a different drawer. Two doors to one room
            is worse than one door in the wrong place, because neither one is
            the place you learn.

            So the BUTTON stays — a biller standing on the list should not have
            to know where uploading lives — and it NAVIGATES to Today's
            "Get work in", which is the module's only upload surface.
            `?add=1` scrolls it into view on arrival.
          */}
          <Link
            href="/rcm?add=1"
            data-testid="remittance-upload-toggle"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Upload size={14} />
            Add a check
            <ArrowRight size={13} />
          </Link>

          <div
            className="flex flex-wrap justify-end gap-0.5 rounded-lg border border-border p-0.5"
            role="tablist"
          >
            {WORKLIST_FILTERS.map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={filter === value}
                data-testid={`remittance-filter-${value}`}
                onClick={() => setFilter(value)}
                title={FILTER_COPY[value].hint}
                className={`rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
                  filter === value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {FILTER_COPY[value].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-2 text-sm text-muted-foreground" data-testid="remittance-filter-hint">
        {FILTER_COPY[filter].hint}
        {!SERVER_VIEWS.has(filter) && (
          <>
            {" "}
            <span className="text-muted-foreground/70">
              Sorted oldest-waiting first, and applied to the newest {SCAN_LIMIT} remittances each
              practice holds — the counts beside each practice say what was read.
            </span>
          </>
        )}
      </p>

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
    | {
        kind: "loaded";
        rows: Remittance[];
        total: number;
        attention: number;
        matching: number;
        /** How many rows the SERVER handed over for a client-side filter. */
        scanned: number;
      }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });
  /** Which page of the CURRENT view. Reset whenever the view changes. */
  const [offset, setOffset] = useState(0);

  useEffect(() => setOffset(0), [filter, office]);

  /**
   * Two shapes of load, because there are two shapes of filter.
   *
   * A SERVER view (`attention`, `all`) is paged and counted by the server over
   * the whole office — the arrangement Slice 6b introduced and nothing here
   * weakens. A WORK-STATE view is applied in the browser, so it asks for one
   * deep page and says so; `scanned` versus `total` is what the header prints.
   */
  const serverBacked = SERVER_VIEWS.has(filter);

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const request = serverBacked
      ? listRemittances(office, { limit: PAGE_SIZE, offset, view: filter as RemittanceView })
      : listRemittances(office, { limit: SCAN_LIMIT, offset: 0, view: "all" });

    request
      .then((page) => {
        if (cancelled) return;
        if (serverBacked) {
          setState({
            kind: "loaded",
            rows: page.remittances,
            total: page.total,
            attention: page.needsAttentionCount,
            matching: page.matchingCount,
            scanned: page.remittances.length,
          });
          return;
        }
        const hits = oldestWaitingFirst(page.remittances.filter((r) => matchesFilter(r, filter)));
        setState({
          kind: "loaded",
          rows: hits.slice(offset, offset + PAGE_SIZE),
          total: page.total,
          attention: page.needsAttentionCount,
          matching: hits.length,
          scanned: page.remittances.length,
        });
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
  }, [office, offset, filter, serverBacked]);

  useEffect(load, [load]);

  const rows = state.kind === "loaded" ? state.rows : [];

  return (
    <section data-testid={`remittances-${office}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {state.kind === "loaded" && (
            // The count is ALWAYS visible, on every tab. A filter that does not
            // say how much it is hiding is a filter people forget is on.
            //
            // On a server view both numbers are computed server-side over the
            // SAME population, which is what makes the sentence true rather
            // than merely short. On a client-side one the sentence says what it
            // read, because "3 waiting on match" over the newest 200 of 640 is
            // not the same claim as "3 in this practice" and must not look
            // like it.
            <span data-testid={`remittance-counts-${office}`}>
              {serverBacked ? (
                <>
                  {/* On a SERVER view both numbers are computed over the same
                      whole-office population, so this is one statement rather
                      than two. `matching` is what the current tab holds; the
                      attention count is the one that never leaves the header,
                      because it is the number a biller is actually managing. */}
                  {filter === "attention" || filter === "all" ? (
                    <>
                      {state.attention} needing attention · {state.total} total
                    </>
                  ) : (
                    <>
                      {state.matching} {FILTER_COPY[filter].label.toLowerCase()} ·{" "}
                      {state.attention} needing attention · {state.total} total
                    </>
                  )}
                </>
              ) : (
                <>
                  {state.matching} {FILTER_COPY[filter].label.toLowerCase()} over the newest{" "}
                  {state.scanned}
                  {state.total > state.scanned ? ` of ${state.total}` : ""}
                </>
              )}
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
          {/*
            THREE DIFFERENT EMPTIES, AND THEY ARE NOT THE SAME NEWS.
              · this practice has nothing at all  → offer the upload, here
              · this queue is clear               → say so, and where the rest is
            "No remittances yet" over a practice holding 600 of them was the old
            copy's failure; it read as a broken screen.
          */}
          {state.total === 0 ? (
            <>
              <p className="mt-2 text-sm font-medium text-foreground">
                Nothing has come in for {RCM_OFFICE_LABELS[office]} yet
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add a carrier's 835 file or an EOB PDF and it is read into a proposal. Nothing is
                posted to a chart.
              </p>
              <Link
                href="/rcm?add=1"
                data-testid={`remittances-empty-upload-${office}`}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
              >
                <Upload size={14} />
                Add a check
              </Link>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted-foreground">{FILTER_COPY[filter].empty}</p>
              {filter !== "all" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {state.total} check{state.total === 1 ? "" : "s"} in this practice — switch to All
                  to see them.
                </p>
              )}
            </>
          )}
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

      {/*
        REAL PAGING, over the filtered population. It appears only when there is
        more than one page — and it states the range, because "Next" with no
        idea how much is left is the same failure as a filter that will not say
        what it is hiding.
      */}
      {state.kind === "loaded" && state.matching > PAGE_SIZE && (
        <div
          className="mt-3 flex items-center justify-between text-xs text-muted-foreground"
          data-testid={`remittance-pager-${office}`}
        >
          <span>
            {offset + 1}–{Math.min(offset + rows.length, state.matching)} of {state.matching}
          </span>
          {/* The two pager buttons grey at the ends of the list, and each one
              says which end it is at. Cheap, and it is the same rule as the
              Drain button: a disabled control with no reason reads as broken. */}
          <div className="flex items-start gap-2">
            <div className="flex flex-col items-center gap-0.5">
              <button
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                disabled={offset === 0}
                data-testid={`remittance-prev-${office}`}
                className="rounded-md border border-border px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
              >
                Previous
              </button>
              {offset === 0 && (
                <DisabledReason testId={`remittance-prev-reason-${office}`}>
                  First page
                </DisabledReason>
              )}
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <button
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                disabled={offset + rows.length >= state.matching}
                data-testid={`remittance-next-${office}`}
                className="rounded-md border border-border px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
              >
                Next
              </button>
              {offset + rows.length >= state.matching && (
                <DisabledReason testId={`remittance-next-reason-${office}`}>
                  Last page
                </DisabledReason>
              )}
            </div>
          </div>
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
                    : reason === "claims_queued" && r.queuedClaimCount > 0
                      ? `${r.queuedClaimCount} queued`
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
