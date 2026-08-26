/**
 * The approval gate, on the remittance screen (Slice 6b).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHECKLIST COMES BEFORE THE BUTTON, NOT AFTER IT
 * ─────────────────────────────────────────────────────────────────────────────
 * Every condition, per claim, with pass/fail and what to do about a failure —
 * rendered as soon as the remittance opens, without anything being pressed. A
 * biller should be able to see that a claim will be withheld and go fix it
 * (confirm the match, review it, route the reversal to the SOP) rather than
 * pressing a button to find out. Pressing a button to discover a refusal is how
 * people learn to press buttons hopefully.
 *
 * The checklist and the button run the SAME server-side evaluation, so the
 * screen cannot predict an outcome the button then contradicts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "QUEUED" MEANS, IN THE WORDS THE SERVER USES
 * ─────────────────────────────────────────────────────────────────────────────
 * Approving writes a plan to CareIN's own database. Until Slice 6c ships,
 * nothing has been written to Open Dental — and the copy says exactly that,
 * taken from the server's own `note` rather than restated here, so the sentence
 * changes on the day it stops being true.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE READ TIER SEES THE SAME THING
 * ─────────────────────────────────────────────────────────────────────────────
 * A `reviewer` (D-9) gets the identical checklist and a disabled button that
 * names the permission an approver holds. Seeing why a claim is withheld is not
 * a posting act, and the person who did the reviewing is the one best placed to
 * fix what she is looking at.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
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
  RcmApiError,
  type ApprovalCheck,
  type ApprovalClaim,
  type ApprovalPreview,
  type ApprovalResult,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { money, stamp } from "@/features/rcm/format";
import { checkDetail, checkTitle, checkWhy } from "@/features/rcm/checks";
import DisabledReason from "@/components/rcm/DisabledReason";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; preview: ApprovalPreview }
  | { kind: "failed"; message: string };

export default function ApprovalPanel({
  office,
  batchId,
  onApproved,
  unmatchedCount = 0,
  onRunMatch,
}: {
  office: RcmOfficeId;
  batchId: string;
  /** Re-load the remittance so the claim cards pick up their new state. */
  onApproved: () => void;
  /**
   * How many claims on this check have never been matched.
   *
   * Drives the one-line banner at the top of the checklist. §15.2's third
   * finding: a fresh remittance shows a wall of ✗ and the thing that clears
   * most of them is a button somewhere else on the page. Saying so in one line
   * costs nothing and keeps the page the length it already is — the alternative
   * was moving the match section above the gate, which would have pushed the
   * checklist further from the button it explains.
   */
  unmatchedCount?: number;
  /** Run the batch match from the banner, so the fix is where the problem is. */
  onRunMatch?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [approving, setApproving] = useState(false);
  const [result, setResult] = useState<ApprovalResult | null>(null);
  /**
   * A failed APPROVE must not replace the checklist.
   *
   * The same rule the batch match learned: an inline notice keeps the data on
   * screen and the mistake un-invited. A refusal here is usually the gate
   * working, and the checklist is precisely what explains it.
   */
  const [error, setError] = useState<string | null>(null);
  /** The per-claim reasons a refusal carried, when it carried them. */
  const [refused, setRefused] = useState<ApprovalClaim[]>([]);

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getApprovalPreview(office, batchId)
      .then((preview) => {
        if (!cancelled) setState({ kind: "loaded", preview });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "failed",
          message:
            err instanceof Error ? err.message : "The approval checklist could not be loaded.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [office, batchId]);

  useEffect(load, [load]);

  async function onApprove() {
    setApproving(true);
    setError(null);
    setRefused([]);
    try {
      const res = await approveRemittance(office, batchId);
      setResult(res);
      load();
      onApproved();
    } catch (err) {
      setResult(null);
      if (err instanceof RcmApiError) {
        setRefused(err.refusedClaims);
        setError(
          err.approveForbidden
            ? "Approving a remittance for posting needs posting permission — ask an approver to press it."
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : "The approval could not be run.");
      }
      // The gate may have refused because something changed since the checklist
      // was drawn. Re-reading it is how the screen stops arguing with itself.
      load();
    } finally {
      setApproving(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <section
        className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="approval-loading"
      >
        <Loader2 size={14} className="animate-spin" />
        Checking what can be posted…
      </section>
    );
  }

  if (state.kind === "failed") {
    return (
      <section
        className="mt-6 rounded-xl border border-border bg-card p-4 text-sm"
        data-testid="approval-failed"
      >
        <div className="flex items-start gap-2 text-destructive">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{state.message}</span>
        </div>
      </section>
    );
  }

  const p = state.preview;
  const canPress = p.canApprove && p.postableCount > 0 && p.balanced;

  return (
    <section
      id="rcm-approval-gate"
      className="mt-6 scroll-mt-6 rounded-xl border border-border bg-card"
      data-testid="approval-panel"
    >
      {/* ── Header: the counts, and the button ─────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Approve for posting</h2>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="approval-counts">
            {p.postableCount} of {p.claims.length} claim{p.claims.length === 1 ? "" : "s"} can be
            posted
            {p.withheldCount > 0 ? ` · ${p.withheldCount} withheld` : ""}
            {p.queuedCount > 0 ? ` · ${p.queuedCount} already queued` : ""}
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            onClick={onApprove}
            disabled={!canPress || approving}
            data-testid="approve-button"
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              canPress
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "cursor-not-allowed bg-foreground/10 text-muted-foreground"
            } disabled:opacity-60`}
          >
            {approving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : p.canApprove ? (
              <ShieldCheck size={14} />
            ) : (
              <Lock size={14} />
            )}
            {approving
              ? "Approving…"
              : p.postableCount > 0
                ? `Approve ${p.postableCount} claim${p.postableCount === 1 ? "" : "s"} for posting`
                : "Approve for posting"}
          </button>

          {/* WHY it cannot be pressed — always, specifically, and RENDERED
              rather than hovered: the practice reads these screens on a tablet
              at the front desk, where there is no hover. `DisabledReason` also
              carries the marker `rcm-disabled-reasons.test.tsx` scans for. */}
          {!p.canApprove ? (
            <DisabledReason testId="approve-needs-permission">
              Approving needs posting permission ({p.approveRequires}). Ask an approver to press it.
            </DisabledReason>
          ) : !p.balanced ? (
            <DisabledReason tone="warn" testId="approve-unbalanced">
              This remittance does not balance — {money(p.differenceCents)} unaccounted. Nothing on
              it can be approved.
            </DisabledReason>
          ) : p.postableCount === 0 ? (
            <DisabledReason testId="approve-nothing-postable">
              Nothing on this remittance can be approved yet — the checklist below says what each
              claim is waiting for.
            </DisabledReason>
          ) : approving ? (
            <DisabledReason testId="approve-in-flight">
              Approving — this writes a posting plan, not a chart note.
            </DisabledReason>
          ) : (
            <span className="text-xs text-muted-foreground">
              Writes a posting plan. Nothing reaches Open Dental until somebody drains it on the
              Posting screen.
            </span>
          )}
        </div>
      </div>

      {/* ── What just happened ─────────────────────────────────────────────── */}
      {error && (
        <div
          className="flex items-start gap-2 border-b border-border bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
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
                      {c.alreadyQueued ? "already queued" : c.failed.join(", ")}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="border-b border-border px-4 py-3 text-sm" data-testid="approve-result">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Check size={15} className="text-emerald-600 dark:text-emerald-400" />
            Queued {result.queued.length} claim{result.queued.length === 1 ? "" : "s"} for posting —{" "}
            {money(result.intendedTotalCents)}
          </div>
          {/*
            THE SERVER'S OWN SENTENCE, not the client's paraphrase of it. It is
            exactly true today and stops being true when 6c ships, and the place
            that changes it should be the place that knows.
          */}
          <p className="mt-1 text-xs text-muted-foreground" data-testid="approve-honest-state">
            {result.note}
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {result.queued.map((q) => (
              <li key={q.claimId}>
                {q.patientName} · #{q.claimNumber} → Open Dental claim {q.odClaimNum} ·{" "}
                {q.lines} line{q.lines === 1 ? "" : "s"} · {money(q.totalCents)}
              </li>
            ))}
          </ul>

          {result.withheld.length > 0 && (
            <div className="mt-3" data-testid="approve-withheld">
              <div className="text-xs font-medium text-amber-800 dark:text-amber-300">
                Withheld — {result.withheld.length} claim
                {result.withheld.length === 1 ? "" : "s"} not queued
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

          <p className="mt-2 text-xs text-muted-foreground">
            Approved by {result.approvedBy} · {stamp(new Date().toISOString())}
          </p>
        </div>
      )}

      {/*
        ── RUN THE MATCH FIRST ─────────────────────────────────────────────────
        §15.2, finding 3. On a fresh remittance most of the ✗ marks below are
        one button away from clearing, and the walk showed somebody reading all
        of them before finding it. One line, only while it is true, with the
        button in it.
      */}
      {unmatchedCount > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-4 py-2.5 text-sm"
          data-testid="approval-match-first"
        >
          <span className="text-foreground">
            <strong className="font-semibold">Run the match first</strong> — most of these clear on
            their own. {unmatchedCount} claim{unmatchedCount === 1 ? " has" : "s have"} not been
            looked for in Open Dental yet.
          </span>
          {onRunMatch && (
            <button
              onClick={onRunMatch}
              data-testid="approval-run-match"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              Match all claims
            </button>
          )}
        </div>
      )}

      {/* ── The checklist ──────────────────────────────────────────────────── */}
      <div className="divide-y divide-border">
        {p.claims.map((claim) => (
          <ClaimChecklist key={claim.claimId} claim={claim} />
        ))}
      </div>
    </section>
  );
}

function ClaimChecklist({ claim }: { claim: ApprovalClaim }) {
  const [open, setOpen] = useState(!claim.postable && !claim.alreadyQueued);
  const failed = claim.checks.filter((c) => !c.passed);

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
            ? "Queued for posting"
            : claim.postable
              ? "Ready to post"
              : `Withheld · ${failed.length} check${failed.length === 1 ? "" : "s"} failed`}
        </span>
      </button>

      {open && (
        <ul className="mt-2 space-y-1.5" data-testid={`approval-checks-${claim.claimId}`}>
          {claim.checks.map((check) => (
            <CheckRow key={check.code} check={check} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One condition, in biller language.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PASS DETAIL IS NEVER THE FAILURE TEXT
 * ─────────────────────────────────────────────────────────────────────────────
 * This row used to print `check.detail` whether the check passed or failed. The
 * gate builds `SNAPSHOT_CURRENT`'s detail from a ternary chain that is evaluated
 * either way, so a PASSING check rendered with a green tick beside the sentence
 * "the confirmed claim is not among the candidates the match recorded" — §15.2's
 * copy bug, and a row a biller has no way to read.
 *
 * `features/rcm/checks.ts` now owns the three strings, keyed off the machine
 * slug: a plain title, a verb-first instruction on failure, and a short
 * confirmation on a pass that comes from a DIFFERENT FIELD than the failure
 * text, so the two can never be the same string again. The server's own
 * `detail` survives as the quiet "why" line, on failures only, where it carries
 * the specific number or reason behind the instruction.
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
        {!check.passed && (why || check.code === "NOT_REVERSAL" || check.code === "NOT_RECOUPMENT") && (
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
