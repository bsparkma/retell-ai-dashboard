/**
 * /rcm — the RCM module's landing page (Slice 3).
 *
 * Deliberately thin: a heading and the numbers GET /api/rcm/summary returns,
 * one card per office in scope. No worklist, no filters, no actions — those are
 * Slices 4–7, and shipping a shell of them now would be a promise the module
 * cannot keep.
 *
 * Honest states, in the order they are checked:
 *   roster loading  → spinner (not "no offices", which reads as misconfigured)
 *   roster failed   → the roster error, with retry, distinct from empty
 *   no RCM offices  → an explicit "nothing to show" rather than zeros
 *   fetch failed    → the server's own message; MODULE_NOT_ENTITLED says so
 *   loaded          → the numbers, INCLUDING zeros — a freshly-entitled
 *                     practice legitimately has none of everything
 */
import { useEffect, useState } from "react";
import { AlertCircle, FileText, Layers, ListChecks, Loader2 } from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import EraUploadPanel from "./EraUploadPanel";
import {
  getRcmSummary,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type RcmOfficeId,
  type RcmSummary,
} from "@/features/rcm/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; summary: RcmSummary }
  | { kind: "failed"; message: string };

export default function RcmOverview() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();

  if (scope.loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" data-testid="rcm-loading">
        <Loader2 size={16} className="animate-spin" />
        Loading offices…
      </div>
    );
  }

  if (scope.error) {
    return (
      <Notice
        testId="rcm-roster-error"
        title="Could not load the office list"
        body={scope.error}
        action={
          <button
            onClick={reload}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        }
      />
    );
  }

  return (
    <div className="p-6" data-testid="rcm-overview">
      <h1 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
        Revenue Cycle
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Claims, payment batches, and the posting queue.
      </p>

      {scope.offices.length === 0 ? (
        <Notice
          testId="rcm-no-offices"
          title="No RCM offices"
          body="None of this practice's offices are set up for revenue cycle work yet."
        />
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="rcm-office-cards">
          {scope.offices.map((office) => (
            <OfficeSummaryCard key={office} office={office} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfficeSummaryCard({ office }: { office: RcmOfficeId }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getRcmSummary(office)
      .then((summary) => {
        if (!cancelled) setState({ kind: "loaded", summary });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The server's own words. A tenant without the module says exactly
        // that, rather than the page inventing "something went wrong".
        const message =
          err instanceof RcmApiError && err.notEntitled
            ? "This practice is not set up for the RCM module."
            : err instanceof Error
              ? err.message
              : "Could not load the summary.";
        setState({ kind: "failed", message });
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  return (
    <div
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid={`rcm-summary-${office}`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
        {state.kind === "loading" && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
      </div>

      {state.kind === "failed" ? (
        <div
          className="mt-4 flex items-start gap-2 text-sm text-destructive"
          data-testid={`rcm-summary-error-${office}`}
        >
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{state.message}</span>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Stat
            icon={<FileText size={14} />}
            label="Claims"
            value={state.kind === "loaded" ? state.summary.claims.total : null}
            testId={`rcm-claims-total-${office}`}
          />
          <Stat
            icon={<Layers size={14} />}
            label="Batches"
            value={state.kind === "loaded" ? state.summary.batches.total : null}
            testId={`rcm-batches-total-${office}`}
          />
          <Stat
            icon={<ListChecks size={14} />}
            label="Queue depth"
            value={state.kind === "loaded" ? state.summary.queue.depth : null}
            testId={`rcm-queue-depth-${office}`}
          />
        </div>
      )}

      {state.kind === "loaded" && state.summary.claims.byStatus.pending_review > 0 && (
        <p className="mt-4 text-sm text-muted-foreground" data-testid={`rcm-pending-${office}`}>
          {state.summary.claims.byStatus.pending_review} claim
          {state.summary.claims.byStatus.pending_review === 1 ? "" : "s"} pending review.
        </p>
      )}

      {/*
        Slice 5. Inside the office card on purpose: office is a correctness
        boundary here, and one upload control per office cannot be aimed at the
        wrong one the way a single control with a dropdown can.
      */}
      <EraUploadPanel office={office} />
    </div>
  );
}

/** One number. `null` renders an em dash — not a 0 we have not measured. */
function Stat({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  testId: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground" data-testid={testId}>
        {value === null ? "—" : value}
      </div>
    </div>
  );
}

function Notice({
  testId,
  title,
  body,
  action,
}: {
  testId: string;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center"
      data-testid={testId}
    >
      <div className="text-sm font-medium text-foreground">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
