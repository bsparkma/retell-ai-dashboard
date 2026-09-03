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
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR TABS, AND A COLUMN THAT SAYS WHOSE MOVE IT IS (Stage C, §3)
 * ─────────────────────────────────────────────────────────────────────────────
 * The strip used to carry eight tabs — one per predicate the module can express
 * — so a biller looking for her check first had to decide whether it was
 * "waiting to be matched" or "waiting for your review". That is a taxonomy
 * question standing in front of the work.
 *
 * Now every ROW says whose move it is, in words, in a *Waiting on* cell
 * (`features/rcm/waitingOn.ts` — the same computation Today's *What happens
 * next* column reads, in the other register). So the tabs only answer the four
 * questions that are about the LIST: what needs somebody, what I put down, what
 * nobody is coming back to, and everything. See `CHECK_TABS`.
 *
 * The other four filters still work as `?view=` links — Today's *How it stands*
 * cards use them and somebody may hold an old URL — and one arriving that way
 * renders as a fifth chip with a way back out of it, rather than silently
 * showing an unfiltered list.
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
  X,
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
  CHECK_TABS,
  FILTER_COPY,
  isWorklistFilter,
  matchesFilter,
  oldestWaitingFirst,
  SERVER_VIEWS,
  type WorklistFilter,
} from "@/features/rcm/worklist";
import { waitingFor } from "@/features/rcm/waitingOn";
import DisabledReason from "@/components/rcm/DisabledReason";

type Filter = WorklistFilter;

/**
 * One practice's whole-office counts, as the route returns them.
 *
 * Every one of these is computed server-side over the WHOLE office
 * (`REMITTANCE_VIEWS`), which is what makes a tab count a statement about the
 * practice rather than about the page that happens to be loaded.
 */
interface TabCounts {
  attention: number;
  parked: number;
  set_aside: number;
  all: number;
}

/** The count for one tab, or `null` when this strip cannot honestly say. */
function tabCount(
  filter: WorklistFilter,
  counts: Record<string, TabCounts>,
  offices: readonly RcmOfficeId[],
): number | null {
  if (offices.length === 0) return null;
  // EVERY office must have reported. See the note on `counts` in the component.
  if (!offices.every((o) => counts[o])) return null;
  if (filter !== "attention" && filter !== "parked" && filter !== "set_aside" && filter !== "all") {
    return null;
  }
  return offices.reduce((sum, o) => sum + counts[o][filter], 0);
}

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

  /**
   * THE TAB COUNTS, SUMMED ACROSS THE PRACTICES ON SCREEN.
   *
   * The tabs are one strip over what may be two lists, so a count taken from
   * whichever office answered first would be a number about one practice
   * wearing a label about both. Each section reports its own whole-office
   * counts up; the strip sums them and shows a number only once EVERY office in
   * scope has reported. An incomplete sum is rendered as nothing rather than as
   * a smaller number — a tab reading "3" that means "3 so far" is the kind of
   * quiet understatement this module keeps deleting.
   */
  const [counts, setCounts] = useState<Record<string, TabCounts>>({});
  const report = useCallback((office: RcmOfficeId, next: TabCounts) => {
    setCounts((prev) => ({ ...prev, [office]: next }));
  }, []);
  /* Offices change when the roster does; drop counts for ones no longer shown. */
  const officeKey = scope.offices.join(",");
  useEffect(() => setCounts({}), [officeKey]);

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
            href="/rcm/bring-in"
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
            {CHECK_TABS.map((value) => {
              const n = tabCount(value, counts, scope.offices);
              return (
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
                  {/* A COUNT ONLY WHEN IT IS THE WHOLE ANSWER — see `counts`. */}
                  {n !== null && (
                    <span
                      className="ml-1.5 tabular-nums opacity-70"
                      data-testid={`remittance-filter-count-${value}`}
                    >
                      {n}
                    </span>
                  )}
                </button>
              );
            })}

            {/*
              A FILTER THAT IS NOT ONE OF THE FOUR, ARRIVING BY LINK.
              Today's "How it stands" cards link into `?view=match` and friends,
              and somebody may hold an older URL. Rendering it as a chip with a
              way out beats both alternatives: silently showing an unfiltered
              list, or dropping the link on the floor.
            */}
            {!CHECK_TABS.includes(filter) && (
              <button
                role="tab"
                aria-selected
                data-testid={`remittance-filter-${filter}`}
                onClick={() => setFilter("attention")}
                title="Press to go back to what needs attention."
                className="rounded-md bg-foreground px-2.5 py-1.5 text-sm font-medium text-background"
              >
                {FILTER_COPY[filter].label}
                <X size={12} className="ml-1.5 inline align-[-1px]" />
              </button>
            )}
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
        <>
          <div className="mt-6 space-y-8">
            {scope.offices.map((office) => (
              <OfficeRemittances
                key={office}
                office={office}
                filter={filter}
                onCounts={report}
                setFilter={setFilter}
              />
            ))}
          </div>

          {/*
            WHAT THIS LIST IS, SAID ONCE AT THE BOTTOM.
            The two questions a biller asks of any queue — how is it ordered, and
            can something disappear out of it — answered where she is when she
            asks them, rather than left to be learned by watching a row vanish.
          */}
          <p
            className="mt-4 text-xs text-muted-foreground"
            data-testid="remittance-list-footer"
          >
            Newest first. A check leaves this list only when it is posted or set aside, and both
            stay findable under their own tab.
          </p>
        </>
      )}
    </div>
  );
}

