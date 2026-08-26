/**
 * /rcm/claims/:id — the match panel (Slice 6a).
 *
 * The carrier's version of a claim on the left; what Open Dental holds, and how
 * strongly it corresponds, on the right.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING ON THIS SCREEN DECIDES ANYTHING
 * ─────────────────────────────────────────────────────────────────────────────
 * Running a match reads Open Dental and ranks candidates. Every candidate shows
 * the EVIDENCE that produced its score — matched how, codes overlapping how
 * far, amounts within what tolerance — so a biller can disagree with the
 * ranking. When the top two are too close to separate, the panel SAYS SO and
 * ranks them anyway rather than picking. Confirming is a click a person makes,
 * and it is the only thing that writes an Open Dental ClaimNum onto our row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRE-FLIGHT FACTS ARE SHOWN BEFORE THEY BITE
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental refuses a claimproc update when the line is an income transfer,
 * carries a blocked status, or already has a check attached — and a deleted
 * procedure still comes back in list reads with `ProcStatus "D"`. Slice 6c will
 * refuse on all of those. They are surfaced HERE, at match time, so the refusal
 * is something a biller reads rather than something they hit.
 *
 * Nothing here writes to Open Dental. The only OD traffic is the GET behind
 * "Run match".
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useRoute, useSearchParams } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  CircleSlash,
  Info,
  Loader2,
  ScanLine,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOffice } from "@/contexts/OfficeContext";
import { can } from "@/lib/permissions";
import {
  confirmClaimMatch,
  getClaim,
  isRcmOfficeId,
  matchClaim,
  RcmApiError,
  reviewClaim,
  RCM_OFFICE_LABELS,
  type ClaimDetailResponse,
  type MatchCandidate,
  type MatchSnapshot,
  type RcmOfficeId,
  type WorkbenchClaim,
} from "@/features/rcm/api";
import {
  CONFIDENCE_TONE,
  day,
  evidenceTone,
  lineFlagLabel,
  lineFlagTone,
  MATCH_STATUS_TONE,
  matchStatusLabel,
  money,
  NO_ACTION_REASONS,
  reviewReasonLabel,
  stamp,
} from "@/features/rcm/format";
import { provenanceLabel, provenanceNote } from "@/features/rcm/labels";
import { claimFlow, remittanceHref } from "@/features/rcm/flow";
import RcmStepper from "@/components/rcm/RcmStepper";
import DisabledReason from "@/components/rcm/DisabledReason";

export default function ClaimMatchPage() {
  const [, params] = useRoute("/rcm/claims/:id");
  const claimId = params?.id ?? "";
  const { office: selected } = useOffice();
  const auth = useAuth();
  /**
   * WHICH REMITTANCE THIS CAME FROM — carried in the URL, not fetched.
   *
   * `GET /api/rcm/claims/:id` does not return the claim's `batch_id`
   * (`CLAIM_LIST_COLUMNS` in matchService.js does not select it), so this screen
   * has no server-side way to link back to the check it arrived on. §15.2's
   * first finding is exactly that missing link.
   *
   * Every route into this page now passes `?from=<batchId>`. A deep link
   * without it still works and the breadcrumb falls back to the list — an
   * honest "all remittances" rather than a guessed one. `batchId` on the claim
   * payload is the backend ask that would make this a fact rather than a hint.
   */
  const [search] = useSearchParams();
  const fromBatchId = search.get("from");

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; office: RcmOfficeId; data: ClaimDetailResponse }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const [busy, setBusy] = useState<null | "match" | "confirm" | "review">(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [note, setNote] = useState("");

  /** Same office resolution as the remittance detail — see the note there. */
  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    const offices = isRcmOfficeId(selected) ? [selected] : (["roland", "valley"] as const);

    (async () => {
      let lastError: unknown = null;
      for (const office of offices) {
        try {
          const data = await getClaim(office, claimId);
          if (!cancelled) {
            setState({ kind: "loaded", office, data });
            setNote(data.claim.reviewNote ?? "");
          }
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
          lastError instanceof Error ? lastError.message : "No claim with that id in this practice.",
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [claimId, selected]);

  useEffect(load, [load]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" data-testid="claim-loading">
        <Loader2 size={16} className="animate-spin" />
        Loading claim…
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="p-6" data-testid="claim-error">
        <Link
          href="/rcm/remittances"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> All remittances
        </Link>
        <div className="mt-4 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not open this claim</div>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  const { office, data } = state;
  const claim = data.claim;
  const snapshot = claim.matchSnapshot ?? null;

  /*
   * RE-RUNNING A CONFIRMED CLAIM IS THE WRITE TIER'S ACT (D-9).
   *
   * "Run again" on a confirmed claim sends `force: true`, which NULLs
   * `od_claim_num` — the column Slice 6c reads to pick a chart. A `reviewer`
   * holds `rcm.queue` and may run a match all day; releasing a decision they
   * could not have made is not theirs. UI HIDING ONLY: the server refuses this
   * with 403 FORCE_REQUIRES_WRITE whatever the button does.
   */
  const mayRerun =
    claim.odMatchStatus !== "confirmed" ||
    auth.status !== "authenticated" ||
    auth.user.isSuperAdmin ||
    can(auth.user.permissions, "rcm.write");

  /** Turn a refusal into the server's own words, never "something went wrong". */
  function say(err: unknown, fallback: string) {
    setNotice({
      tone: "warn",
      text: err instanceof RcmApiError ? err.message : err instanceof Error ? err.message : fallback,
    });
  }

  async function runMatch(force: boolean) {
    setBusy("match");
    setNotice(null);
    try {
      const result = await matchClaim(office, claimId, force ? { force: true } : {});
      setNotice(
        result.status === "no_candidate"
          ? {
              tone: "warn",
              // A real, negative result — and worth stating as one.
              text: "No matching claim found in Open Dental for this office. That is an answer, not a failure: it means the claim was never submitted from this database, or it lives under a different patient.",
            }
          : {
              tone: "ok",
              text: `${result.snapshot.candidates.length} candidate${result.snapshot.candidates.length === 1 ? "" : "s"} found. Nothing has been linked — pick one below.`,
            },
      );
      load();
    } catch (err) {
      say(err, "The match could not be run.");
    } finally {
      setBusy(null);
    }
  }

  async function confirm(odClaimNum: number) {
    setBusy("confirm");
    setNotice(null);
    try {
      await confirmClaimMatch(office, claimId, odClaimNum);
      setNotice({ tone: "ok", text: `Linked to Open Dental claim ${odClaimNum}.` });
      load();
    } catch (err) {
      say(err, "The match could not be confirmed.");
    } finally {
      setBusy(null);
    }
  }

  async function markReviewed() {
    setBusy("review");
    setNotice(null);
    try {
      await reviewClaim(office, claimId, note);
      setNotice({ tone: "ok", text: "Marked reviewed." });
      load();
    } catch (err) {
      say(err, "Could not mark this claim reviewed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-6" data-testid="rcm-claim-match">
      {/*
        ── THE WAY BACK, AND WHAT IS OVER THERE ────────────────────────────────
        §15.2, finding 1. Approve lives on the remittance and review and match
        live here, and getting between them was navigation the operator had to
        already know. The breadcrumb now names what is at the other end.

        It degrades honestly: arriving without `?from=` (a bookmark, a pasted
        link) falls back to the list rather than guessing a batch id.
      */}
      {fromBatchId ? (
        <Link
          href={remittanceHref(fromBatchId)}
          data-testid="back-to-remittance"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} /> Back to the remittance
          <span className="text-muted-foreground/70">— Approve is there</span>
        </Link>
      ) : (
        <Link
          href="/rcm/remittances"
          data-testid="back-to-remittances"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} /> All remittances
        </Link>
      )}

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "Sora, sans-serif" }}
          >
            {claim.patientName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {claim.payer} · claim <span className="font-mono">#{claim.claimNumber}</span> · service{" "}
            {day(claim.serviceDate)} · {RCM_OFFICE_LABELS[office]}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${MATCH_STATUS_TONE[claim.odMatchStatus]}`}
          data-testid="claim-match-status"
        >
          {matchStatusLabel(claim.odMatchStatus, snapshot?.rejectedCandidates ?? 0)}
          {claim.odClaimNum ? ` · ClaimNum ${claim.odClaimNum}` : ""}
        </span>
      </div>

      {/* The same seven steps as the remittance and the posting plan, scoped to
          this one claim. `post` reads `unknown` rather than "no": this screen
          can see that a plan exists and cannot see whether it drained. */}
      <RcmStepper
        flow={claimFlow(claim, fromBatchId)}
        here="confirm"
        onAction={{
          "run-match": () => runMatch(claim.odMatchStatus === "confirmed"),
          review: markReviewed,
        }}
      />

      {notice && (
        <div
          data-testid="claim-notice"
          className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50/60 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
              : "border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
          }`}
        >
          {notice.tone === "ok" ? (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
          ) : (
            <Info size={15} className="mt-0.5 shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* ── LEFT: what the carrier said ──────────────────────────────────── */}
        <section data-testid="claim-parsed">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            What the carrier said
          </h2>

          <div className="mt-2 rounded-xl border border-border bg-card">
            {/* HOW THESE FOUR NUMBERS WERE READ.
                At the top of "what the carrier said" rather than in a footer,
                because it qualifies every figure below it. `confidence` on the
                claim is the extraction model's confidence in reading a STRING;
                this says where that string came from, and a biller deciding
                whether to check the paper needs the second one.
                Rendered only when the answer is known — an 835 was parsed, not
                read, and says nothing here. */}
            {provenanceLabel(data.claim.provenance) && (
              <div
                className="flex items-start gap-2 border-b border-border px-4 py-2.5 text-xs text-muted-foreground"
                data-testid="claim-provenance"
              >
                <ScanLine size={13} className="mt-0.5 shrink-0" />
                <span>
                  {provenanceLabel(data.claim.provenance)}
                  {provenanceNote(data.claim.provenance) && (
                    <> · {provenanceNote(data.claim.provenance)}</>
                  )}
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 border-b border-border p-4 sm:grid-cols-4">
              <Fact label="Billed" value={money(claim.totalBilledCents)} />
              <Fact label="Allowed" value={money(claim.totalAllowedCents)} />
              <Fact label="Paid" value={money(claim.totalPaidCents)} strong />
              <Fact label="Patient" value={money(claim.patientBalanceCents)} />
            </div>

            {claim.needsReviewReasons.length > 0 && (
              <div className="border-b border-border p-4" data-testid="claim-review-reasons">
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
                {claim.needsReviewReasons.some((r) => NO_ACTION_REASONS.has(r)) && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <CircleSlash size={12} className="mt-0.5 shrink-0" />
                    CareIN will not post this one. Handle it in Open Dental directly — a recoupment
                    cannot be reversed once written.
                  </p>
                )}
              </div>
            )}

            <ul className="divide-y divide-border">
              {claim.lines.map((line) => (
                <li key={line.lineId} className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-foreground">{line.billedCode}</div>
                    {line.paidCode && line.paidCode !== line.billedCode && (
                      <div className="font-mono text-xs text-amber-700 dark:text-amber-400">
                        submitted as {line.paidCode}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">{line.description}</div>
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
                    {line.adjustments.map((adj) => (
                      <div key={adj.adjustmentId} className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono" title={adj.groupDescription ?? undefined}>
                          {adj.groupCode}-{adj.reasonCode}
                        </span>{" "}
                        {money(adj.amountCents)}
                        {adj.reasonDescription ? ` — ${adj.reasonDescription}` : ""}
                      </div>
                    ))}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
                      {money(line.paidCents)}
                    </div>
                    <div className="font-mono text-xs tabular-nums text-muted-foreground">
                      of {money(line.billedCents)}
                    </div>
                    {line.odClaimProcNum !== null && (
                      <div className="mt-1 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                        → ClaimProc {line.odClaimProcNum}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <ReviewBox
            claim={claim}
            note={note}
            setNote={setNote}
            busy={busy === "review"}
            onSave={markReviewed}
          />
        </section>

        {/* ── RIGHT: Open Dental ───────────────────────────────────────────── */}
        <section data-testid="claim-od-match">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Open Dental
            </h2>
            {/*
              EVERY DISABLED CONTROL SAYS WHY, IN THE FLOW OF THE PAGE.
              Not a `title` — the practice reads these screens on a tablet, and
              there is no hover on a tablet. §15.2, finding 4.
            */}
            <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-1">
              <div className="flex flex-col items-start gap-1">
                <button
                  onClick={() => runMatch(claim.odMatchStatus === "confirmed")}
                  disabled={busy !== null || !mayRerun}
                  data-testid="run-match"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "match" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Search size={14} />
                  )}
                  {claim.odMatchStatus === "not_run"
                    ? "Run match"
                    : claim.odMatchStatus === "confirmed"
                      ? "Re-run match"
                      : "Run again"}
                </button>
                {!mayRerun ? (
                  <DisabledReason testId="run-match-reason">
                    Releasing a confirmed match needs posting permission. Ask an approver.
                  </DisabledReason>
                ) : busy !== null ? (
                  <DisabledReason testId="run-match-reason">
                    Waiting for the {busy === "match" ? "match" : busy} to finish.
                  </DisabledReason>
                ) : null}
              </div>

              <div className="flex flex-col items-start gap-1">
                {/*
                  Approving is a WHOLE-CHECK act — the gate evaluates every claim
                  on a remittance and writes one plan. It has never happened
                  here, and this button used to say only "Posting arrives in the
                  next release", which stopped being true when 6b shipped and
                  left a dead control on the page a biller reaches from the
                  approve step. It now names where approving lives and links
                  there when we know which remittance this is.
                */}
                <button
                  disabled
                  data-testid="approve-disabled"
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md bg-foreground/10 px-3 py-1.5 text-sm font-medium text-muted-foreground"
                >
                  <ShieldCheck size={14} />
                  Approve
                </button>
                <DisabledReason testId="approve-disabled-reason">
                  Approving happens on the remittance — the whole check is approved at once.
                  {fromBatchId ? (
                    <>
                      {" "}
                      <Link
                        href={remittanceHref(fromBatchId)}
                        className="underline underline-offset-2 hover:text-foreground"
                        data-testid="approve-disabled-link"
                      >
                        Go there
                      </Link>
                      .
                    </>
                  ) : null}
                </DisabledReason>
              </div>
            </div>
          </div>

          {claim.odMatchStatus === "confirmed" && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="reconfirm-warning">
              {mayRerun
                ? "Re-running replaces this match and un-links the claim. The confirmation stays in the audit trail."
                : "This claim is linked. Releasing it un-links the claim, which needs posting permission — ask an approver."}
            </p>
          )}

          {!snapshot ? (
            <div
              className="mt-2 rounded-xl border border-dashed border-border bg-card p-8 text-center"
              data-testid={claim.matchSnapshotStale ? "match-stale" : "match-not-run"}
            >
              <Search size={20} className="mx-auto text-muted-foreground/50" />
              {claim.matchSnapshotStale ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  A match was run against this claim, but under an earlier version of the record —
                  its contents cannot be read here, and confirming from it is refused. Run it again
                  to get a current answer. Nothing has been un-linked.
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Nobody has looked yet. Running a match READS Open Dental — it writes nothing to any
                  chart.
                </p>
              )}
            </div>
          ) : (
            <>
              <MatchMeta snapshot={snapshot} rules={data.matchRules} />

              {snapshot.candidates.length === 0 ? (
                <div
                  className="mt-3 rounded-xl border border-border bg-card p-6 text-center"
                  data-testid="no-candidate"
                >
                  <Ban size={20} className="mx-auto text-muted-foreground/60" />
                  {/*
                    "WE FOUND NOTHING" AND "WE FOUND THINGS AND OFFERED NONE OF
                    THEM" ARE DIFFERENT ANSWERS.

                    Both leave `candidates` empty, and telling a biller the chart
                    has no such claim when the chart had claims we discarded is
                    the exact failure the four honest states exist to prevent.
                  */}
                  {snapshot.rejectedCandidates > 0 ? (
                    <>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        Nothing here is safe to offer
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Searched {stamp(snapshot.fetchedAt)} against {snapshot.officeName}.{" "}
                        {snapshot.rejectedCandidates} Open Dental claim
                        {snapshot.rejectedCandidates === 1 ? " was" : "s were"} examined and set
                        aside — {rejectionSummary(snapshot)}.
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        That is not the same as the chart having no such claim. If one of them is
                        right, link the patient first and run this again.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        No matching claim in Open Dental
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Searched {stamp(snapshot.fetchedAt)} against {snapshot.officeName}. Nothing
                        was found and nothing was set aside. This is a recorded outcome, not a
                        missing one.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {snapshot.candidates.map((c) => (
                    <CandidateCard
                      key={c.odClaimNum}
                      candidate={c}
                      confirmedClaimNum={claim.odClaimNum}
                      disabled={busy !== null || claim.odMatchStatus === "confirmed"}
                      onConfirm={() => confirm(c.odClaimNum)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Why candidates were set aside, in the server's own two categories.
 *
 * Written as a sentence rather than as counts alone because the two reasons ask
 * for different next steps: a name mismatch means "link the patient first", a
 * low score means "there was nothing much to go on".
 */
function rejectionSummary(snapshot: MatchSnapshot): string {
  const { nameMismatch, belowScore } = snapshot.rejectedReasons;
  const parts: string[] = [];
  if (nameMismatch > 0) {
    parts.push(
      `${nameMismatch} on a different patient's name`,
    );
  }
  if (belowScore > 0) {
    parts.push(`${belowScore} scoring below ${snapshot.minScore}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no reason recorded";
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-mono text-sm tabular-nums ${strong ? "font-semibold text-foreground" : "text-muted-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

/** What the search actually did, including everything it could NOT do. */
function MatchMeta({
  snapshot,
  rules,
}: {
  snapshot: NonNullable<WorkbenchClaim["matchSnapshot"]>;
  rules: ClaimDetailResponse["matchRules"];
}) {
  return (
    <div className="mt-2 rounded-xl border border-border bg-card px-4 py-3 text-xs" data-testid="match-meta">
      <div className="text-muted-foreground">
        Searched {stamp(snapshot.fetchedAt)} · {snapshot.odCalls} Open Dental read
        {snapshot.odCalls === 1 ? "" : "s"} ·{" "}
        {snapshot.patientsConsidered.length} patient
        {snapshot.patientsConsidered.length === 1 ? "" : "s"} considered
      </div>

      {/* AMBIGUITY IS DISPLAYED, NOT RESOLVED. */}
      {snapshot.ambiguous && (
        <div
          className="mt-2 flex items-start gap-1.5 font-medium text-amber-800 dark:text-amber-300"
          data-testid="match-ambiguous"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            The top candidates are within {rules.ambiguityMargin} points of each other. The ranking
            below is not a recommendation — read the evidence and decide.
          </span>
        </div>
      )}

      {/* Also shown when candidates WERE offered: "3 offered, 2 set aside" is
          different information from "3 offered". */}
      {snapshot.rejectedCandidates > 0 && (
        <div className="mt-2 text-muted-foreground" data-testid="match-rejected">
          {snapshot.rejectedCandidates} Open Dental claim
          {snapshot.rejectedCandidates === 1 ? "" : "s"} examined and not offered —{" "}
          {rejectionSummary(snapshot)}.
        </div>
      )}

      {!snapshot.nameRuleApplied && (
        <div className="mt-2 text-muted-foreground" data-testid="match-name-rule-off">
          This patient is already linked, so claims were read from their chart directly and a name
          disagreement was shown as evidence rather than used to disqualify.
        </div>
      )}

      {snapshot.truncated && (
        <div className="mt-2 flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>A search limit was reached — some Open Dental claims were not examined.</span>
        </div>
      )}

      {snapshot.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-muted-foreground" data-testid="match-notes">
          {snapshot.notes.map((n, i) => (
            <li key={i}>· {n}</li>
          ))}
        </ul>
      )}

      <div className="mt-2 text-muted-foreground/80">
        Amounts match within {money(rules.amountNearCents)}; dates within {rules.dateNearDays} days.
      </div>
    </div>
  );
}

function CandidateCard({
  candidate: c,
  confirmedClaimNum,
  disabled,
  onConfirm,
}: {
  candidate: MatchCandidate;
  confirmedClaimNum: number | null;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const isConfirmed = confirmedClaimNum === c.odClaimNum;
  /**
   * The claim that took the link, when it is not this one.
   *
   * Null covers both "nothing is confirmed" and "this card IS the confirmed
   * one" — the two cases that need a different sentence, or none at all.
   */
  const lockedByOther =
    confirmedClaimNum !== null && confirmedClaimNum !== c.odClaimNum ? confirmedClaimNum : null;
  const blocking = c.blockers.filter((b) => b.blocking);
  const cautions = c.blockers.filter((b) => !b.blocking);

  return (
    <div
      className={`rounded-xl border bg-card ${isConfirmed ? "border-emerald-300 dark:border-emerald-800" : "border-border"}`}
      data-testid={`candidate-${c.odClaimNum}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground">
              ClaimNum {c.odClaimNum}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${CONFIDENCE_TONE[c.confidence]}`}
              title="A score, not a decision. Read the evidence below."
            >
              {c.confidence} · {c.score}
            </span>
            {isConfirmed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                <CheckCircle2 size={11} /> Linked
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {c.od.patientName ?? "Unknown patient"} · PatNum {c.odPatNum ?? "—"} · service{" "}
            {day(c.od.dateService)} · status {c.od.claimStatus || "—"}
          </div>
        </div>
        <div className="text-right">
          {/*
            The LIVE lines' total, not the claim header. `ClaimFee` still counts
            soft-deleted procedures, so showing it here would put a number on
            screen that no comparison on this page was made against.
          */}
          <div className="font-mono text-sm tabular-nums text-foreground">
            {money(c.od.billedCents)}
          </div>
          <div className="font-mono text-xs tabular-nums text-muted-foreground">billed in chart</div>
          {c.od.unknownDeletedLineCount > 0 && (
            <div
              className="font-mono text-[11px] tabular-nums text-amber-700 dark:text-amber-400"
              data-testid={`unknown-lines-${c.odClaimNum}`}
            >
              {c.od.unknownDeletedLineCount} line
              {c.od.unknownDeletedLineCount === 1 ? "" : "s"} unread
            </div>
          )}
        </div>
      </div>

      {/* The evidence. Every score is an argument a biller can check. */}
      <div className="border-t border-border px-4 py-3" data-testid={`evidence-${c.odClaimNum}`}>
        <div className="flex flex-wrap gap-1.5">
          {c.evidence.map((e) => (
            <span
              key={e.tag}
              title={e.detail}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${evidenceTone(e.weight)}`}
            >
              {e.label}
              {e.note ? ` (${e.note})` : ""}
              <span className="ml-1 font-mono opacity-70">
                {e.weight >= 0 ? `+${e.weight}` : e.weight}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Pre-flight: what Slice 6c would refuse on. Shown BEFORE it refuses. */}
      {(blocking.length > 0 || cautions.length > 0) && (
        <div className="border-t border-border px-4 py-3" data-testid={`blockers-${c.odClaimNum}`}>
          <ul className="space-y-1">
            {[...blocking, ...cautions].map((b) => (
              <li
                key={b.code}
                className={`flex items-start gap-1.5 text-xs ${
                  b.blocking ? "text-rose-700 dark:text-rose-400" : "text-muted-foreground"
                }`}
                title={b.detail}
              >
                {b.blocking ? (
                  <Ban size={12} className="mt-0.5 shrink-0" />
                ) : (
                  <Info size={12} className="mt-0.5 shrink-0" />
                )}
                <span>
                  {b.label}
                  {b.count ? ` (${b.count})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Which chart line each of our lines would adjudicate. */}
      <div className="border-t border-border px-4 py-3" data-testid={`pairs-${c.odClaimNum}`}>
        <div className="text-xs font-medium text-muted-foreground">Line pairing</div>
        <ul className="mt-1 space-y-0.5">
          {c.linePairs.map((p, i) => (
            <li key={p.lineId ?? i} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-foreground">{p.code || "—"}</span>
              <span className="text-muted-foreground">→</span>
              {p.odClaimProcNum !== null ? (
                <span className="font-mono text-muted-foreground">
                  ClaimProc {p.odClaimProcNum}
                  {p.billedDeltaCents ? ` · ${money(p.billedDeltaCents)} apart` : ""}
                </span>
              ) : (
                // An unpaired line is a real answer. 6c refusing to post one is
                // better than 6c posting it against whichever line was next.
                <span className="text-amber-700 dark:text-amber-400">{p.reason}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/*
        ── WHY THE OTHER CANDIDATE GREYED OUT ──────────────────────────────────
        §15.2's fourth finding in its most confusing form: confirm one candidate
        and the second one's button goes grey with nothing said. To the person
        who just clicked, that reads as a bug — the two cards look identical and
        only one of them stopped working.

        One claim links to one Open Dental claim, so the answer is short and it
        names the claim that won. Every disabled state on this card has its own
        sentence rather than sharing a vague one.
      */}
      <div className="flex flex-col items-start gap-1 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <button
            onClick={onConfirm}
            disabled={disabled || isConfirmed}
            data-testid={`confirm-${c.odClaimNum}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CheckCircle2 size={14} />
            {isConfirmed ? "Confirmed" : "Confirm this match"}
          </button>
          {!disabled && !isConfirmed && (
            <span className="text-xs text-muted-foreground">
              Links the claim. Still writes nothing to the chart.
            </span>
          )}
        </div>

        {isConfirmed ? (
          <DisabledReason testId={`confirm-reason-${c.odClaimNum}`}>
            This is the linked claim. Re-run the match to change it.
          </DisabledReason>
        ) : lockedByOther !== null ? (
          <DisabledReason testId={`confirm-reason-${c.odClaimNum}`}>
            One claim per remittance — {lockedByOther} is linked. Re-run the match to change it.
          </DisabledReason>
        ) : disabled ? (
          <DisabledReason testId={`confirm-reason-${c.odClaimNum}`}>
            Waiting for the last action to finish.
          </DisabledReason>
        ) : null}
      </div>
    </div>
  );
}

function ReviewBox({
  claim,
  note,
  setNote,
  busy,
  onSave,
}: {
  claim: WorkbenchClaim;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="review-box">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">Review</h3>
        {claim.reviewedAt && (
          <span className="text-xs text-muted-foreground" data-testid="reviewed-stamp">
            Reviewed {stamp(claim.reviewedAt)} by {claim.reviewedBy ?? "—"}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Worklist hygiene only — this changes nothing in Open Dental. A claim with no chart match can
        still be finished work.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        rows={2}
        data-testid="review-note"
        placeholder="What did you find? e.g. carrier owes a corrected EOB — nothing to post."
        className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="mt-2 flex flex-col items-start gap-1">
        <button
          onClick={onSave}
          disabled={busy}
          data-testid="mark-reviewed"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {claim.reviewedAt ? "Update review" : "Mark reviewed"}
        </button>
        {busy && (
          <DisabledReason testId="mark-reviewed-reason">Saving the review…</DisabledReason>
        )}
      </div>
    </div>
  );
}
