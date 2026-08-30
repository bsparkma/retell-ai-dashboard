/**
 * /rcm/claims/:id — the workbench: one claim, the EOB beside the chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE SHELL. `ClaimWorkbench` IS THE EVIDENCE.
 * ═════════════════════════════════════════════════════════════════════════════
 * Everything here is WHERE a person is and what the next click is: the
 * breadcrumb, the patient header, the match-status chip, the five-step rail, the
 * notice line, and every verb this screen can perform. None of it is about how
 * the evidence is laid out.
 *
 * `components/rcm/ClaimWorkbench.tsx` draws the evidence — the carrier's version
 * on the left, the per-line write-off decision under it, Open Dental's version
 * and the identity check on the right, and the patient-responsibility verdict
 * across the top. It fetches nothing and owns no state beyond one open reason
 * list; every input is a prop. That split is what let Stage B replace the whole
 * body without moving a route, a hook or a breadcrumb.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN DECIDES, AND WHAT IT STILL DOES NOT
 * ═════════════════════════════════════════════════════════════════════════════
 * Matching reads Open Dental and ranks candidates; confirming is a click a
 * person makes and is the only thing that writes an Open Dental ClaimNum onto
 * our row. NEW in Stage B: a biller decides, per line, whether the patient is
 * billed what the EOB says they owe or the office absorbs it — recorded against
 * the line with a reason and a name, and snapshotted onto the check's posting
 * when somebody approves.
 *
 * Nothing on this screen writes to a chart. The only Open Dental traffic is the
 * GET behind "Match it up".
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useRoute, useSearchParams } from "wouter";
import { ArrowLeft, CheckCircle2, Info, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOffice } from "@/contexts/OfficeContext";
import { can } from "@/lib/permissions";
import {
  confirmClaimMatch,
  documentHref,
  getClaim,
  getRemittance,
  isRcmOfficeId,
  matchClaim,
  RcmApiError,
  reviewClaim,
  setLineDecision,
  RCM_OFFICE_LABELS,
  type ClaimDetailResponse,
  type LineDecision,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { day, MATCH_STATUS_TONE, matchStatusLabel } from "@/features/rcm/format";
import { claimFlow, remittanceHref } from "@/features/rcm/flow";
import RcmStepper from "@/components/rcm/RcmStepper";
import ClaimWorkbench from "@/components/rcm/ClaimWorkbench";

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
  const [busy, setBusy] = useState<null | "match" | "confirm" | "review" | "decide">(null);
  /**
   * WHICH CLAIM ON THIS CHECK THIS IS, so a biller can walk them without going
   * back to the check between each one.
   *
   * Loaded from the remittance ONLY when the URL says which check this came
   * from — `GET /claims/:id` does not return a `batch_id`, so without `?from=`
   * there is no honest way to know, and the pager is simply not rendered rather
   * than guessed at. One extra read per screen, not per claim.
   */
  const [siblings, setSiblings] = useState<string[] | null>(null);
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

  /*
   * The check's claims, in the order it lists them. Failure is SILENT and the
   * pager disappears: this is a convenience for walking a check, and a red
   * banner over a claim that loaded perfectly well because a second read failed
   * would be a screen crying wolf about its own furniture.
   */
  useEffect(() => {
    if (state.kind !== "loaded" || !fromBatchId) {
      setSiblings(null);
      return;
    }
    let cancelled = false;
    getRemittance(state.office, fromBatchId)
      .then((r) => {
        if (!cancelled) setSiblings(r.claims.map((c) => c.claimId));
      })
      .catch(() => {
        if (!cancelled) setSiblings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state.kind, state.kind === "loaded" ? state.office : null, fromBatchId]);

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
          <ArrowLeft size={14} /> All checks
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

  /**
   * MAY THIS PERSON DECIDE A WRITE-OFF?
   *
   * `rcm.queue` — the tier that runs a match and marks a claim reviewed. A
   * write-off decision writes four columns on one of our own rows and reaches no
   * chart, no posting and no other claim, so it is the reviewing act, not the
   * authorising one. UI HIDING ONLY: the route carries its own
   * `requirePermission('rcm.queue')`, whatever the buttons do.
   *
   * ...AND AN APPROVED CLAIM IS FROZEN (D-14). The posting carries its own
   * snapshot of these figures, so letting the review row move afterwards would
   * leave two records of one decision with the visible one being the one the
   * drain does not read. The server refuses with 409 `CLAIM_ON_POSTING_PLAN`;
   * this is what stops a biller pressing a control that cannot work.
   */
  const holdsQueue =
    auth.status !== "authenticated" ||
    auth.user.isSuperAdmin ||
    can(auth.user.permissions, "rcm.queue");
  const mayDecide = claim.postingQueueId == null && holdsQueue;
  /**
   * WHY NOT, when not, because the two causes need different sentences.
   *
   * The frozen one is checked FIRST: an approver looking at a check she
   * approved holds every permission there is, and telling her it is a
   * permission problem sends her to ask somebody for access she already has.
   */
  const decideBlockedBy: "approved" | "permission" | null =
    claim.postingQueueId != null ? "approved" : holdsQueue ? null : "permission";

  /**
   * Where this claim sits on the check, and the ids either side of it.
   *
   * Null unless the check's claim list is loaded AND this claim is on it — a
   * pager that cannot say which of how many is furniture, and one guessing at
   * neighbours is worse.
   */
  const pagerIndex = siblings ? siblings.indexOf(claimId) : -1;
  const pager =
    siblings && pagerIndex >= 0
      ? {
          index: pagerIndex,
          total: siblings.length,
          prevId: pagerIndex > 0 ? siblings[pagerIndex - 1] : null,
          nextId: pagerIndex < siblings.length - 1 ? siblings[pagerIndex + 1] : null,
        }
      : null;

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

  /**
   * Record what this office is doing with one line's patient remainder.
   *
   * The whole claim is reloaded afterwards rather than the one line being
   * patched in place. The response DOES carry the recomputed verdict and lines,
   * and using them would be one fewer round trip — but the checklist on the
   * check, the step rail and the review stamp all read the same claim, and a
   * screen where one panel is fresh and the others are a minute old is the class
   * of defect PR #87 named: a stale client is an honest-states bug.
   */
  async function decide(lineId: string, decision: LineDecision, reason: string | null) {
    setBusy("decide");
    setNotice(null);
    try {
      const result = await setLineDecision(office, claimId, lineId, decision, reason);
      setNotice({
        tone: "ok",
        // The server's own sentence about where the patient's number now lands,
        // never a second copy of that arithmetic written here.
        text: result.verdict
          ? result.verdict.sentence
          : "Decision recorded.",
      });
      load();
    } catch (err) {
      say(err, "That decision could not be recorded.");
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
          <ArrowLeft size={14} /> All checks
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

      {/* The same five steps as the check and the Posting screen, scoped to
          this one claim. `post` reads `unknown` rather than "no": this screen can
          see that the check was approved and cannot see whether it was posted. */}
      <RcmStepper
        flow={claimFlow(claim, fromBatchId)}
        here="match"
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

      <ClaimWorkbench
        data={data}
        claim={claim}
        snapshot={snapshot}
        note={note}
        setNote={setNote}
        busy={busy}
        mayRerun={mayRerun}
        mayDecide={mayDecide}
        decideBlockedBy={decideBlockedBy}
        fromBatchId={fromBatchId}
        siblings={pager}
        onRunMatch={runMatch}
        onReview={markReviewed}
        onConfirm={confirm}
        onDecide={decide}
        documentHref={documentHref(office, data.claim.provenance?.uploadId)}
      />
    </div>
  );
}
