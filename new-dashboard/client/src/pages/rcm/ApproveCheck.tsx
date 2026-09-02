/**
 * /rcm/remittances/:id/approve — "Before you say yes." (Stage C, §6)
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY APPROVING BECAME A PAGE
 * ═════════════════════════════════════════════════════════════════════════════
 * It was a panel on the check's own screen, below the claim cards, above the
 * takeback box. Everything it needed was on that page — and so was everything
 * else. The press that freezes a set of decisions and creates a posting sat in a
 * scroll position, competing for attention with a balance check, a document
 * link, a match button and thirty claim rows.
 *
 * The act deserves its own screen for one reason and it is not ceremony:
 * **nothing may post that this screen did not show**. On a page there is room to
 * show all of it — every claim's number, every write-off with its author, and
 * every condition the gate is about to apply — above the button, before the
 * press, without a scroll competing with anything else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ACT ITSELF IS UNTOUCHED
 * ─────────────────────────────────────────────────────────────────────────────
 * `POST /api/rcm/remittances/:id/approve`, the `rcm.write` tier, the gate's
 * twelve-plus conditions, the audit row, partial approve, re-approve
 * idempotency — none of it moved. This page renders the SAME
 * `getApprovalPreview` payload the panel rendered and calls the SAME
 * `approveRemittance`. What changed is the room it happens in.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE BLOCKS, IN THIS ORDER, AND THE ORDER IS THE ARGUMENT
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. THE MONEY, PER PATIENT     what each patient will owe once this posts, and
 *                                 a totals row.
 *   2. WHAT THE OFFICE ABSORBED   every write-off, with its reason and WHO
 *                                 decided it.
 *   3. WHAT THE APP CHECKED       the gate's own conditions, as sentences.
 *
 * Money first because it is what the press is about. The write-offs second
 * because they are the part a person is being asked to ACCEPT rather than to
 * verify. The machine's checks last because they are the part that does not need
 * a human at all — they either pass or they refuse, and reading them first would
 * bury the two that do.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOCK 1'S TOTALS ROW IS SUMMED FROM THE CLAIM VERDICTS. NEVER RECOMPUTED.
 * ─────────────────────────────────────────────────────────────────────────────
 * `features/rcm/rollup.ts`, and its header says why at length. In one line: a
 * second implementation of this module's money would agree with the rows above
 * it on the day it was written and diverge the first time `verdictFor` learned
 * something — on the last screen before an irreversible press.
 * `tests/rcm-rollup.test.ts` asserts the identity directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOCK 2 IS LOAD-BEARING FOR A PERMISSION DECISION, NOT DECORATION
 * ─────────────────────────────────────────────────────────────────────────────
 * A line decision runs on `rcm.queue`; approving runs on `rcm.write`. A reviewer
 * PROPOSES a write-off and somebody with write authority ACCEPTS it. That split
 * is only honest while the ACCEPTING screen shows whose decision it is and why —
 * which is why this block may never collapse into a total, and why each row
 * carries a name and an instant. (PM ruling, 2026-08-30; RCM_APPROVAL_GATE §3.5.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PAGE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * It does not post. Approving writes a posting into CareIN's own database and
 * reaches Open Dental not at all — `rcmNoOdWrites.test.js` drives this path to
 * success against a client whose every verb throws and asserts not one was
 * called. The copy says that where it matters rather than in a footnote.
 *
 * NO REAL PATIENT DATA anywhere in this file or its tests.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Loader2,
  Lock,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  approveRemittance,
  getApprovalPreview,
  getRemittance,
  isRcmOfficeId,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type ApprovalCheck,
  type ApprovalClaim,
  type ApprovalPreview,
  type ApprovalResult,
  type RcmOfficeId,
  type RemittanceDetail,
} from "@/features/rcm/api";
import { money, stamp } from "@/features/rcm/format";
import { checkDetail, checkTitle, checkWhy } from "@/features/rcm/checks";
import { decisionsWithClaim, rollUp, rollUpSentence } from "@/features/rcm/rollup";
import { officeStamp } from "@/features/rcm/time";
import { useOffice } from "@/contexts/OfficeContext";
import DisabledReason from "@/components/rcm/DisabledReason";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; preview: ApprovalPreview; detail: RemittanceDetail; office: RcmOfficeId }
  | { kind: "failed"; message: string };

export default function ApproveCheck() {
  const [, params] = useRoute("/rcm/remittances/:id/approve");
  const batchId = params?.id ?? "";
  const { office: selected } = useOffice();

  const [state, setState] = useState<State>({ kind: "loading" });
  const [approving, setApproving] = useState(false);
  const [result, setResult] = useState<ApprovalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The per-claim reasons a refusal carried, when it carried them. */
  const [refused, setRefused] = useState<ApprovalClaim[]>([]);

  /**
   * Same office resolution as the check screen: the global picker may be on
   * "All Offices", which `/api/rcm` has no query for, so each concrete office is
   * tried in roster order and a 404 under one is how the other is discovered.
   */
  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    const offices = isRcmOfficeId(selected) ? [selected] : (["roland", "valley"] as const);

    (async () => {
      let lastError: unknown = null;
      for (const office of offices) {
        try {
          /*
           * TWO READS, and both are needed.
           *
           * The gate's preview carries the verdicts and the conditions; the
           * check's own bundle carries what the CARRIER paid per claim, which
           * the preview has no field for. The roll-up's money all comes from the
           * verdicts — `paid` is context beside it, not part of the arithmetic.
           */
          const [preview, detail] = await Promise.all([
            getApprovalPreview(office, batchId),
            getRemittance(office, batchId),
          ]);
          if (!cancelled) setState({ kind: "loaded", preview, detail, office });
          return;
        } catch (err) {
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
              : "No check with that id in this practice.",
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [batchId, selected]);

  useEffect(load, [load]);

  async function onApprove() {
    if (state.kind !== "loaded") return;
    setApproving(true);
    setError(null);
    setRefused([]);
    try {
      const res = await approveRemittance(state.office, batchId);
      setResult(res);
      load();
    } catch (err) {
      setResult(null);
      if (err instanceof RcmApiError) {
        setRefused(err.refusedClaims);
        setError(
          err.approveForbidden
            ? "Approving a check needs posting permission — ask an approver to press it."
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : "The approval could not be run.");
      }
      // The gate may have refused because something changed since this page was
      // drawn. Re-reading it is how the screen stops arguing with itself.
      load();
    } finally {
      setApproving(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="approve-page-loading"
      >
        <Loader2 size={16} className="animate-spin" />
        Reading what would happen…
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="p-6" data-testid="approve-page-error">
        <BackToCheck batchId={batchId} />
        <div className="mt-4 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not open this check</div>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  const { preview: p, detail, office } = state;
  const r = detail.remittance;
  const roll = rollUp(p.claims);
  const decisions = decisionsWithClaim(p.claims);
  const verdict = rollUpSentence(roll, money);
  /** What the carrier paid, per claim, from the check's own bundle. */
  const paidByClaim = new Map(detail.claims.map((c) => [c.claimId, c.totalPaidCents]));
  /** How many claims nobody has looked for in Open Dental yet. */
  const unmatchedCount = detail.claims.filter((c) => c.odMatchStatus === "not_run").length;

  const canPress = p.canApprove && p.postableCount > 0 && p.balanced;

  return (
    <div className="p-6" data-testid="rcm-approve-check">
      <BackToCheck batchId={batchId} />

      <h1
        className="mt-4 text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        Before you say yes.
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground" data-testid="approve-page-promise">
        Everything below is what will reach Open Dental. Nothing else will.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {r.payer} · {r.paymentMethod === "eft" ? "EFT" : "check"}{" "}
        <span className="font-mono">{r.checkNumber || r.eftNumber || r.traceNumber || "—"}</span> ·{" "}
        {money(r.totalAmountCents)} · {RCM_OFFICE_LABELS[office]}
      </p>

      {/* ═══ 1. THE MONEY, PER PATIENT ═════════════════════════════════════ */}
      <section className="mt-8" data-testid="approve-rollup">
        <h2
          className="text-lg font-semibold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          What each patient will owe
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One row per claim, and a total. Every figure here is the same one the claim's own screen
          shows — this page adds them up and computes nothing of its own.
        </p>

        <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 text-left font-semibold">Patient</th>
                <th className="px-3 py-2 text-right font-semibold">Carrier paid</th>
                <th className="px-3 py-2 text-right font-semibold">Office write-off</th>
                <th className="px-3 py-2 text-right font-semibold">EOB says</th>
                <th className="px-3 py-2 text-right font-semibold">Patient will owe</th>
              </tr>
            </thead>
            <tbody>
              {roll.rows.map((row) => (
                <tr
                  key={row.claimId}
                  className="border-b border-border last:border-b-0"
                  data-testid={`approve-rollup-row-${row.claimId}`}
                >
                  <td className="px-4 py-2">
                    <div className="text-sm text-foreground">{row.patientName}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      #{row.claimNumber}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-muted-foreground">
                    {money(paidByClaim.get(row.claimId) ?? 0)}
                  </td>
                  {row.verdict ? (
                    <>
                      <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-muted-foreground">
                        {row.verdict.decidedWriteOffCents === 0
                          ? "—"
                          : money(row.verdict.decidedWriteOffCents)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-muted-foreground">
                        {money(row.verdict.eobPatientCents)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-foreground">
                        {money(row.verdict.projectedPatientCents)}
                      </td>
                    </>
                  ) : (
                    /*
                     * NOT JUDGED IS NOT ZERO. A claim whose snapshot is in an
                     * older shape carries no verdict, and printing "$0.00" for
                     * it would understate what is about to post.
                     */
                    <td
                      className="px-3 py-2 text-right text-xs text-amber-800 dark:text-amber-300"
                      colSpan={3}
                      data-testid={`approve-rollup-unjudged-${row.claimId}`}
                    >
                      Not judged — open the claim and match it up again
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/30" data-testid="approve-rollup-total">
                <td className="px-4 py-2 text-sm font-semibold text-foreground">
                  {roll.judged} of {roll.rows.length} claim{roll.rows.length === 1 ? "" : "s"}
                </td>
                <td className="px-3 py-2" />
                <td
                  className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-foreground"
                  data-testid="approve-total-writeoff"
                >
                  {roll.decidedWriteOffCents === 0 ? "—" : money(roll.decidedWriteOffCents)}
                </td>
                <td
                  className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-foreground"
                  data-testid="approve-total-eob"
                >
                  {money(roll.eobPatientCents)}
                </td>
                <td
                  className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-foreground"
                  data-testid="approve-total-projected"
                >
                  {money(roll.projectedPatientCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {roll.unjudged > 0 && (
          <p
            className="mt-2 text-xs text-amber-800 dark:text-amber-300"
            data-testid="approve-unjudged-note"
          >
            {roll.unjudged} claim{roll.unjudged === 1 ? "" : "s"} on this check carr
            {roll.unjudged === 1 ? "ies" : "y"} no patient-responsibility verdict and contribute
            {roll.unjudged === 1 ? "s" : ""} nothing to the total above. That is a gap in the
            total, not a zero.
          </p>
        )}
      </section>

      {/* ═══ 2. WHAT THE OFFICE ABSORBED ═══════════════════════════════════ */}
      <section className="mt-8" data-testid="approve-decisions">
        <h2
          className="text-lg font-semibold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          The lines the office chose to absorb
        </h2>

        {decisions.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="approve-decisions-none">
            None. Every patient on this check is being billed exactly what the EOB says they owe.
          </p>
        ) : (
          <>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Each of these is money this practice is choosing not to collect. Whoever recorded the
              decision is named beside it, because pressing the button below is accepting their
              judgement as well as your own.
            </p>
            <div className="mt-3 overflow-x-auto rounded-xl border border-amber-200 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/15">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-amber-200 text-xs uppercase tracking-wide text-muted-foreground dark:border-amber-900/60">
                    <th className="px-4 py-2 text-left font-semibold">Patient</th>
                    <th className="px-3 py-2 text-left font-semibold">Line</th>
                    <th className="px-3 py-2 text-right font-semibold">Amount</th>
                    <th className="px-3 py-2 text-left font-semibold">Reason</th>
                    <th className="px-3 py-2 text-left font-semibold">Decided by</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d, i) => (
                    <tr
                      key={`${d.claimNumber}-${d.decision.lineId ?? i}`}
                      className="border-b border-amber-200/60 last:border-b-0 dark:border-amber-900/40"
                      data-testid={`approve-decision-${d.decision.lineId ?? i}`}
                    >
                      <td className="px-4 py-2 text-sm text-foreground">{d.patientName}</td>
                      <td className="px-3 py-2 font-mono text-sm text-foreground">
                        {d.decision.code}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-foreground">
                        {money(d.decision.amountCents)}
                      </td>
                      <td className="px-3 py-2 text-sm text-foreground">
                        {/* The server's own label for the slug. A reason it
                            cannot label renders as the slug, which is a bug
                            report rather than a bug nobody notices. */}
                        {d.decision.reasonLabel ?? d.decision.reason ?? (
                          <span className="text-rose-700 dark:text-rose-400">
                            nothing recorded
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {/*
                          A NAME AND AN INSTANT. This is the half that makes the
                          reviewer/approver split honest — see the header.
                        */}
                        {d.decision.decidedBy ?? "not recorded"}
                        {d.decision.decidedAt
                          ? ` · ${officeStamp(d.decision.decidedAt, office)}`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground" data-testid="approve-freeze-note">
              Approving is what freezes these decisions — up until then any of them can be changed
              on the claim's own screen. Afterwards a correction is a job for Open Dental.
            </p>
          </>
        )}
      </section>

      {/* ═══ 3. WHAT THE APP CHECKED ═══════════════════════════════════════ */}
      <section className="mt-8" data-testid="approve-checks">
        <h2
          className="text-lg font-semibold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          What the app checked
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every condition, per claim, run before anything is pressed — so a claim that will be held
          back is one you can go and fix rather than one you discover by pressing a button.
        </p>

        {/*
          RUN THE MATCH FIRST — §15.2's third finding.
          On a fresh check most of the ✗ marks below clear on one press, and the
          walk showed somebody reading all of them before finding it. One line,
          only while it is true, with the way to it in it.

          It LINKS rather than acting: Match all claims lives on the check, and a
          second control that ran the same Open Dental-heavy sweep from a second
          page is exactly the duplication this stage is removing.
        */}
        {unmatchedCount > 0 && (
          <div
            className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-sm"
            data-testid="approval-match-first"
          >
            <span className="text-foreground">
              <strong className="font-semibold">Match it up first</strong> — most of these clear on
              their own. {unmatchedCount} claim{unmatchedCount === 1 ? " has" : "s have"} not been
              looked for in Open Dental yet.
            </span>
            <Link
              href={`/rcm/remittances/${encodeURIComponent(batchId)}`}
              data-testid="approval-run-match"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              Match all claims on the check
              <ChevronRight size={11} />
            </Link>
          </div>
        )}

        <div className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
          {p.claims.map((claim) => (
            <ClaimChecklist key={claim.claimId} claim={claim} batchId={batchId} />
          ))}
        </div>
      </section>

      {/* ═══ THE VERDICT, THE BUTTON, AND THE LAST WORD ════════════════════ */}
      <section className="mt-8 rounded-xl border-2 border-border bg-card p-5" data-testid="approve-decide">
        <p
          className={`text-base font-medium ${
            verdict.canApprove ? "text-foreground" : "text-rose-700 dark:text-rose-400"
          }`}
          data-testid="approve-verdict-sentence"
        >
          {verdict.sentence}
        </p>
        {/* THE REGISTER, SAID OUT LOUD. Before a post this is a PROJECTION and
            may never wear a confirmation's words. See `rollUpSentence`. */}
        <p className="mt-1 text-xs text-muted-foreground" data-testid="approve-verdict-register">
          That is what this check says will happen. It becomes a measured figure only after the
          money is in Open Dental and CareIN has asked the chart what the patient owes.
        </p>

        <p className="mt-3 text-sm text-muted-foreground" data-testid="approve-counts">
          {p.postableCount} of {p.claims.length} claim{p.claims.length === 1 ? "" : "s"} can be
          approved
          {p.withheldCount > 0 ? ` · ${p.withheldCount} not ready yet` : ""}
          {p.queuedCount > 0 ? ` · ${p.queuedCount} already approved` : ""}
        </p>

        {error && (
          <div
            className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
            data-testid="approve-error"
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div>
              <div>{error}</div>
              {refused.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {refused
                    .filter((c) => !c.postable)
                    .map((c) => (
                      <li key={c.claimId}>
                        {c.patientName} · #{c.claimNumber} —{" "}
                        {c.alreadyQueued ? "already approved" : c.failed.join(", ")}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {result && (
          <div
            className="mt-3 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm dark:border-emerald-900 dark:bg-emerald-950/20"
            data-testid="approve-result"
          >
            <div className="flex items-center gap-2 font-medium text-foreground">
              <Check size={15} className="text-emerald-600 dark:text-emerald-400" />
              {result.queued.length} claim{result.queued.length === 1 ? "" : "s"} approved —{" "}
              {money(result.intendedTotalCents)}
            </div>
            {/* THE SERVER'S OWN SENTENCE, not a paraphrase of it. It is exactly
                true today and the place that changes it should be the place that
                knows. */}
            <p className="mt-1 text-xs text-muted-foreground" data-testid="approve-honest-state">
              {result.note}
            </p>
            {/*
              PARTIAL SUCCESS IS REAL SUCCESS — and the half that did NOT go is
              named, per claim, with every condition that stopped it. A result
              that reported only the queued half would make a nine-of-ten
              approve look like a ten-of-ten one.
            */}
            {result.withheld.length > 0 && (
              <div className="mt-3" data-testid="approve-withheld">
                <div className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  Not ready yet — {result.withheld.length} claim
                  {result.withheld.length === 1 ? " was" : "s were"} left off
                </div>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {result.withheld.map((w) => (
                    <li key={w.claimId}>
                      <span className="text-foreground">{w.patientName}</span> · #{w.claimNumber}
                      <ul className="ml-3 list-disc">
                        {w.checks
                          .filter((c) => !c.passed)
                          .map((c) => (
                            <li key={c.code}>
                              {c.label}
                              {c.detail ? ` — ${c.detail}` : ""}
                            </li>
                          ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/*
              A PERSON'S NAME, NOT AN ADDRESS — and the SERVER says so now.

              C-3 resolved this in the browser, because the route returned the
              crosswalk key (an email, for anyone the platform minted a row for)
              and the only case a client could answer honestly was the signed-in
              person's own. C-3b item 2 moved it to where it belongs: `/approve`
              runs `describeActors` like every other attributed field in the
              module, so `approvedBy` arrives already spelled the way a person
              says it — for colleagues too, not just for whoever is looking.

              So this prints what the server sent. `personName` is deliberately
              NOT called here any more; it stays in format.ts for the responses
              that still send a key.
            */}
            <p className="mt-1 text-xs text-muted-foreground" data-testid="approve-attribution">
              Approved by {result.approvedBy} · {stamp(new Date().toISOString())}
            </p>
            <Link
              href={`/rcm/remittances/${encodeURIComponent(batchId)}`}
              data-testid="approve-back-after"
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
            >
              Back to the check
              <ChevronRight size={13} />
            </Link>
          </div>
        )}

        {!result && (
          <div className="mt-4 flex flex-col items-start gap-1">
            <button
              onClick={onApprove}
              disabled={!canPress || approving}
              data-testid="approve-button"
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
                canPress
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "cursor-not-allowed bg-foreground/10 text-muted-foreground"
              } disabled:opacity-60`}
            >
              {approving ? (
                <Loader2 size={15} className="animate-spin" />
              ) : p.canApprove ? (
                <ShieldCheck size={15} />
              ) : (
                <Lock size={15} />
              )}
              {approving
                ? "Approving…"
                : p.postableCount > 0
                  ? `Yes — approve ${p.postableCount} claim${p.postableCount === 1 ? "" : "s"}`
                  : "Approve this check"}
            </button>

            {/* WHY IT CANNOT BE PRESSED — always, specifically, and RENDERED
                rather than hovered: the practice reads these screens on a tablet
                at the front desk, where there is no hover. */}
            {!p.canApprove ? (
              <DisabledReason testId="approve-needs-permission">
                Approving needs posting permission ({p.approveRequires}). Ask an approver to press
                it — they will see this same page.
              </DisabledReason>
            ) : !p.balanced ? (
              <DisabledReason tone="warn" testId="approve-unbalanced">
                This check does not balance — {money(p.differenceCents)} unaccounted. Nothing on it
                can be approved until that is sorted out.
              </DisabledReason>
            ) : p.postableCount === 0 ? (
              <DisabledReason testId="approve-nothing-postable">
                Nothing on this check can be approved yet — the list above says what each claim is
                waiting for.
              </DisabledReason>
            ) : approving ? (
              <DisabledReason testId="approve-in-flight">
                Approving — this lines the check up to post; it writes no chart note.
              </DisabledReason>
            ) : (
              <span className="text-xs text-muted-foreground">
                Lines this check up to post. Nothing reaches Open Dental until somebody presses
                Post to Open Dental on the check itself.
              </span>
            )}

            <p className="mt-3 text-sm font-medium text-foreground" data-testid="approve-last-moment">
              This is the last moment anything can be changed.
            </p>
            <Link
              href={`/rcm/remittances/${encodeURIComponent(batchId)}`}
              data-testid="approve-go-back"
              className="text-sm text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Take me back to the check without approving
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

function BackToCheck({ batchId }: { batchId: string }) {
  return (
    <Link
      href={`/rcm/remittances/${encodeURIComponent(batchId)}`}
      data-testid="approve-back-to-check"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft size={14} />
      Back to the check
    </Link>
  );
}

/**
 * One claim's conditions.
 *
 * Open by default when the claim is NOT postable — the whole point is that a
 * refusal is visible before the press rather than after it — and closed when it
 * is, so a clean check of twelve claims is a page rather than a scroll.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * OPEN SHOWS WHAT FAILED. IT DOES NOT SHOW THIRTEEN GREEN TICKS — C-3, item 5
 * ═════════════════════════════════════════════════════════════════════════════
 * Three not-ready claims on one check rendered three near-identical thirteen-row
 * lists, twelve of whose rows were green on all three. A twelve-patient Delta
 * check would be a hundred and fifty lines of confirmation wrapped around the
 * handful of sentences that are the reason anybody opened it.
 *
 * A refusal has to be visible; a pass does not have to be enumerated. So an open
 * NOT-READY claim shows the failing conditions and one line saying how many
 * passed — and that line opens the passing ones, because "what else did it
 * check" is a fair question with an answer and the answer is right there.
 *
 * NOTHING IS FILTERED OUT. An `alreadyQueued` claim and a `postable` one still
 * list every condition when opened: on those two there is no failure to lead
 * with, and the full list IS the content.
 */
function ClaimChecklist({ claim, batchId }: { claim: ApprovalClaim; batchId: string }) {
  const [open, setOpen] = useState(!claim.postable && !claim.alreadyQueued);
  /** Has she asked to see the ones that passed? Only ever on a not-ready claim. */
  const [showPassed, setShowPassed] = useState(false);
  const failed = claim.checks.filter((c) => !c.passed);
  const passed = claim.checks.filter((c) => c.passed);
  /*
   * The only case with a failure worth leading with. A postable or already
   * approved claim has none, so it keeps the full list exactly as it was.
   */
  const leadWithFailures = !claim.postable && !claim.alreadyQueued && failed.length > 0;

  return (
    <div className="px-4 py-3" data-testid={`approval-claim-${claim.claimId}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
        data-testid={`approval-toggle-${claim.claimId}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            size={13}
            className={open ? "rotate-90 transition-transform" : "transition-transform"}
          />
          <span className="truncate text-sm font-medium text-foreground">{claim.patientName}</span>
          <span className="font-mono text-xs text-muted-foreground">#{claim.claimNumber}</span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            claim.alreadyQueued
              ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
              : claim.postable
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
          }`}
          data-testid={`approval-state-${claim.claimId}`}
        >
          {claim.alreadyQueued
            ? "Approved"
            : claim.postable
              ? "Ready to post"
              : `Not ready yet · ${failed.length} check${failed.length === 1 ? "" : "s"} did not pass`}
        </span>
      </button>

      {open && (
        <>
          <ul className="mt-2 space-y-1.5" data-testid={`approval-checks-${claim.claimId}`}>
            {(leadWithFailures ? failed : claim.checks).map((check) => (
              <CheckRow key={check.code} check={check} />
            ))}
          </ul>

          {/*
            THE ONE LINE THAT STANDS IN FOR THE GREEN ONES.
            A button, not a sentence: the facts stay one click away rather than
            being asserted and then hidden. Absent when nothing passed, because
            "0 checks passed" is a sentence nobody needs under a list of the
            failures that are all of them.
          */}
          {leadWithFailures && passed.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowPassed((v) => !v)}
                data-testid={`approval-passed-toggle-${claim.claimId}`}
                aria-expanded={showPassed}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                <Check size={12} className="text-emerald-600 dark:text-emerald-400" />
                {passed.length} check{passed.length === 1 ? "" : "s"} passed
              </button>
              {showPassed && (
                <ul
                  className="mt-1.5 space-y-1.5"
                  data-testid={`approval-passed-${claim.claimId}`}
                >
                  {passed.map((check) => (
                    <CheckRow key={check.code} check={check} />
                  ))}
                </ul>
              )}
            </div>
          )}

          {!claim.postable && !claim.alreadyQueued && (
            <Link
              href={`/rcm/claims/${encodeURIComponent(claim.claimId)}?from=${encodeURIComponent(batchId)}`}
              data-testid={`approval-fix-${claim.claimId}`}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-4"
            >
              Open this claim and fix it
              <ChevronRight size={11} />
            </Link>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One condition, in biller language, with its evidence inline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PASS DETAIL IS NEVER THE FAILURE TEXT
 * ─────────────────────────────────────────────────────────────────────────────
 * The gate builds some details from a ternary chain evaluated either way, so a
 * PASSING check once rendered with a green tick beside the sentence "the
 * confirmed claim is not among the candidates the match recorded" — §15.2's copy
 * bug. `features/rcm/checks.ts` owns three strings keyed off the machine slug: a
 * plain title, a verb-first instruction on failure, and a short confirmation on
 * a pass that comes from a DIFFERENT FIELD than the failure text, so the two can
 * never be the same string again.
 */
function CheckRow({ check }: { check: ApprovalCheck }) {
  const why = checkWhy(check);
  return (
    <li className="flex items-start gap-2 text-xs" data-testid={`check-${check.code}`}>
      {check.passed ? (
        <Check size={13} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <X size={13} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <div className={check.passed ? "text-muted-foreground" : "text-foreground"}>
        <span className={check.passed ? "" : "font-medium"}>{checkTitle(check)}</span>
        <span className="text-muted-foreground" data-testid={`check-detail-${check.code}`}>
          {" — "}
          {checkDetail(check)}
        </span>
        {!check.passed &&
          (why || check.code === "NOT_REVERSAL" || check.code === "NOT_RECOUPMENT") && (
            <p className="mt-0.5 text-muted-foreground" data-testid={`check-fix-${check.code}`}>
              {/* The specific number or reason the gate recorded. Failures only —
                  this is the field that carried the copy bug. */}
              {why && <span data-testid={`check-why-${check.code}`}>{why}. </span>}
              {check.code === "NOT_REVERSAL" || check.code === "NOT_RECOUPMENT" ? (
                <Link
                  href="/rcm/sop/takeback"
                  className="underline underline-offset-2 hover:text-foreground"
                  data-testid={`check-sop-${check.code}`}
                >
                  The takeback procedure
                </Link>
              ) : null}
            </p>
          )}
      </div>
    </li>
  );
}
