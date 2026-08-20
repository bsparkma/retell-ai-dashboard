/**
 * /rcm/posting — the posting queue, and the one button in this product that
 * writes to a patient's chart (Slice 6c).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREEN IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Approving a remittance (6b) writes a PLAN: per-line intended amounts, the
 * Open Dental identifiers a confirmed match recorded, and the fact that a human
 * authorised it. Nothing reaches a chart. This screen is where somebody presses
 * Drain and watches those plans become real insurance payments.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY CLAIM THIS SCREEN MAKES IS ONE THE SERVER PROVED
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental returns `200 OK` on writes it silently ignores, so a posting
 * engine that believes its own status codes reports work it never did. The
 * server therefore reads every write back and compares it, and this screen shows
 * that evidence rather than a green tick:
 *
 *   - a `posted` plan shows its **ClaimPaymentNum** — the check that exists in
 *     the practice's books — and the time the reconciliation read confirmed the
 *     check carries exactly this plan's lines. The database refuses to store
 *     `posted` without both, so "verified by read-back" is a fact here.
 *   - a `partially_posted` plan shows the exact per-line positions. It does NOT
 *     say "failed": money HAS moved, and a state reading as "nothing happened"
 *     would send a biller looking for a payment that is sitting in the chart.
 *   - a `blocked` plan shows the machine reason as copy that says what to DO,
 *     because blocked means a human owes an action.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUTTON, AND WHO SEES WHAT
 * ─────────────────────────────────────────────────────────────────────────────
 * Drain needs `rcm.write` (D-9). A `reviewer` sees the whole queue — watching a
 * plan post, and reading why one is blocked, is not a posting act — with the
 * button disabled and naming the permission a colleague holds. `canDrain` is the
 * SERVER'S answer, never a role name this component inspects.
 *
 * D-7 is the server's answer too: `postingEnabled` is false for a practice that
 * has not been validated yet, and the copy says so instead of the client
 * hardcoding a practice name that would go stale the day it is switched on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RUN IS BOUNDED AND SAYS SO
 * ─────────────────────────────────────────────────────────────────────────────
 * Every Open Dental call is paced at ≥1.2 s because the credential is shared
 * with the phone system, so a large plan is minutes of wall clock. The server
 * stops cleanly BETWEEN plans when its budget runs out and returns `outOfTime`
 * with how many are left; this screen says that plainly and the button is
 * pressed again. It never stops mid-claim.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Lock,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import {
  drainPostingQueue,
  getPostingPlan,
  listPostingQueue,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type DrainResult,
  type PostingQueueDetail,
  type PostingQueuePage,
  type PostingQueueRow,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { day, money } from "@/features/rcm/format";
import {
  blockedCopy,
  LINE_STATE_COPY,
  QUEUE_STATE_COPY,
  queueStateTone,
  stepCopy,
} from "@/features/rcm/posting";

export default function PostingQueue() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();

  if (scope.loading) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="posting-loading"
      >
        <Loader2 size={16} className="animate-spin" />
        Loading offices…
      </div>
    );
  }

  if (scope.error) {
    return (
      <div className="p-6" data-testid="posting-roster-error">
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
    <div className="p-6" data-testid="rcm-posting">
      <div>
        <h1
          className="text-2xl font-bold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          Posting
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Approved remittances waiting to become insurance payments in Open Dental. Draining writes
          each line's adjudication, marks the claim received, and creates the check — reading every
          write back to prove it took.
        </p>
      </div>

      {scope.offices.length === 0 ? (
        <div
          className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center"
          data-testid="posting-no-offices"
        >
          <div className="text-sm font-medium text-foreground">No RCM offices</div>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {scope.offices.map((office) => (
            <OfficePostingQueue key={office} office={office} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfficePostingQueue({ office }: { office: RcmOfficeId }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "loaded"; page: PostingQueuePage } | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const [draining, setDraining] = useState(false);
  const [result, setResult] = useState<DrainResult | null>(null);
  const [drainError, setDrainError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    listPostingQueue(office, { limit: 50 })
      .then((page) => {
        if (!cancelled) setState({ kind: "loaded", page });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof RcmApiError ? err.message : "Could not load the posting queue.";
        setState({ kind: "failed", message });
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  useEffect(load, [load]);

  const drain = useCallback(async () => {
    setDraining(true);
    setDrainError(null);
    setResult(null);
    try {
      const res = await drainPostingQueue(office);
      setResult(res);
    } catch (err: unknown) {
      setDrainError(
        err instanceof RcmApiError
          ? err.message
          : "The posting run could not be started.",
      );
    } finally {
      setDraining(false);
      // Reload either way: a run that failed part-way still changed the plans it
      // reached, and a screen showing the pre-run state after that would be the
      // stale-client bug the EOB panel already learned once.
      load();
    }
  }, [office, load]);

  const page = state.kind === "loaded" ? state.page : null;
  const waiting = page ? page.byStatus.approved + page.byStatus.failed + page.byStatus.partially_posted : 0;

  return (
    <section data-testid={`posting-office-${office}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
          {page && (
            <span className="text-sm text-muted-foreground" data-testid={`posting-counts-${office}`}>
              {waiting} waiting · {page.byStatus.posted} posted · {page.byStatus.blocked} blocked ·{" "}
              {page.total} total
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            data-testid={`posting-refresh-${office}`}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          {page && <DrainButton office={office} page={page} draining={draining} onDrain={drain} />}
        </div>
      </div>

      {/* D-7, in the server's words. A practice that has not been validated
          cannot post, and this is the only place that says why. */}
      {page && !page.postingEnabled && (
        <div
          className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30"
          data-testid={`posting-disabled-${office}`}
        >
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <div>
            <div className="font-medium text-amber-900 dark:text-amber-200">
              Posting is not switched on for {RCM_OFFICE_LABELS[office]} yet
            </div>
            <p className="mt-0.5 text-amber-800 dark:text-amber-300">
              This practice's own payment-type numbers have to be read from its own Open Dental, its
              key's write access proven, and a test-patient run completed first. Draining here marks
              each plan blocked and makes no Open Dental call at all.
            </p>
          </div>
        </div>
      )}

      {drainError && (
        <div
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
          data-testid={`posting-drain-error-${office}`}
        >
          {drainError}
        </div>
      )}

      {result && <DrainSummary office={office} result={result} />}

      <div className="mt-4">
        {state.kind === "loading" && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        )}
        {state.kind === "failed" && (
          <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {state.message}
          </div>
        )}
        {state.kind === "loaded" && state.page.rows.length === 0 && (
          <div
            className="rounded-xl border border-dashed border-border bg-card p-8 text-center"
            data-testid={`posting-empty-${office}`}
          >
            <div className="text-sm font-medium text-foreground">Nothing waiting to post</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Approve a remittance and its posting plan appears here.
            </p>
          </div>
        )}
        {state.kind === "loaded" && state.page.rows.length > 0 && (
          <div className="space-y-3">
            {state.page.rows.map((row) => (
              <PlanCard key={row.queueId} office={office} row={row} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The button.
 *
 * Disabled for a reviewer, and it SAYS SO — naming the permission an approver
 * holds rather than leaving the screen to be inferred from a greyed-out control.
 * `canDrain` comes from the server, so a role the client has never heard of
 * still gets the right answer.
 */
function DrainButton({
  office,
  page,
  draining,
  onDrain,
}: {
  office: RcmOfficeId;
  page: PostingQueuePage;
  draining: boolean;
  onDrain: () => void;
}) {
  const waiting = page.byStatus.approved + page.byStatus.failed + page.byStatus.partially_posted;
  const disabled = draining || !page.canDrain || waiting === 0;

  const title = !page.canDrain
    ? `Posting to Open Dental needs ${page.drainRequires} — an approver can press this`
    : waiting === 0
      ? "Nothing is waiting to post"
      : `Post ${waiting} plan${waiting === 1 ? "" : "s"} to Open Dental`;

  return (
    <button
      onClick={onDrain}
      disabled={disabled}
      title={title}
      data-testid={`posting-drain-${office}`}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
        disabled
          ? "cursor-not-allowed bg-muted text-muted-foreground"
          : "bg-foreground text-background hover:opacity-90"
      }`}
    >
      {draining ? (
        <Loader2 size={14} className="animate-spin" />
      ) : page.canDrain ? (
        <PlayCircle size={14} />
      ) : (
        <Lock size={14} />
      )}
      {draining ? "Posting…" : "Drain"}
    </button>
  );
}

/** What the run just did, including when it ran out of time. */
function DrainSummary({ office, result }: { office: RcmOfficeId; result: DrainResult }) {
  const posted = result.outcomes.filter((o) => o.status === "posted").length;
  const blocked = result.outcomes.filter((o) => o.status === "blocked").length;
  const trouble = result.outcomes.filter(
    (o) => o.status === "failed" || o.status === "partially_posted",
  ).length;

  return (
    <div
      className="mt-3 rounded-lg border border-border bg-card p-3 text-sm"
      data-testid={`posting-drain-summary-${office}`}
    >
      <div className="font-medium text-foreground">
        {result.ran === 0
          ? "Nothing was waiting to post."
          : `${posted} posted · ${blocked} blocked · ${trouble} needing attention`}
      </div>

      {result.outOfTime && (
        <p className="mt-1 flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
          <Clock size={14} />
          The run reached its time limit and stopped cleanly between plans.{" "}
          {result.remaining} still waiting — press Drain again.
        </p>
      )}

      {/* The per-office numbers this run actually used, from THIS practice's own
          Open Dental. Configuration, not patient data — and what makes "the
          numbers never cross" checkable rather than merely asserted. */}
      {result.config && (
        <p className="mt-1 text-xs text-muted-foreground">
          Payment types read from {RCM_OFFICE_LABELS[office]}'s Open Dental:{" "}
          {result.config.payTypes.map((p) => `${p.defNum} ${p.name}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

/** One plan, with its lines behind a disclosure. */
function PlanCard({ office, row }: { office: RcmOfficeId; row: PostingQueueRow }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<PostingQueueDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const copy = QUEUE_STATE_COPY[row.statusLabel];
  const blocked = blockedCopy(row.blockedReason);

  useEffect(() => {
    if (!open || detail || loading) return;
    setLoading(true);
    getPostingPlan(office, row.queueId)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [open, detail, loading, office, row.queueId]);

  return (
    <div
      className="rounded-xl border border-border bg-card"
      data-testid={`posting-plan-${row.queueId}`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 p-4 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={16} className="mt-1 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={16} className="mt-1 shrink-0 text-muted-foreground" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-semibold ${queueStateTone(row.statusLabel)}`}
              data-testid={`posting-state-${row.queueId}`}
            >
              {copy.label}
            </span>
            <span className="font-medium text-foreground">
              {row.payer ?? "Unknown payer"}
            </span>
            {row.checkNumber && (
              <span className="text-sm text-muted-foreground">check {row.checkNumber}</span>
            )}
            <span className="text-sm font-medium text-foreground">
              {money(row.intendedTotalCents)}
            </span>
          </div>

          <p className="mt-1 text-sm text-muted-foreground">{copy.hint}</p>

          {/* THE PROOF, on the row that claims it. A `posted` plan cannot exist
              without both halves — the database refuses — so this is a
              statement of fact rather than an optimistic label. */}
          {row.status === "posted" && row.odClaimPaymentNum && (
            <p
              className="mt-1 flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"
              data-testid={`posting-proof-${row.queueId}`}
            >
              <CheckCircle2 size={14} />
              Open Dental check <strong>#{row.odClaimPaymentNum}</strong> · verified by read-back at{" "}
              {day(row.reconciledAt)}
            </p>
          )}

          {blocked && (
            <div
              className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm dark:border-amber-900/50 dark:bg-amber-950/30"
              data-testid={`posting-blocked-${row.queueId}`}
            >
              <div className="font-medium text-amber-900 dark:text-amber-200">{blocked.label}</div>
              <p className="mt-0.5 text-amber-800 dark:text-amber-300">{blocked.fix}</p>
            </div>
          )}

          {(row.status === "failed" || row.status === "partially_posted") && row.lastError && (
            <div
              className="mt-2 flex items-start gap-1.5 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
              data-testid={`posting-error-${row.queueId}`}
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{row.lastError}</span>
            </div>
          )}

          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span>Approved {day(row.approvedAt)}</span>
            {row.attemptCount > 0 && (
              <span>
                {row.attemptCount} posting attempt{row.attemptCount === 1 ? "" : "s"}
              </span>
            )}
            {row.status === "posting" && row.step && <span>{stepCopy(row.step)}</span>}
            {row.carrierEobDate && <span>Carrier EOB date {row.carrierEobDate}</span>}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Loading lines…
            </div>
          )}
          {!loading && !detail && (
            <div className="text-sm text-muted-foreground">Could not load this plan.</div>
          )}
          {detail && <PlanLines detail={detail} />}
        </div>
      )}
    </div>
  );
}

function PlanLines({ detail }: { detail: PostingQueueDetail }) {
  return (
    <div data-testid="posting-plan-lines">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">#</th>
              <th className="pb-2 pr-3 font-medium">OD claim</th>
              <th className="pb-2 pr-3 font-medium">OD line</th>
              <th className="pb-2 pr-3 text-right font-medium">Paid</th>
              <th className="pb-2 pr-3 text-right font-medium">Write-off</th>
              <th className="pb-2 pr-3 text-right font-medium">Deductible</th>
              <th className="pb-2 pr-3 font-medium">State</th>
              <th className="pb-2 font-medium">Verified</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => (
              <tr key={line.queueLineId} className="border-t border-border/60">
                <td className="py-2 pr-3 text-muted-foreground">{line.position}</td>
                <td className="py-2 pr-3">{line.odClaimNum ?? "—"}</td>
                <td className="py-2 pr-3">{line.odClaimProcNum}</td>
                <td className="py-2 pr-3 text-right">{money(line.intendedInsPayAmtCents)}</td>
                <td className="py-2 pr-3 text-right">{money(line.intendedWriteOffCents)}</td>
                <td className="py-2 pr-3 text-right">{money(line.intendedDedAppliedCents)}</td>
                <td className="py-2 pr-3">
                  <span data-testid={`posting-line-state-${line.queueLineId}`}>
                    {LINE_STATE_COPY[line.status] ?? line.status}
                  </span>
                  {line.odClaimPaymentNum && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      check #{line.odClaimPaymentNum}
                    </span>
                  )}
                </td>
                <td className="py-2">
                  {/* The read-back verdict. `agreed: false` is a FAILURE of that
                      step whatever the HTTP status said, and the fields that
                      disagreed are named rather than summarised — "OD write
                      failed" tells nobody which number lied. */}
                  {line.readback ? (
                    line.readback.agreed ? (
                      <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 size={14} />
                        read back {day(line.readbackAt)}
                      </span>
                    ) : (
                      <span className="text-rose-700 dark:text-rose-400">
                        disagreed on{" "}
                        {(line.readback.mismatches ?? []).map((m) => m.field).join(", ") ||
                          "an unnamed field"}
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The 6d seam, said out loud. A screen that showed nothing here would
          leave a biller assuming the EOB PDF had been filed into the chart. */}
      {!detail.documentAttach.implemented && (
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="posting-document-seam"
        >
          {detail.documentAttach.note}
        </p>
      )}
    </div>
  );
}
