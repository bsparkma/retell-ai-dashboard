/**
 * /rcm/remittances/:id — one carrier payment, in full (Slice 6a).
 *
 * The header, the balance check, a link back to the source document, and the
 * claims table: per claim, what the carrier said, every flag as a chip, the
 * CARC/RARC codes with their plain-English meanings, and the match state.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE FLAGS FINALLY GET SEEN
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 4's low-confidence flags and Slice 5's malformed-CAS, downcode and
 * reversal flags have been written to `needs_review_reasons` and rendered
 * nowhere. They are first-class here. A reversal is shown clearly and linked to
 * the manual SOP — detect-and-flag means exactly that, and inventing an action
 * for one would be worse than admitting there is none.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE APPROVE BUTTON IS PRESENT AND DISABLED
 * ─────────────────────────────────────────────────────────────────────────────
 * Deliberately, so the layout is right when Slice 6b lands and so nobody builds
 * a habit around a button that will move. There is no endpoint behind it, and
 * `rcmNoOdWrites.test.js` asserts there is none to find.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  getRemittance,
  matchRemittance,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type BatchMatchResponse,
  type RemittanceClaim,
  type RemittanceDetail as RemittanceDetailPayload,
} from "@/features/rcm/api";
import { isRcmOfficeId } from "@/features/rcm/api";
import {
  batchStatusLabel,
  batchStatusTone,
  day,
  lineFlagLabel,
  lineFlagTone,
  MATCH_STATUS_LABELS,
  MATCH_STATUS_TONE,
  money,
  NO_ACTION_REASONS,
  reviewReasonLabel,
  SOURCE_LABELS,
  SOURCE_TITLES,
  stamp,
} from "@/features/rcm/format";
import { useOffice } from "@/contexts/OfficeContext";

export default function RemittanceDetailPage() {
  const [, params] = useRoute("/rcm/remittances/:id");
  const batchId = params?.id ?? "";
  const { office: selected } = useOffice();

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; data: RemittanceDetailPayload }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const [matching, setMatching] = useState(false);
  const [matchResult, setMatchResult] = useState<BatchMatchResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /**
   * Which office's remittance this is.
   *
   * The global picker may be on "All Offices", which /api/rcm has no query for.
   * Rather than guess, the page tries the selected office and — since a batch id
   * is only ever found under its own office — a 404 there means "not this one".
   * Both concrete offices are tried in roster order, which is why the id alone
   * is enough for a shareable link.
   */
  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    const offices = isRcmOfficeId(selected) ? [selected] : (["roland", "valley"] as const);

    (async () => {
      let lastError: unknown = null;
      for (const office of offices) {
        try {
          const data = await getRemittance(office, batchId);
          if (!cancelled) setState({ kind: "loaded", data });
          return;
        } catch (err) {
          // A 404 under one office is the normal way to discover it belongs to
          // the other; anything else is a real failure worth reporting.
          if (err instanceof RcmApiError && err.status === 404) continue;
          lastError = err;
          break;
        }
      }
      if (cancelled) return;
      setState({
        kind: "failed",
        message:
          lastError instanceof RcmApiError && lastError.notEntitled
            ? "This practice is not set up for the RCM module."
            : lastError instanceof Error
              ? lastError.message
              : "No remittance with that id in this practice.",
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [batchId, selected]);

  useEffect(load, [load]);

  /**
   * Clear the batch-match summary when the page moves to a DIFFERENT
   * remittance — and only then.
   *
   * Deliberately not inside `load`: a batch match re-loads the page to pick up
   * the new match states, and clearing there would erase the very summary the
   * user just asked for, milliseconds after it appeared. That is the same class
   * of failure as the EOB panel's "Extracting" chip — a screen that stops
   * telling you something it still knows.
   */
  useEffect(() => setMatchResult(null), [batchId]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" data-testid="remittance-loading">
        <Loader2 size={16} className="animate-spin" />
        Loading remittance…
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="p-6" data-testid="remittance-error">
        <BackLink />
        <div className="mt-4 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not open this remittance</div>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  const { remittance: r, claims, office } = state.data;

  async function runBatchMatch() {
    setMatching(true);
    try {
      const result = await matchRemittance(office, r.batchId);
      setMatchResult(result);
      load();
    } catch (err) {
      setMatchResult(null);
      setState({
        kind: "failed",
        message: err instanceof Error ? err.message : "The match could not be run.",
      });
    } finally {
      setMatching(false);
    }
  }

  return (
    <div className="p-6" data-testid="rcm-remittance-detail">
      <BackLink />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="text-2xl font-bold tracking-tight text-foreground"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              {r.payer}
            </h1>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${batchStatusTone(r.status)}`}
              data-testid="remittance-status"
            >
              {batchStatusLabel(r.status)}
            </span>
            {r.source && (
              <span
                title={SOURCE_TITLES[r.source]}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {SOURCE_LABELS[r.source]}
              </span>
            )}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {RCM_OFFICE_LABELS[office]}
            </span>
          </div>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {r.paymentMethod === "eft" ? "EFT" : "Check"}{" "}
            {r.checkNumber || r.eftNumber || r.traceNumber || "—"} · {day(r.depositDate)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runBatchMatch}
            disabled={matching}
            data-testid="match-all-claims"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            {matching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {matching ? "Matching…" : "Match all claims"}
          </button>

          {/*
            SLICE 6b LIVES HERE. Present and disabled so the layout is right when
            approval lands, and so the copy states plainly why it cannot be
            pressed rather than leaving a dead control to be discovered.
          */}
          <button
            disabled
            data-testid="approve-disabled"
            title="Posting arrives in the next release. Nothing on this screen writes to a patient's chart."
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md bg-foreground/10 px-3 py-1.5 text-sm font-medium text-muted-foreground"
          >
            <ShieldCheck size={14} />
            Approve for posting
          </button>
        </div>
      </div>

      <p className="mt-1 text-xs text-muted-foreground" data-testid="approve-note">
        Posting arrives in the next release — nothing on this screen writes to a patient's chart.
      </p>

      {/* ── The balance check ──────────────────────────────────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Check total" value={money(r.totalAmountCents)} testId="stat-check-total" />
        <Stat
          label="Sum of claim payments"
          value={money(r.balance.claimTotalCents)}
          testId="stat-claim-total"
        />
        {r.plbTotalCents !== 0 && (
          <Stat
            label="Provider-level (PLB)"
            value={money(r.plbTotalCents)}
            testId="stat-plb"
            hint="Money moved at the provider level, belonging to no single claim. It is why a check total can legitimately differ from the sum of its claims."
          />
        )}
        <div
          className={`rounded-xl border p-4 ${
            r.balance.balanced
              ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20"
              : "border-rose-200 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20"
          }`}
          data-testid="balance-check"
        >
          <div className="text-xs font-medium text-muted-foreground">Balance check</div>
          <div
            className={`mt-1 text-lg font-semibold ${
              r.balance.balanced
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400"
            }`}
          >
            {r.balance.balanced ? "Balances" : `${money(r.balance.differenceCents)} unaccounted`}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Check total {r.plbTotalCents !== 0 ? "− PLB " : ""}= sum of claim payments
          </p>
        </div>
      </div>

      {/* ── The source document ────────────────────────────────────────────── */}
      {r.upload && (
        <div
          className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-4 py-3 text-sm"
          data-testid="source-document"
        >
          <a
            href={r.upload.documentUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <ExternalLink size={14} />
            {r.upload.filename}
          </a>
          <span className="text-xs text-muted-foreground">
            Uploaded {stamp(r.upload.uploadedAt)}
            {" by "}
            {/* Null is "not recorded", never "the system did it" — rows uploaded
                before the staff crosswalk existed genuinely have no name. */}
            {r.upload.uploadedBy ?? <em className="not-italic text-muted-foreground/70">not recorded</em>}
          </span>
        </div>
      )}

      {/* ── What a batch match just did ────────────────────────────────────── */}
      {matchResult && (
        <div
          className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-sm"
          data-testid="batch-match-result"
        >
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Info size={14} />
            Matched {matchResult.matched.length} claim
            {matchResult.matched.length === 1 ? "" : "s"} against Open Dental
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {matchResult.matched.map((row) => (
              <li key={row.claimId}>
                {row.status === "failed"
                  ? `A claim could not be matched: ${row.error}`
                  : row.status === "already_confirmed"
                    ? "One claim was already confirmed and was left alone."
                    : row.status === "no_candidate"
                      ? "One claim has no matching claim in Open Dental."
                      : `${row.candidateCount} candidate${row.candidateCount === 1 ? "" : "s"}${row.ambiguous ? " — too close to call, needs a person" : ""}`}
              </li>
            ))}
            {matchResult.note && <li className="text-amber-700 dark:text-amber-400">{matchResult.note}</li>}
          </ul>
        </div>
      )}

      {/* ── Claims ─────────────────────────────────────────────────────────── */}
      <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
        Claims
      </h2>

      {claims.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          This remittance carries no claims.
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {claims.map((claim) => (
            <ClaimCard
              key={claim.claimId}
              claim={claim}
              open={expanded.has(claim.claimId)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(claim.claimId)) next.delete(claim.claimId);
                  else next.add(claim.claimId);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/rcm/remittances"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft size={14} />
      All remittances
    </Link>
  );
}

function Stat({
  label,
  value,
  testId,
  hint,
}: {
  label: string;
  value: string;
  testId: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4" title={hint}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function ClaimCard({
  claim,
  open,
  onToggle,
}: {
  claim: RemittanceClaim;
  open: boolean;
  onToggle: () => void;
}) {
  const deadEnd = claim.needsReviewReasons.some((r) => NO_ACTION_REASONS.has(r));

  return (
    <div className="rounded-xl border border-border bg-card" data-testid={`claim-card-${claim.claimId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{claim.patientName}</span>
            <span className="font-mono text-xs text-muted-foreground">#{claim.claimNumber}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_STATUS_TONE[claim.odMatchStatus]}`}
              data-testid={`claim-match-state-${claim.claimId}`}
            >
              {MATCH_STATUS_LABELS[claim.odMatchStatus]}
              {claim.odClaimNum ? ` · ClaimNum ${claim.odClaimNum}` : ""}
            </span>
            {claim.reviewedAt && (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                Reviewed
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Service {day(claim.serviceDate)} · {claim.insuranceType}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {money(claim.totalPaidCents)}
            </div>
            <div className="font-mono text-xs tabular-nums text-muted-foreground">
              of {money(claim.totalBilledCents)} billed
            </div>
          </div>
          <Link
            href={`/rcm/claims/${claim.claimId}`}
            data-testid={`open-claim-${claim.claimId}`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Match
            <ChevronRight size={12} />
          </Link>
        </div>
      </div>

      {/* Review reasons — the flags Slices 4 and 5 wrote and nothing rendered. */}
      {claim.needsReviewReasons.length > 0 && (
        <div className="border-t border-border px-4 py-3" data-testid={`claim-flags-${claim.claimId}`}>
          <div className="flex flex-wrap gap-1.5">
            {claim.needsReviewReasons.map((reason) => (
              <span
                key={reason}
                className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              >
                <AlertTriangle size={11} />
                {reviewReasonLabel(reason)}
              </span>
            ))}
          </div>
          {deadEnd && (
            // Detect-and-flag means exactly that. A recoupment is the single
            // IRREVERSIBLE Open Dental operation, so there is no action offered
            // here — only an honest statement and the manual route.
            <p
              className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
              data-testid={`claim-no-action-${claim.claimId}`}
            >
              <CircleSlash size={12} className="mt-0.5 shrink-0" />
              <span>
                CareIN will not post this. A recoupment cannot be reversed in Open Dental once it is
                written — handle it in Open Dental directly, following the practice's takeback
                procedure.
              </span>
            </p>
          )}
        </div>
      )}

      <button
        onClick={onToggle}
        data-testid={`toggle-lines-${claim.claimId}`}
        className="flex w-full items-center gap-1.5 border-t border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40"
      >
        <ChevronRight size={12} className={open ? "rotate-90 transition-transform" : "transition-transform"} />
        {open ? "Hide" : "Show"} {claim.lines.length} procedure line
        {claim.lines.length === 1 ? "" : "s"}
      </button>

      {open && <LineTable claim={claim} />}
    </div>
  );
}

function LineTable({ claim }: { claim: RemittanceClaim }) {
  return (
    <div className="overflow-x-auto border-t border-border" data-testid={`lines-${claim.claimId}`}>
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 text-left font-semibold">Code</th>
            <th className="px-2 py-2 text-right font-semibold">Billed</th>
            <th className="px-2 py-2 text-right font-semibold">Allowed</th>
            <th className="px-2 py-2 text-right font-semibold">Paid</th>
            <th className="px-2 py-2 text-right font-semibold">Write-off</th>
            <th className="px-2 py-2 text-right font-semibold">Pt resp.</th>
            <th className="px-4 py-2 text-left font-semibold">Adjustments</th>
          </tr>
        </thead>
        <tbody>
          {claim.lines.map((line) => (
            <tr key={line.lineId} className="border-b border-border last:border-b-0 align-top">
              <td className="px-4 py-2">
                <div className="font-mono text-sm text-foreground">{line.billedCode}</div>
                {/* A downcode keeps BOTH codes: the carrier adjudicated one and
                    the chart carries the other, and the difference is the money. */}
                {line.paidCode && line.paidCode !== line.billedCode && (
                  <div className="font-mono text-xs text-amber-700 dark:text-amber-400">
                    submitted as {line.paidCode}
                  </div>
                )}
                {line.description && (
                  <div className="max-w-[16rem] text-xs text-muted-foreground">{line.description}</div>
                )}
                {line.flags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {line.flags.map((flag) => (
                      <span
                        key={flag}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${lineFlagTone(flag)}`}
                      >
                        {lineFlagLabel(flag)}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.billedCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.allowedCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs font-semibold tabular-nums text-foreground">
                {money(line.paidCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.writeOffCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.patientRespCents)}
              </td>
              <td className="px-4 py-2">
                {line.adjustments.length === 0 ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  <ul className="space-y-1">
                    {line.adjustments.map((adj) => (
                      <li key={adj.adjustmentId} className="text-xs">
                        <span
                          className="font-mono font-medium text-foreground"
                          title={adj.groupDescription ?? undefined}
                        >
                          {adj.groupCode}-{adj.reasonCode}
                        </span>{" "}
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {money(adj.amountCents)}
                        </span>
                        {/* Null description = a code not in the published list.
                            Rendered bare rather than glossed with a guess. */}
                        {adj.reasonDescription && (
                          <div className="text-muted-foreground">{adj.reasonDescription}</div>
                        )}
                        {adj.remarkCode && (
                          <div className="text-muted-foreground">
                            <span className="font-mono">{adj.remarkCode}</span>
                            {adj.remarkDescription ? ` — ${adj.remarkDescription}` : ""}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {line.adjustmentReason && (
                  <div className="mt-1 text-xs italic text-muted-foreground">{line.adjustmentReason}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
