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
 * THE CLAIM LIST IS A TRIAGE SCREEN (Stage C, §4)
 * ─────────────────────────────────────────────────────────────────────────────
 * It was a stack of expandable cards, each carrying a patient, a payment, a set
 * of flags and a procedure-line table. Everything true about a claim was on it,
 * and nothing said which claim to open first.
 *
 * It is a TABLE now, and the last column is the point: *Where the patient
 * stands* — the per-claim verdict in miniature, so a biller scanning ten rows
 * can see which one does not line up before she opens any of them.
 *
 * That column renders the SAME `verdictFor()` result the workbench prints and
 * the gate judges on. It arrives on the approval preview, per claim
 * (`routes/rcm/approvalGate.js`), so this screen computes no second summary —
 * a green cell beside a red claim is a shape the code cannot produce.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * APPROVING IS A PAGE NOW, AND THIS SCREEN LINKS TO IT (§6)
 * ─────────────────────────────────────────────────────────────────────────────
 * The gate's checklist and its button used to be a panel here, below the claim
 * cards and above the takeback box. The press that freezes a set of decisions
 * deserves a screen where nothing competes with it — `pages/rcm/ApproveCheck.tsx`
 * says why at length.
 *
 * **The ACT is untouched**: same route, same `rcm.write` tier, same gate, same
 * audit row, same partial approve. What this page keeps is the COUNT — how many
 * claims can be approved — and one link, so the rail's "Check it over" step
 * still has somewhere to send her.
 *
 * Approving still reaches Open Dental not at all; `rcmNoOdWrites.test.js` drives
 * the path to success against a client whose every verb throws.
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
  ScanLine,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  COMPARISON_CLOSED_STATUSES,
  getApprovalPreview,
  getRemittance,
  listPostingQueue,
  matchClaim,
  matchRemittance,
  RcmApiError,
  unparkRemittance,
  RCM_OFFICE_LABELS,
  type ApprovalPreview,
  type BatchMatchResponse,
  type ClaimVerdict,
  type RemittanceClaim,
  type RemittanceDetail as RemittanceDetailPayload,
} from "@/features/rcm/api";
import { isRcmOfficeId } from "@/features/rcm/api";
import {
  day,
  isBlockingReason,
  lineFlagLabel,
  lineFlagTone,
  matchStatusLabel,
  MATCH_STATUS_TONE,
  money,
  NO_ACTION_REASONS,
  reasonTone,
  reviewReasonLabel,
  SOURCE_LABELS,
  SOURCE_TITLES,
  stamp,
} from "@/features/rcm/format";
import { FLAG_LABELS, label, provenanceLabel, provenanceNote } from "@/features/rcm/labels";
import { claimHref, remittanceFlow } from "@/features/rcm/flow";
import { waitingFor } from "@/features/rcm/waitingOn";
import { checkChip } from "@/features/rcm/worklist";
import { describePlbAdjustment } from "@/features/rcm/plb";
import { matchRunSummary } from "@/features/rcm/matchWords";

import { RecoupmentPanel } from "@/pages/rcm/RecoupmentPanel";
import RcmStepper from "@/components/rcm/RcmStepper";
import RcmPrimaryAction from "@/components/rcm/RcmPrimaryAction";
import PostThisCheck from "@/components/rcm/PostThisCheck";
import ShadowModeBanner from "@/components/rcm/ShadowModeBanner";
import CheckComparison from "@/components/rcm/CheckComparison";
import CheckWorklistActions from "@/components/rcm/CheckWorklistActions";
import DisabledReason from "@/components/rcm/DisabledReason";
import { useOffice } from "@/contexts/OfficeContext";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";