function OfficeRemittances({
  office,
  filter,
  onCounts,
  setFilter,
}: {
  office: RcmOfficeId;
  filter: Filter;
  /** Report this practice's whole-office counts up to the tab strip. */
  onCounts: (office: RcmOfficeId, counts: TabCounts) => void;
  /** Change the tab — the empty state's way out of a filter that holds nothing. */
  setFilter: (filter: Filter) => void;
}) {
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
        /*
         * THE TAB COUNTS, from whichever shape of load ran.
         *
         * All four are whole-office numbers the route computed, present on every
         * response regardless of which `view` was asked for — so the strip is
         * complete after one load rather than after four.
         */
        onCounts(office, {
          attention: page.needsAttentionCount,
          parked: page.parkedCount,
          set_aside: page.setAsideCount,
          all: page.total,
        });
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
  }, [office, offset, filter, serverBacked, onCounts]);

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
                href="/rcm/bring-in"
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
              {/*
                AN EMPTY FILTER ALWAYS OFFERS A WAY OUT (§11).
                A tab that says "nothing here" and stops is indistinguishable
                from a broken screen at 6pm. It says how much the practice holds
                and puts the door to it under the sentence.
              */}
              {filter !== "all" && (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {state.total} check{state.total === 1 ? "" : "s"} in this practice.
                  </p>
                  <button
                    onClick={() => setFilter("all")}
                    data-testid={`remittances-empty-see-all-${office}`}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    See all of them
                    <ArrowRight size={13} />
                  </button>
                </>
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
            {/*
              WHO OR WHAT, IN WORDS. It replaced a row of chips that named the
              server's predicates — `claims_unreviewed`, `claims_unmatched` — in
              a shorter form of the same vocabulary. A biller reading "2
              unmatched · needs review" still had to work out whose move it was;
              "You — 4 claims to check over" is the answer she was deriving.
              `features/rcm/waitingOn.ts` decides it, and Today's arrivals table
              reads the same function in the other register.
            */}
            <span>Waiting on</span>
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
  /*
   * `office` is passed so the predicate can say "belongs to another office" —
   * the list fans out per practice, so it never fires here, and passing it keeps
   * this row and Today's arrivals row reading the SAME call rather than two that
   * differ by an argument.
   */
  const waiting = waitingFor(r, { office });
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
        {/*
          WHO IS ON THIS CHECK — C-3b item 1.

          The question a biller arrives with is "is my patient on this check?",
          and until now the only way to answer it was to open every row. Two
          names and a count of the rest answer most of them from the list.

          The server caps it at two and counts the REST AS PEOPLE, so this
          renders what it was given and derives nothing: "+2 more" against a
          nine-claim check is not a contradiction, it is nine claims for four
          people. Rendered only when there is something to render — an empty
          line under every unresolved check would be noise.
        */}
        {r.patientNames.shown.length > 0 && (
          <div
            className="truncate text-xs text-muted-foreground"
            data-testid={`remittance-patients-${r.batchId}`}
            title={r.patientNames.shown.join(" · ")}
          >
            {r.patientNames.shown.join(" · ")}
            {r.patientNames.more > 0 && (
              <span className="text-muted-foreground/70"> +{r.patientNames.more} more</span>
            )}
          </div>
        )}
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
        WHOSE MOVE IT IS — one sentence, and the tone follows it.
        Amber weight means somebody owes an action; grey means nothing is
        outstanding, or it is somebody else's. A takeback is the one that is
        never grey, whatever else is true about the row.
      */}
      <div className="min-w-0">
        <span
          className={`block truncate text-xs ${
            waiting.urgent
              ? "font-medium text-amber-800 dark:text-amber-300"
              : "text-muted-foreground"
          }`}
          data-testid={`remittance-waiting-${r.batchId}`}
          title={waiting.waitingOn}
        >
          {waiting.waitingOn}
        </span>
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