export default function RemittanceDetailPage() {
  const [, params] = useRoute("/rcm/remittances/:id");
  const batchId = params?.id ?? "";
  const { office: selected } = useOffice();
  const auth = useAuth();

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; data: RemittanceDetailPayload }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const [matching, setMatching] = useState(false);
  const [matchResult, setMatchResult] = useState<BatchMatchResponse | null>(null);
  /**
   * A failed MATCH must not replace the loaded remittance.
   *
   * It used to set `state = "failed"`, so a batch match that timed out wiped
   * the screen to "Could not open this remittance" while the server was still
   * matching. The operator's only move was to reload and press Match again —
   * launching a SECOND Open Dental-heavy run against a rate-limited credential.
   * An inline notice keeps the data on screen and the mistake un-invited, the
   * way ClaimMatch.tsx already handles its own failures.
   */
  const [matchError, setMatchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * THE GATE'S PREVIEW, for the *Where the patient stands* column and the
   * approve card's count.
   *
   * A SEPARATE, FAILURE-TOLERANT read. The check itself must render whether or
   * not the gate can be evaluated — a screen that went blank because a preview
   * timed out would hide the claim list somebody came here to look at. When it
   * is absent the column says "not judged yet" and the approve card says it
   * could not read the gate, which are two different and honest sentences.
   */
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  /**
   * IS POSTING SWITCHED OFF FOR THIS PRACTICE? (§10)
   *
   * `postingEnabled && !drainEnabled` — the same predicate Today computes, from
   * the same read. A practice D-7 has never validated is NOT in shadow mode: it
   * is not set up, and its postings say so per row. Showing both would offer two
   * explanations for one silence.
   *
   * `false` until the read lands, so the banner appears when it is known to be
   * true and never merely because a read is slow.
   */
  const [shadowMode, setShadowMode] = useState(false);
  /**
   * RE-MATCHING ONE CLAIM, FROM ITS OWN ROW (W-11).
   *
   * The claim id in flight, and the last outcome, keyed by claim. Per-claim and
   * not per-page on purpose: this act names one row, and an outcome reported in
   * a page-level banner would leave a reader working out which of nine rows it
   * was about.
   */
  const [rematching, setRematching] = useState<string | null>(null);
  const [rematchNote, setRematchNote] = useState<{ claimId: string; text: string } | null>(null);

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
          /*
           * AFTER the check is on screen, never in front of it. Its failure is
           * recorded and the page carries on — see `preview` above.
           */
          getApprovalPreview(office, batchId).then(
            (p) => {
              if (cancelled) return;
              setPreview(p);
              setPreviewFailed(false);
            },
            () => {
              if (cancelled) return;
              setPreview(null);
              setPreviewFailed(true);
            },
          );
          /*
           * The posting switch, on its own failure-tolerant read. `limit: 1`
           * because the two flags are what this page wants and the rows are
           * not — they belong to the posting history screen.
           */
          listPostingQueue(office, { limit: 1 }).then(
            (q) => {
              if (!cancelled) setShadowMode(q.postingEnabled && !q.drainEnabled);
            },
            () => {
              if (!cancelled) setShadowMode(false);
            },
          );
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
   * OPENING A SAVED CHECK PUTS IT BACK ON THE ORDINARY PILE.
   *
   * "Save for tomorrow" is a note to yourself, and a note has done its job the
   * moment you are reading it. Leaving the state set would make Today keep
   * offering the check you are already looking at, and would quietly turn a
   * one-press convenience into a two-press chore nobody would use twice.
   *
   * FIRE AND FORGET, on purpose. The server is idempotent over an un-saved check
   * (200, `wasParked: false`), so this is safe on every visit; and if it fails
   * there is nothing to tell anybody — a note that outlived its usefulness by an
   * hour costs nothing, while an error banner over an ordinary page-open costs
   * the reader's attention for something they never asked for.
   *
   * It does NOT re-load the page. The `parkedAt` on screen is a second old and
   * about to be irrelevant; a reload here would restart the claim bundle and the
   * Open Dental reads under it for a cosmetic field.
   */
  const parkedAt = state.kind === "loaded" ? state.data.remittance.parkedAt : null;
  const loadedOffice = state.kind === "loaded" ? state.data.office : null;
  useEffect(() => {
    if (!parkedAt || !loadedOffice || !batchId) return;
    void unparkRemittance(loadedOffice, batchId).catch(() => {
      /* see above — a stale note is not worth a banner */
    });
  }, [parkedAt, loadedOffice, batchId]);

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
  useEffect(() => {
    setMatchResult(null);
    setMatchError(null);
  }, [batchId]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" data-testid="remittance-loading">
        <Loader2 size={16} className="animate-spin" />
        Loading this check…
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="p-6" data-testid="remittance-error">
        <Breadcrumb title={null} />
        <div className="mt-4 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not open this check</div>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  const { remittance: r, claims, office } = state.data;
  /*
   * The rail is told about the posting switch, so its `post` step can say
   * "switched off while shadow mode is on" instead of "ready to post" — the
   * same fact the banner below explains at length, in one line, where the
   * reader is already looking.
   */
  const flow = remittanceFlow(r, claims, { shadowMode });
  const headerChip = checkChip(waitingFor(r, { office, shadowMode }).state);
  /*
   * THIS CHECK'S POSTING, if it has one.
   *
   * `plans` is an array because the table permits more than one; today the
   * `(office_id, remittance_key)` unique index means at most one, so reading the
   * first is exact rather than a guess. It is typed as an array so that the day
   * 6d.2 relaxes that index (§15.1), this line is where the follow-on shows up
   * rather than a silently-wrong screen.
   */
  const plan = r.plans?.[0] ?? null;
  const unmatchedCount = claims.filter((c) => c.odMatchStatus === "not_run").length;
  /**
   * WHAT IS LEFT ON THIS CHECK, for the finished panel's "Next claim".
   *
   * The same predicate `features/rcm/nextAction.ts` uses on Today: a claim is
   * finished when a person has checked it over or it has been approved onto a
   * posting. "Looked, nothing to do" is finished work, which is why a claim with
   * no chart match can still be done.
   */
  const unfinished = claims.filter((c) => c.reviewedAt == null && c.postingQueueId == null);
  const unfinishedCount = unfinished.length;
  const nextUnfinishedClaimId = unfinished.length > 0 ? unfinished[0].claimId : null;
  /**
   * The per-claim verdicts, keyed by claim.
   *
   * From the gate's preview, which carries `verdictFor()`'s whole result per
   * claim. A claim the preview did not judge is ABSENT rather than mapped to a
   * neutral value — the table renders those two cases as different sentences.
   */
  /**
   * MAY THIS PERSON RELEASE A CONFIRMED MATCH? (D-9)
   *
   * Re-running a CONFIRMED claim sends `force: true`, which NULLs
   * `od_claim_num` — the column the posting reads to pick a chart claim. A
   * `reviewer` holds `rcm.queue` and may run a match all day; releasing a
   * decision they could not have made is not theirs.
   *
   * UI HIDING ONLY, exactly as on the claim screen: the server refuses with
   * 403 FORCE_REQUIRES_WRITE whatever this button does. The two screens read the
   * same permission so a control cannot be offered in one place and refused in
   * the other.
   */
  const mayRelease =
    auth.status !== "authenticated" || auth.user.isSuperAdmin || can(auth.user.permissions, "rcm.write");

  const verdictByClaim = new Map<string, ClaimVerdict>(
    (preview?.claims ?? [])
      .filter((c): c is typeof c & { verdict: ClaimVerdict } => c.verdict != null)
      .map((c) => [c.claimId, c.verdict]),
  );

  /**
   * Take the operator to the approve button rather than growing a second one.
   *
   * `focus()` as well as `scrollIntoView()`: a page that jumps but leaves the
   * keyboard where it was has moved the eye and not the hand.
   */
  /**
   * The rail's "Check it over" step.
   *
   * It scrolls to the card that leads to the approve page rather than navigating
   * straight there: the rail says WHERE you are, and jumping a person to another
   * screen because they read a step name is a bigger move than they asked for.
   * The card's own button is the navigation.
   */
  function goToApprovalGate() {
    const gate = document.getElementById("rcm-approval-gate");
    gate?.scrollIntoView({ behavior: "smooth", block: "start" });
    gate?.querySelector<HTMLAnchorElement>('[data-testid="approve-open-page"]')?.focus({
      preventScroll: true,
    });
  }

  /** The same move, for the step after it. See `goToApprovalGate`. */
  function goToPostPanel() {
    const panel = document.querySelector<HTMLElement>('[data-testid="post-this-check"]');
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel
      ?.querySelector<HTMLButtonElement>('[data-testid="post-this-check-button"]')
      ?.focus({ preventScroll: true });
  }

  /**
   * MATCH THIS ONE CLAIM AGAIN — W-11's re-match, at the row that names it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * SAME ENDPOINT, SAME PARAMS, DIFFERENT PLACE AND A DIFFERENT NAME
   * ═══════════════════════════════════════════════════════════════════════════
   * `matchClaim(office, claimId, force ? { force: true } : {})` — byte for byte
   * what the claim screen's own button sends, with `force` set exactly when the
   * claim is already confirmed, which is the one case where re-running releases
   * a decision rather than repeating a search.
   *
   * Nothing about the ACT moved. What moved is WHERE it is offered and what it
   * is called: a page-level control that re-matched "the check" could not say
   * which claim it would release, and a row can.
   *
   * It reads Open Dental and writes to no chart, like every other match on this
   * page.
   */
  async function rematchClaim(claim: RemittanceClaim) {
    const force = claim.odMatchStatus === "confirmed";
    setRematching(claim.claimId);
    setRematchNote(null);
    try {
      const result = await matchClaim(office, claim.claimId, force ? { force: true } : {});
      const found = result.snapshot.candidates.length;
      setRematchNote({
        claimId: claim.claimId,
        text:
          result.status === "no_candidate"
            ? "Looked again — Open Dental still has nothing this app is willing to offer for it."
            : `Looked again — ${found} possible claim${found === 1 ? "" : "s"} in Open Dental. Nothing is linked; open the claim to pick one.`,
      });
      load();
    } catch (err) {
      // The server's own sentence, at the row it is about. A refusal is not a
      // page-level failure and does not get to blank the check.
      setRematchNote({
        claimId: claim.claimId,
        text:
          err instanceof RcmApiError || err instanceof Error
            ? err.message
            : "That claim could not be matched again.",
      });
    } finally {
      setRematching(null);
    }
  }

  async function runBatchMatch() {
    setMatching(true);
    setMatchError(null);
    try {
      const result = await matchRemittance(office, r.batchId);
      setMatchResult(result);
      load();
    } catch (err) {
      setMatchResult(null);
      // Inline, and the remittance stays on screen. See `matchError` above.
      setMatchError(
        err instanceof RcmApiError && err.code === "TIMEOUT"
          ? "The match is taking longer than expected and this page stopped waiting. It may still be running — press Refresh in a minute before trying again, so a second run does not start on top of the first."
          : err instanceof Error
            ? err.message
            : "The match could not be run.",
      );
    } finally {
      setMatching(false);
    }
  }

  return (
    <div className="p-6" data-testid="rcm-remittance-detail">
      <Breadcrumb title={r.payer} />

      {/*
        ── Header (S3, §1) ─────────────────────────────────────────────────────
        Breadcrumb · the check · what it is worth, when it came in and how many
        claims are on it · the three actions.

        THE MONEY LINE IS NEW AND THE IDENTIFIER LINE STAYED. They answer
        different questions — "is this the check I am looking for" is a check
        number, and "how big a job is this" is a total and a claim count — and
        the second one used to be answerable only by reading four cards and
        counting rows.
      */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="text-2xl font-bold tracking-tight text-foreground"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              {r.payer}
            </h1>
            {/*
              ONE CHIP VOCABULARY. This was `batchStatusLabel(r.status)` — the
              ingestion pipeline's words — which meant the check's own page and
              the list you opened it from named its state differently. Both now
              read `checkChip(waitingFor(...).state)`, so the chip a biller
              clicked and the chip she lands on are the same six words.

              A state with no chip (a takeback, another office's check, nothing
              outstanding) renders none — the rail and the panels below say it
              in full, and a badge cannot.
            */}
            {headerChip && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${headerChip.tone}`}
                data-testid="remittance-status"
              >
                {headerChip.label}
              </span>
            )}
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
          {/*
            WHAT THIS CHECK IS WORTH, WHEN IT CAME IN, AND HOW BIG A JOB IT IS.

            "Received" is the DEPOSIT DATE — the date on the carrier's payment,
            the same value the Checks list prints in its Date column. Dropped
            entirely when the remittance carries none, never replaced with the
            day CareIN happened to read the file: those are two different facts
            and only one of them is the carrier's.

            The claim count is `claims.length` — the rows actually rendered
            below — rather than the stored `claimCount`. A header that counted
            one population while the table drew another is the defect Slice 6a
            fixed on the Checks page, and it is not worth re-introducing for a
            field that is already in hand.
          */}
          <p className="mt-1 text-sm text-muted-foreground" data-testid="check-summary">
            <span className="font-mono font-semibold text-foreground">
              {money(r.totalAmountCents)}
            </span>
            {r.depositDate && (
              <span title="The date on the carrier's payment."> · received {day(r.depositDate)}</span>
            )}
            {" · "}
            {claims.length} {claims.length === 1 ? "claim" : "claims"}
          </p>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {r.paymentMethod === "eft" ? "EFT" : "Check"}{" "}
            {r.checkNumber || r.eftNumber || r.traceNumber || "—"}
          </p>
        </div>

        {/*
          ── THE NEXT CLICK, ONCE ────────────────────────────────────────────
          W-11, ONE MATCH VERB. This header used to carry a *Match all claims*
          button while the rail below carried its own CTA reading *Match it up* —
          two controls, two names, one act, and a biller had no way to know they
          were the same press.

          There is now exactly ONE page-level verb and `flow.ts` names it: on a
          check waiting to be matched it reads *Match it up* and fires the batch
          match; on one waiting to be approved it links to the approve screen.
          The rail is told not to draw a second copy (`hideCta`), and re-running
          a single claim moved to that claim's own row, where it says which claim
          it means.
        */}
        <div className="flex flex-col items-start gap-1 sm:items-end">
          {flow.cta && (
            <RcmPrimaryAction
              cta={flow.cta}
              onAction={{
                "run-match": runBatchMatch,
                approve: goToApprovalGate,
                drain: goToPostPanel,
              }}
              busy={matching}
              busyLabel="Matching…"
            />
          )}
          {matching && (
            <DisabledReason testId="match-in-flight">
              A match is running. It reads Open Dental and writes nothing.
            </DisabledReason>
          )}
        </div>
      </div>

      {/*
        ── WHERE THIS ONE IS ───────────────────────────────────────────────────
        The same five steps as the claim screen and the Posting screen, computed
        once in `features/rcm/flow.ts`. The CTA below it is the next click — and
        the reason "approve is on a different page from review and match, with
        no link between them" (§15.2, finding 1) stops being navigation somebody
        has to already know.

        NO `here`, deliberately. This page owns BOTH of the last two steps —
        approving is the second half of "Check it over" and Post is the step
        after it, one panel under the other — so a "you are here" marker would
        have to name one of two steps the page really is. The rail's own current
        dot and the CTA below it already answer "where am I" without picking.
      */}
      {/* SAVE FOR TOMORROW · SET ASIDE — the two quiet header actions.

          Above the rail rather than below it, beside the primary verb they are
          the alternatives to: the header asks "what happens to this check now",
          and "not today" is one of the three answers to it.

          The component is UNCHANGED. Its two panels still open anchored to their
          own buttons, in the normal flow, pushing the page down — Stage C §8's
          rule that neither may cover the claim list still holds, and holds more
          easily from up here. */}
      <CheckWorklistActions office={office} remittance={r} onChanged={load} />

      <RcmStepper
        flow={flow}
        /*
          THE RAIL DOES NOT DRAW THE CTA ON THIS PAGE (W-11).

          `flow.cta` is rendered ONCE, in the header above, by
          `RcmPrimaryAction` — with the same label, the same disabled state, the
          same reason and the same note. Drawing it here as well is what put two
          buttons reading "Match it up" and "Match all claims" on one screen.

          The five steps and their evidence lines are untouched. No `onAction`
          map is passed either: with nothing here to fire the verbs, handing the
          rail three callbacks it can never reach would be wiring that reads as
          live and is not.
        */
        hideCta
      />

      {/*
        ── REMITTANCE-LEVEL FLAGS ──────────────────────────────────────────────
        Slice 5.5 wrote these into `rcm_payment_batches.flags` and nothing
        rendered them, so a whole-check TAKEBACK surfaced only as "Held —
        something on this remittance was flagged". That is the same sin one level
        up that Slice 6a fixed at claim level: a UI announcing a flag exists and
        refusing to say which.

        Coloured by the D-11 split, from the same map the gate reads: amber will
        withhold every claim on this check, grey is true and changes nothing
        about what to post. Both are always shown.
      */}
      {r.flags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5" data-testid="remittance-flags">
          {r.flags.map((flag) => (
            <span
              key={flag}
              data-testid={`remittance-flag-${flag}`}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${reasonTone(flag)}`}
            >
              {isBlockingReason(flag) && <AlertTriangle size={11} />}
              {label(FLAG_LABELS, flag)}
            </span>
          ))}
        </div>
      )}

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

      {/*
        ── PROVIDER-LEVEL ADJUSTMENTS, ITEMISED ────────────────────────────────
        A dollar total is not enough to act on. A PLB is money moved at the
        provider level — an interest payment, a forward balance, a prior
        overpayment being recovered — and which of those it is decides whether a
        biller does anything at all. Slice 6a showed the total and stopped; the
        per-adjustment rows have been stored since Slice 5.
      */}
      {r.plbAdjustments.length > 0 && (
        <div
          className="mt-4 rounded-xl border border-border bg-card px-4 py-3"
          data-testid="plb-detail"
        >
          <div className="text-sm font-medium text-foreground">
            Provider-level adjustments (PLB) · {money(r.plbTotalCents)}
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {r.plbAdjustments.map((raw, i) => {
              const adj = describePlbAdjustment(raw);
              return (
                <li key={`${adj.code}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono font-medium text-foreground">{adj.code}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {money(adj.amountCents)}
                  </span>
                  {/* Null = a code the published list does not carry. Rendered
                      bare rather than glossed with a guess. */}
                  {adj.description && (
                    <span className="text-muted-foreground">{adj.description}</span>
                  )}
                  {adj.reference && (
                    <span className="font-mono text-muted-foreground/70">ref {adj.reference}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            CareIN does not post provider-level money — it belongs to no single claim.{" "}
            <Link
              href="/rcm/sop/takeback"
              className="underline underline-offset-2 hover:text-foreground"
              data-testid="plb-sop-link"
            >
              Handle it manually
            </Link>
            .
          </p>
        </div>
      )}

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

          {/* HOW THE NUMBERS ON THIS SCREEN WERE READ.
              Beside the document link rather than buried in the claims table:
              it applies to the whole remittance, and it is the first thing a
              biller checking a large check should know. A grey chip, because it
              is a fact rather than a warning — every arithmetic check on this
              page still applies, and the ones that block still block.
              Absent entirely for an 835 (parsed, never read) and for anything
              extracted before the OCR slice. */}
          {provenanceLabel(r.upload) && (
            <span
              className="inline-flex items-center gap-1.5 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
              data-testid="source-provenance"
              title={provenanceNote(r.upload) ?? undefined}
            >
              <ScanLine size={12} />
              {provenanceLabel(r.upload)}
            </span>
          )}
        </div>
      )}

      {matchError && (
        <div
          className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
          data-testid="batch-match-error"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{matchError}</span>
        </div>
      )}

      {/* ── What a batch match just did ────────────────────────────────────── */}
      {matchResult && (
        <div
          className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-sm"
          data-testid="batch-match-result"
        >
          {/*
            ── WHAT IT DID, AND WHAT IT LEFT ALONE (W-11) ────────────────────
            This line used to read "Matched {N} claims against Open Dental" with
            N = the LENGTH of the results array — which counts the claims
            somebody had already confirmed, the ones Open Dental has nothing
            for, and the ones that failed outright, right alongside the ones it
            matched. A run that examined nine and matched none reported nine.

            `matchRunSummary` splits the two halves and attaches the reason to
            each count, from the same response. It is not a softer sentence; it
            is a different sentence, and the difference is that this one is true.
          */}
          {(() => {
            const summary = matchRunSummary(matchResult);
            return (
              <div
                className="flex items-start gap-2 font-medium text-foreground"
                data-testid="batch-match-summary"
              >
                <Info size={14} className="mt-0.5 shrink-0" />
                <span>
                  {summary.did}
                  {summary.leftAlone.length > 0 && (
                    <span className="font-normal text-muted-foreground">
                      {" · "}
                      {summary.leftAlone.join(" · ")}
                    </span>
                  )}
                </span>
              </div>
            );
          })()}
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
          </ul>

          {/*
            THE UNFINISHED STATE IS ITS OWN LINE, not a sentence in a note.
            A run stopped by the clock leaves claims nobody has looked at, and
            "the note happened to mention it" is the same fragility that made
            `skipped` invisible: a boolean the server sends deserves a rendering
            of its own, so the screen cannot quietly stop saying it.
          */}
          {matchResult.outOfTime ? (
            <div
              className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              data-testid="match-out-of-time"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Stopped at the {Math.round(matchResult.budgetMs / 1000)}-second budget —{" "}
                {matchResult.skipped} claim{matchResult.skipped === 1 ? "" : "s"} not yet examined.
                Press Match again to continue; claims nobody has looked at go first.
              </span>
            </div>
          ) : (
            matchResult.skipped > 0 && (
              <div
                className="mt-2 text-xs text-amber-700 dark:text-amber-400"
                data-testid="match-skipped"
              >
                {matchResult.note}
              </div>
            )
          )}
        </div>
      )}

      {/*
        ── POST THIS CHECK ─────────────────────────────────────────────────────
        Rendered only once this check HAS a posting — that is, only once somebody
        has approved it. Before then the next act is the approval, which is the
        panel below, and a Post button beside a check nothing has authorised
        would be a control whose precondition is invisible.

        ONE code path with the office-wide press: the same server route, narrowed
        by `queueId`. See the component's header.
      */}
      {plan && (
        <PostThisCheck
          office={office}
          queueId={plan.queueId}
          onPosted={load}
          /* §7's "What's left on this check". The panel cannot see the check it
             belongs to, so the check tells it — and a "Next claim" button
             pointing at nothing is worse than no button, which is why all three
             are optional there and default to offering nothing. */
          batchId={r.batchId}
          nextClaimId={nextUnfinishedClaimId}
          remaining={unfinishedCount}
        />
      )}

      {/*
        ── SHADOW MODE (§10) ───────────────────────────────────────────────────
        Above the approve card, because it changes what the next press means. It
        carries the worksheet — the same roll-up the approve page shows, from the
        same per-claim verdicts — so a practice posting by hand has the figures
        beside the check rather than on a screen it has no reason to open.

        Rendered only when the practice IS in shadow: posting switched on for it
        (D-7) and the switch off. A practice D-7 has never validated is not "in
        shadow mode", it is not set up, and its postings say so per row.
      */}
      {shadowMode && preview && (
        <ShadowModeBanner office={office} claims={preview.claims} />
      )}

      {/*
        ── DID THE APP GET THIS CHECK RIGHT? (C-2) ─────────────────────────────
        Directly beneath the shadow panel, which is where C-1 left the room for
        it, and where the worksheet she just posted from is still on screen.

        THE THREE CONDITIONS, and each one is doing work:

          shadowMode   posting is switched off for this practice, so there IS a
                       hand-posting to compare against. With posting on, the
                       confirmation after a post answers this question with the
                       chart itself, and asking a person would be asking her to
                       repeat a read the app already did.
          plan         somebody has approved this check, so the app has said what
                       it would do. Before that there is nothing to compare, and
                       the server refuses with COMPARISON_NOT_APPROVED.
          —            a posted check still shows its recorded answer, read-only.
                       That is `closed` rather than an absence: a control that
                       vanishes reads as a bug.
      */}
      {shadowMode && plan && (
        <CheckComparison
          office={office}
          batchId={r.batchId}
          verdict={r.comparisonVerdict}
          reason={r.comparisonReason}
          note={r.comparisonNote}
          answeredAt={r.comparisonAt}
          answeredBy={r.comparisonBy}
          revision={r.comparisonRevision}
          closed={COMPARISON_CLOSED_STATUSES.includes(plan.status)}
          onRecorded={load}
        />
      )}

      {/*
        ── CHECK IT OVER, AND SAY YES ──────────────────────────────────────────
        The gate's checklist and its button are a PAGE now (§6). What stays here
        is the count and the door — the rail's "Check it over" step has to have
        somewhere to send her, and a biller standing on the check should be able
        to see how much of it is ready without leaving.

        The ACT is untouched: same route, same tier, same gate, same audit row.
      */}
      <section
        id="rcm-approval-gate"
        className="mt-6 scroll-mt-6 rounded-xl border border-border bg-card p-4"
        data-testid="approve-card"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Check it over, and say yes</h2>
            {previewFailed ? (
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-300" data-testid="approve-card-unavailable">
                What the app checked could not be read just now. The claims below are unaffected —
                open the approve screen to try again.
              </p>
            ) : preview ? (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="approve-card-counts">
                {preview.postableCount} of {preview.claims.length} claim
                {preview.claims.length === 1 ? "" : "s"} can be approved
                {preview.withheldCount > 0 ? ` · ${preview.withheldCount} not ready yet` : ""}
                {preview.queuedCount > 0 ? ` · ${preview.queuedCount} already approved` : ""}
              </p>
            ) : (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                Checking what can be approved…
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              The next screen shows every figure that will reach Open Dental, every write-off this
              office chose to absorb, and every condition the app applied — before anything is
              pressed.
            </p>
          </div>
          <Link
            href={`/rcm/remittances/${encodeURIComponent(r.batchId)}/approve`}
            data-testid="approve-open-page"
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            <ShieldCheck size={14} />
            Review and approve
            <ChevronRight size={13} />
          </Link>
        </div>
      </section>
      {/*
        D-6. Rendered BESIDE the ordinary panel rather than inside it, and it
        returns null when this remittance carries no takeback — so a biller
        never sees a takeback control on a remittance that has none, and never
        finds "approve nine claims" and "authorise a permanent write" behind the
        same button.

        It sits OUTSIDE the stepper deliberately: the stepper describes the
        ordinary path a remittance walks, and a takeback is not a step on it.
      */}
      {/*
        `id` so the approve page can send a takeback-only check straight here
        (W-5). An in-page anchor rather than a route: the panel has never had a
        URL of its own, and giving it one would be a second place a takeback is
        authorised from.
      */}
      <div className="mt-4" id="takeback">
        <RecoupmentPanel
          office={office}
          batchId={r.batchId}
          onApproved={load}
          /* §9's explanation needs the Open Dental claim numbers and the
             carrier's own adjustment codes. Both are on the claims this page
             already holds, so they are passed rather than fetched twice. */
          claims={claims}
        />
      </div>

      {/* ── Claims — the triage screen (§4) ────────────────────────────────── */}
      <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
        Claims
      </h2>

      {/*
        THE MONEY SANITY LINE, above the table.
        Two facts a biller checks before she reads a single row: what the carrier
        actually paid, and whether the claims add up to it. The balance check
        above says the same thing in a card; this says it in the sentence she
        would say out loud, where she is about to work.
      */}
      <p className="mt-1 text-sm text-muted-foreground" data-testid="claims-sanity">
        Carrier paid <span className="font-mono text-foreground">{money(r.totalAmountCents)}</span>
        {" · "}
        {r.balance.balanced
          ? "lines add up."
          : `lines are ${money(r.balance.differenceCents)} out — nothing here can be approved until that is sorted.`}
      </p>

      {claims.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          This check carries no claims.
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          <div className="hidden grid-cols-[minmax(9rem,1.1fr)_6rem_4rem_minmax(8rem,0.9fr)_minmax(12rem,1.4fr)_5.5rem] gap-3 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
            <span>Patient</span>
            <span className="text-right">Paid</span>
            <span className="text-right">Lines</span>
            <span>State</span>
            {/*
              THE VERDICT IN MINIATURE. It is the SAME `verdictFor()` result the
              workbench prints and the gate judges on, carried out on the
              approval preview per claim — never a second summary computed here.
            */}
            <span>Where the patient stands</span>
            <span />
          </div>
          {claims.map((claim) => (
            <ClaimTriageRow
              key={claim.claimId}
              claim={claim}
              batchId={r.batchId}
              verdict={verdictByClaim.get(claim.claimId) ?? null}
              /* `null` = the gate has not answered yet; `true` = it answered and
                 this claim was not in it, which is a different sentence. */
              judged={preview === null ? null : verdictByClaim.has(claim.claimId)}
              /* W-11's re-match, wired to the SAME endpoint the claim screen
                 uses. Disabled while any match is in flight — the batch run
                 reads the same rate-limited Open Dental credential. */
              onRematch={() => void rematchClaim(claim)}
              rematching={rematching === claim.claimId}
              matchBusy={matching || rematching !== null}
              mayRelease={mayRelease}
              rematchNote={rematchNote?.claimId === claim.claimId ? rematchNote.text : null}
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

/**
 * WHERE THIS PAGE SITS — S3, §1.
 *
 * A back arrow reading "All checks" answers "how do I leave", which is not the
 * same question as "where am I". The two steps above this check are the two nav
 * items a biller already clicks — *Today* and *Checks* — and they are named with
 * the SAME words the sidebar uses, so the trail and the nav cannot teach two
 * vocabularies for one place.
 *
 * The last crumb is the check itself and is NOT a link: a breadcrumb whose final
 * item navigates to the page you are on is a control that appears to do
 * something and does nothing.
 *
 * `title` degrades honestly — a check with no payer recorded renders the trail
 * and stops, rather than printing a placeholder that reads like a payer.
 */
function Breadcrumb({ title }: { title: string | null }) {
  return (
    <nav
      aria-label="Where this check sits"
      className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
      data-testid="check-breadcrumb"
    >
      <ArrowLeft size={14} className="shrink-0" aria-hidden />
      <Link href="/rcm" className="underline-offset-4 transition-colors hover:text-foreground hover:underline">
        Today
      </Link>
      <span aria-hidden className="text-muted-foreground/50">
        ›
      </span>
      <Link
        href="/rcm/remittances"
        data-testid="check-breadcrumb-checks"
        className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        Checks
      </Link>
      {title && (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ›
          </span>
          <span className="max-w-[16rem] truncate font-medium text-foreground">{title}</span>
        </>
      )}
    </nav>
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

/**
 * ONE CLAIM, AS A TRIAGE ROW.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT WAS A CARD AND IT IS A ROW, AND THE LAST COLUMN IS WHY
 * ═════════════════════════════════════════════════════════════════════════════
 * The card carried everything true about a claim — the payment, every flag, the
 * match state, an expandable line table — and nothing that said which claim to
 * open first. Ten of them was a page you scrolled rather than a list you
 * triaged.
 *
 * The row keeps every one of those facts and adds the one that ranks them:
 * *Where the patient stands*, the per-claim verdict in miniature. A biller
 * scanning that column sees "matches the EOB" nine times and "Open Dental's fee
 * for D2740 doesn't match" once, and knows where her evening goes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VERDICT IS THE GATE'S OWN, CARRIED WHOLE
 * ─────────────────────────────────────────────────────────────────────────────
 * `verdict.sentence` arrives already written and already formatted from
 * `verdictFor()` on the server — the same object the workbench prints and the
 * approval gate judges on. This row renders it verbatim and computes nothing.
 * A green cell beside a red claim is a shape the code cannot produce.
 *
 * THE SENTENCE CAN BE LONG, AND IT WRAPS RATHER THAN CLIPPING.
 *
 * It used to be truncated to one line with the whole of it on the cell's
 * `title`, on the reasoning that a cell wrapping to four lines would undo the
 * scanning the column exists for. That traded away the wrong thing. Round 1 of
 * PR #167 caught two cousins of this cell on the practice owner's own screen —
 * *The carrier is reclaiming money. It i…* and *You — 1 claim to ch* — and the
 * scanning a clipped cell preserves is scanning of text that has stopped saying
 * anything. A column whose job is a sentence may not cut itself off mid-word.
 *
 * A `title` is not the escape hatch either: it needs a mouse, it never appears
 * on a touch screen, and it is the wrong place for the only copy of a sentence
 * about whether a patient owes money.
 *
 * So the row grows. The identifier cells beside it — patient name, claim number
 * — still truncate, and rightly: a name is recognisable from its first
 * characters and the rest is a lookup, whereas the clipped half of a sentence is
 * the half carrying the verb.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LINE TABLE IS STILL HERE, STILL BEHIND A TOGGLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Unchanged from the card, including its own component. Triage is about picking
 * the row; the evidence under it did not stop being useful.
 */
function ClaimTriageRow({
  claim,
  batchId,
  verdict,
  judged,
  onRematch,
  rematching,
  matchBusy,
  mayRelease,
  rematchNote,
  open,
  onToggle,
}: {
  claim: RemittanceClaim;
  /** Threaded through so the claim page can offer a way back to this one. */
  batchId: string;
  /** The gate's own verdict for this claim, or null. */
  verdict: ClaimVerdict | null;
  /** Run the match again for THIS claim. See `rematchClaim` above. */
  onRematch: () => void;
  /** This row's own run is in flight. */
  rematching: boolean;
  /** Any match is in flight, including the whole-check one. */
  matchBusy: boolean;
  /** D-9: releasing a CONFIRMED match needs `rcm.write`. */
  mayRelease: boolean;
  /** What this row's last run said, or null. */
  rematchNote: string | null;
  /**
   * `null` — the gate has not answered yet.
   * `false` — it answered and had nothing to say about this claim.
   * `true` — it judged this claim (and `verdict` is set).
   *
   * Three states because they are three different sentences, and collapsing the
   * first two would make a slow read look like a missing judgement.
   */
  judged: boolean | null;
  open: boolean;
  onToggle: () => void;
}) {
  const deadEnd = claim.needsReviewReasons.some((r) => NO_ACTION_REASONS.has(r));
  /**
   * THE GATE IS PREDICTED HERE, AND IT BITES ON THE APPROVE PAGE.
   *
   * The ruling on "a Confirm button enabled above a red blocker": confirming
   * only LINKS a proposal to a chart claim, so it stays available — but the row
   * has to say that this confirmation cannot be approved, and why. Otherwise the
   * only place the consequence appears is at the gate, after somebody has
   * already committed the linkage.
   */
  const blocking = claim.needsReviewReasons.filter(isBlockingReason);

  return (
    <div className="border-b border-border last:border-b-0" data-testid={`claim-card-${claim.claimId}`}>
      <div className="grid grid-cols-1 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(9rem,1.1fr)_6rem_4rem_minmax(8rem,0.9fr)_minmax(12rem,1.4fr)_5.5rem]">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{claim.patientName}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            #{claim.claimNumber} · {day(claim.serviceDate)}
          </div>
        </div>

        <div className="text-right">
          <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
            {money(claim.totalPaidCents)}
          </div>
          <div className="font-mono text-xs tabular-nums text-muted-foreground">
            of {money(claim.totalBilledCents)}
          </div>
        </div>

        <button
          onClick={onToggle}
          data-testid={`toggle-lines-${claim.claimId}`}
          className="flex items-center gap-1 font-mono text-sm tabular-nums text-muted-foreground transition-colors hover:text-foreground md:justify-end"
          aria-expanded={open}
        >
          {claim.lines.length}
          <ChevronRight
            size={11}
            className={open ? "rotate-90 transition-transform" : "transition-transform"}
          />
        </button>

        <div className="min-w-0">
          <span
            className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_STATUS_TONE[claim.odMatchStatus]}`}
            data-testid={`claim-match-state-${claim.claimId}`}
          >
            {matchStatusLabel(claim.odMatchStatus, claim.rejectedCandidates)}
          </span>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {claim.reviewedAt && (
              <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                Checked over
              </span>
            )}
            {claim.postingQueueId && (
              <span
                className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
                title="A person approved this claim for posting. Nothing has been written to Open Dental yet."
                data-testid={`claim-queued-${claim.claimId}`}
              >
                Approved
              </span>
            )}
          </div>
        </div>

        {/* ── WHERE THE PATIENT STANDS ───────────────────────────────────── */}
        <div className="min-w-0" data-testid={`claim-stands-${claim.claimId}`}>
          {verdict ? (
            /* Wraps, never truncates — see the header. The `title` went with
               the clipping it existed to compensate for. */
            <span
              className={`block break-words text-xs ${
                verdict.state === "red"
                  ? "font-medium text-rose-700 dark:text-rose-400"
                  : verdict.state === "amber"
                    ? "text-amber-800 dark:text-amber-300"
                    : "text-muted-foreground"
              }`}
            >
              {verdict.sentence}
            </span>
          ) : judged === null ? (
            <span className="block text-xs text-muted-foreground/70">…</span>
          ) : (
            <span className="block text-xs text-muted-foreground">
              Not judged yet — match it up and check it over.
            </span>
          )}
        </div>

        <Link
          href={claimHref(claim.claimId, batchId)}
          data-testid={`open-claim-${claim.claimId}`}
          className="inline-flex w-fit items-center gap-1 justify-self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted md:justify-self-end"
        >
          Open
          <ChevronRight size={11} />
        </Link>
      </div>

      {/*
        ── MATCH THIS CLAIM AGAIN — W-11 ──────────────────────────────────────
        The re-match left the page level, where it could only offer to re-run
        "the check", and became a row action that names the claim it means.

        FULL WIDTH, UNDER THE GRID, rather than squeezed into the 5.5rem action
        column: the label has to carry the word "again" and the word "claim" to
        be worth moving here at all, and a label that had to be shortened to fit
        would have arrived back where it started.

        RELEASING A CONFIRMED MATCH IS THE WRITE TIER'S ACT (D-9), and a reviewer
        gets the reason rather than a control that 403s.
      */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-border px-4 pb-2 pt-2">
        <div className="flex flex-col items-start gap-1">
          <button
            onClick={onRematch}
            disabled={matchBusy || (claim.odMatchStatus === "confirmed" && !mayRelease)}
            data-testid={`rematch-claim-${claim.claimId}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {rematching ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Search size={11} />
            )}
            Match this claim again
          </button>
          {claim.odMatchStatus === "confirmed" && !mayRelease ? (
            <DisabledReason testId={`rematch-reason-${claim.claimId}`}>
              This claim is already tied to a chart claim, and un-tying it needs posting
              permission. Ask an approver.
            </DisabledReason>
          ) : matchBusy && !rematching ? (
            <DisabledReason testId={`rematch-reason-${claim.claimId}`}>
              A match is already running. It reads Open Dental and writes nothing.
            </DisabledReason>
          ) : null}
        </div>
        {claim.odMatchStatus === "confirmed" && mayRelease && (
          <p className="max-w-md pt-0.5 text-xs text-muted-foreground">
            This one is already tied to a chart claim. Matching it again replaces that and un-ties
            it; the confirmation stays in the audit trail.
          </p>
        )}
        {rematchNote && (
          <p
            className="basis-full text-xs text-muted-foreground"
            data-testid={`rematch-note-${claim.claimId}`}
          >
            {rematchNote}
          </p>
        )}
      </div>

      {/* Review reasons — the flags Slices 4 and 5 wrote and nothing rendered. */}
      {claim.needsReviewReasons.length > 0 && (
        <div className="border-t border-border px-4 pb-3 pt-2" data-testid={`claim-flags-${claim.claimId}`}>
          {/*
            D-11: amber will HOLD this claim back at the approval gate; grey is
            true and does not change what to post. Both are always shown — a
            reason that vanished would make a proposal look cleaner than it is.
          */}
          <div className="flex flex-wrap gap-1.5">
            {claim.needsReviewReasons.map((reason) => (
              <span
                key={reason}
                data-testid={`claim-reason-${reason}`}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${reasonTone(reason)}`}
              >
                {isBlockingReason(reason) && <AlertTriangle size={11} />}
                {reviewReasonLabel(reason)}
              </span>
            ))}
          </div>

          {blocking.length > 0 && (
            <p
              className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"
              data-testid={`claim-not-approvable-${claim.claimId}`}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Matching this claim to a chart is still worth doing — but it cannot be approved for
                posting while {blocking.length === 1 ? "this holds" : "these hold"}. The approve
                screen says why.
              </span>
            </p>
          )}
          {deadEnd && (
            // Detect-and-flag means exactly that. A takeback is the single
            // IRREVERSIBLE Open Dental operation, so there is no action offered
            // here — only an honest statement and the manual route.
            <p
              className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
              data-testid={`claim-no-action-${claim.claimId}`}
            >
              <CircleSlash size={12} className="mt-0.5 shrink-0" />
              <span>
                CareIN will not post this. A takeback cannot be reversed in Open Dental once it is
                written — handle it in Open Dental directly, following the practice's takeback
                procedure.
              </span>
            </p>
          )}
        </div>
      )}

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
