/**
 * MATCH IT UP — the sentence above the evidence (Stage C, §5).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS, AND WHAT IT DELIBERATELY LEAVES ALONE
 * ═════════════════════════════════════════════════════════════════════════════
 * The candidate cards below this block are UNCHANGED — Stage C does not touch
 * the workbench body (§12). They are the audit trail of a ranking: every
 * evidence chip with its weight, every blocker, every line pairing. That is the
 * right thing to keep and the wrong thing to read first.
 *
 * This block is what a person needs BEFORE the evidence: which of the two cases
 * she is in, and what the difference between the candidates actually is.
 *
 *   ONE CLEAR CANDIDATE → the agreement stated in words ("Name, birthday,
 *                         subscriber, date and every line agree.") and the two
 *                         things she can do about it.
 *   MORE THAN ONE       → the candidates side by side with the differences
 *                         MARKED IN WORDS — "six weeks earlier", "$54.00 less
 *                         billed" — rather than left to be inferred from a chip
 *                         reading `date near (42d) +4`.
 *
 * `features/rcm/matchWords.ts` produces those phrases and reads nothing but the
 * snapshot the cards are already drawing from. It ranks nothing, hides nothing
 * and picks nothing: match scoring is out of scope for this stage and untouched.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO ACTIONS ARE THE CARD'S OWN, NOT A SECOND PAIR
 * ─────────────────────────────────────────────────────────────────────────────
 * *Yes, that's the one* calls the SAME `onConfirm` the card's button calls —
 * one function, one route, one audit row. *Show me the others* scrolls to the
 * list rather than doing anything at all. A second control that confirmed a
 * match through its own path is exactly the duplication this stage exists to
 * remove.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HONEST DEAD-END, AND THE OFFICE IT SEARCHED
 * ─────────────────────────────────────────────────────────────────────────────
 * A claim that is not in Open Dental at all cannot be matched by looking harder,
 * and this screen has no way to create one. Saying so — and naming the thing she
 * CAN do, which is to save the check and enter the claim in the desktop — is the
 * difference between a screen that has run out of ideas and one that has an
 * answer she does not like.
 *
 * STAGE C-3 ADDS THE CASE THAT ACTUALLY HAPPENED. A check was brought in under
 * Valley and its claims lived in Roland. Every screen said which office had been
 * searched — *"against Valley — Fort Smith"*, in grey, at 11px, after a
 * timestamp — and it did not register, because a line that reads as a receipt is
 * read as a receipt. The office is now the loudest thing in this panel, and the
 * wrong-office remedy sits beside it: this is not a claim that is missing, it is
 * a check that came in under the wrong practice, and the fix is to set it aside
 * as sent in error and bring it in again on the right one.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { Building2, Check, CheckCircle2, Info, Search } from "lucide-react";
import Explainer from "@/components/rcm/Explainer";
import { Link } from "wouter";
import type { MatchCandidate, MatchSnapshot } from "@/features/rcm/api";
import { agreement, fieldReadings, likelihood, type FieldReading } from "@/features/rcm/matchWords";
import { CONFIDENCE_TONE, day, money } from "@/features/rcm/format";
import { remittanceHref } from "@/features/rcm/flow";
import DisabledReason from "@/components/rcm/DisabledReason";

export interface MatchGuidanceProps {
  snapshot: MatchSnapshot | null;
  /** What the CARRIER sent, for the comparison. */
  eob: {
    /**
     * The carrier's own claim number (CLP01), for the agreement sentence.
     *
     * Optional so a caller that genuinely has none is expressible; the sentence
     * simply does not name the field, exactly as it does not name a date nobody
     * sent. It is NEVER defaulted to a placeholder.
     */
    claimNumber?: string | null;
    serviceDate: string | null;
    billedCents: number | null;
    patientName: string | null;
    /**
     * S8 · the rest of the EOB card: the birthday and member number the
     * carrier sent (detail read only — PHI) and how many lines it paid. PRINTED
     * beside Open Dental's; never ticked, because the scorer compares neither
     * birthday nor member number at this step (see `fieldReadings`).
     */
    birthdate?: string | null;
    subscriberId?: string | null;
    lineCount?: number;
  };
  /**
   * S8 · WHERE THIS CLAIM SITS AMONG THE ONES THAT NEED A PERSON, from the
   * check's own claim list (the pager's read). Null when that list is not
   * loaded — the line is dropped rather than guessed.
   */
  progress?: {
    /** Claims on the check a person has linked. */
    matched: number;
    total: number;
    /** Claims on the check not linked yet. */
    needYou: number;
    /** 1-based place of THIS claim among those, or null if it is not one. */
    position: number | null;
  } | null;
  /** Already linked? Then this block reports rather than offers. */
  confirmedClaimNum: number | null;
  /** Disabled while another action is in flight. */
  busy: boolean;
  /** The claim page's own confirm — the same one the card's button calls. */
  onConfirm: (odClaimNum: number) => void;
  /** Scroll to the candidate list. Presentation only; it decides nothing. */
  onShowOthers: () => void;
  /**
   * Which check this claim came in on, when the URL said so.
   *
   * Only the dead-end reads it, and only to offer the way back to the one screen
   * that can set a check aside. Null degrades to naming the act without linking
   * to it — never to a guessed batch id.
   */
  fromBatchId?: string | null;
}

/**
 * How far ahead the leader must be for this block to call it clear.
 *
 * The SERVER already decides ambiguity and says so on the snapshot
 * (`snapshot.ambiguous`), and that is the answer this block obeys — it is not a
 * second opinion about the ranking. This constant only governs whether the
 * *wording* leads with one candidate or with a comparison, on a snapshot the
 * server did NOT call ambiguous.
 */
const CLEAR_ENOUGH = 1;

export default function MatchGuidance({
  snapshot,
  eob,
  confirmedClaimNum,
  busy,
  onConfirm,
  onShowOthers,
  fromBatchId = null,
  progress = null,
}: MatchGuidanceProps) {
  /*
   * NOTHING HAS RUN, OR THE SNAPSHOT IS IN AN OLDER SHAPE. The picker below
   * already says both of those in full, and repeating it here would be two
   * sentences about one silence.
   */
  if (!snapshot) return null;

  const candidates = snapshot.candidates;

  // ── Nothing to offer: the honest dead-end ──────────────────────────────────
  if (candidates.length === 0) {
    return (
      <section
        className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50/50 p-4 dark:border-amber-800 dark:bg-amber-950/20"
        data-testid="match-guidance-dead-end"
      >
        <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
          <Search size={15} />
          Nothing here to match it to
        </h2>

        {/*
          ── WHICH PRACTICE'S OPEN DENTAL WAS SEARCHED ─────────────────────────
          At heading weight, on its own line, before any advice — because the
          single most likely reason for this screen is that the answer to this
          question is the wrong practice, and a biller who reads it as a footnote
          goes looking for a claim that was never going to be there.
        */}
        <p
          className="mt-2 flex items-center gap-1.5 text-sm text-foreground"
          data-testid="match-guidance-office"
        >
          <Building2 size={15} className="shrink-0" />
          <span>
            Searched{" "}
            <strong className="font-semibold">{snapshot.officeName}</strong>&rsquo;s Open Dental.
          </span>
        </p>

        <p className="mt-2 text-sm text-muted-foreground">
          It offered nothing this app is willing to link. Looking again will not change that on its
          own.
        </p>

        {/*
          THE WRONG-OFFICE CASE, NAMED AND ANSWERED — Stage C-3, item 7.
          It is the first thing to rule out, so it is the first remedy offered.
        */}
        <div
          className="mt-3 rounded-lg border border-border bg-background p-3"
          data-testid="match-guidance-wrong-office"
        >
          <p className="text-sm font-medium text-foreground">
            Does this patient belong to your other office?
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Then this check was brought in under the wrong office — set it aside as sent in error,
            and bring it in again under the right one. Nothing on it can ever be matched here.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {fromBatchId && (
              <Link
                href={remittanceHref(fromBatchId)}
                data-testid="match-guidance-set-aside"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Go to the check to set it aside
              </Link>
            )}
            <Link
              href="/rcm?add=1"
              data-testid="match-guidance-bring-in"
              className="text-xs font-medium text-foreground underline underline-offset-4"
            >
              Bring a check in under another office
            </Link>
          </div>
        </div>

        <p className="mt-3 text-sm text-foreground">
          If it is this office&rsquo;s patient and the claim simply isn&rsquo;t in Open Dental yet,
          save the check for tomorrow and enter the claim first. Then match it up again and it will
          be here.
        </p>
        <Footer />
      </section>
    );
  }

  const linked = confirmedClaimNum !== null;
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * ONCE LINKED, THE HERO IS ABOUT THE LINKED CLAIM — NOT THE LEADER
   * ═══════════════════════════════════════════════════════════════════════════
   * This block used to compare the EOB against `candidates[0]` unconditionally.
   * A biller who linked the RUNNER-UP — which is the whole reason the list is
   * offered rather than the top one auto-confirmed — then read a comparison of
   * her EOB against a claim she had just declined, under a heading saying this
   * was the one it was linked to, with the OTHER claim's billed total in it.
   *
   * Stage C-3 made that visible by folding the list: with one card open beside
   * this panel, the two disagreeing about which chart claim is in play stopped
   * being something the eye could slide past. So the subject follows the link.
   *
   * `?? candidates[0]` covers a confirmation whose claim is not in this
   * snapshot — a forced re-run, an older record — and the surrounding screen
   * already reports that case (the stale chip, the run button's own copy).
   */
  const subject =
    (linked ? candidates.find((c) => c.odClaimNum === confirmedClaimNum) : null) ?? candidates[0];
  const runnerUp = candidates[1] ?? null;
  /*
   * THE SERVER'S OWN AMBIGUITY ANSWER FIRST. Only when it did NOT call the
   * snapshot ambiguous does the gap decide the wording.
   *
   * AND A LINKED CLAIM IS NEVER "more than one of these could be it" — a person
   * settled it. Ambiguity is a question about a decision that has not been made;
   * once it has, the panel's job is to show what was chosen.
   */
  const clear =
    linked ||
    (!snapshot.ambiguous &&
      (runnerUp === null || subject.score - runnerUp.score >= CLEAR_ENOUGH));
  const agrees = agreement(subject, eob);
  const readings = fieldReadings(subject, eob);
  /*
   * "FITS PERFECTLY" IS A CLAIM, AND IT IS ONLY MADE WHEN IT IS TRUE.
   *
   * The board's confident heading is "Found it — one claim in Open Dental fits
   * this one perfectly." That is honest on exactly one shape: the carrier's
   * claim number names this claim (the scorer's own tag) AND nothing the app can
   * compare differs (`agreement()` returned a sentence rather than null). A
   * clear leader that is merely AHEAD — the server did not call it ambiguous,
   * but a date or an amount is off — keeps the shipped "This looks like the
   * one", because "perfectly" over an amber row would be the heading
   * contradicting the card under it.
   */
  const perfect = agrees !== null && readings.claimNumber.status === "agrees";

  // ── One clear candidate ────────────────────────────────────────────────────
  if (clear) {
    return (
      <section
        className="mt-4 rounded-xl border border-border bg-card p-4"
        data-testid="match-guidance-confident"
      >
        {!linked && <MatchHeading progress={progress} />}
        {/*
          THE HEADING NAMES WHAT THIS PANEL IS, NOT WHAT STATE THE CLAIM IS IN.
          Stage C-3, item 1: the state is said once, at the top of the page. Once
          a claim is linked this block stops being a recommendation and becomes
          the comparison — the carrier's version beside Open Dental's — which is
          the useful thing to keep on screen and a different thing to call it.
        */}
        <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
          <CheckCircle2 size={15} />
          {linked
            ? "How the two sides line up"
            : perfect
              ? "Found it — one claim in Open Dental fits this one perfectly."
              : "This looks like the one"}
        </h2>

        {/*
          S8 · THE TWO CARDS THE BOARD DRAWS, THE SAME ROWS ON EACH.
          The carrier's card and Open Dental's, field for field — patient, born,
          subscriber, service date, lines, billed — so the eye reads across a
          row rather than hunting for the matching fact in the other column.
          Open Dental's card carries the tick, or the amber delta, on every
          field the scorer compares (see `fieldReadings`), and nothing on the
          two it does not.
        */}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <IdentityColumn
            title="What the carrier sent"
            testId="match-guidance-eob"
            rows={[
              ["Patient", eob.patientName ?? "not recorded"],
              ["Born", eob.birthdate ? day(eob.birthdate) : "not recorded"],
              ["Subscriber", eob.subscriberId ?? "not recorded"],
              ["Service date", eob.serviceDate ? day(eob.serviceDate) : "not recorded"],
              ["Lines", typeof eob.lineCount === "number" ? String(eob.lineCount) : "not recorded"],
              ["Billed", eob.billedCents === null ? "not recorded" : money(eob.billedCents)],
            ]}
          />
          <IdentityColumn
            title={`Open Dental claim ${subject.odClaimNum}`}
            titleMark={readings.claimNumber}
            accent
            testId="match-guidance-od"
            rows={[
              ["Patient", subject.od.patientName ?? "not recorded", readings.name],
              [
                "Born",
                subject.od.patientBirthdate ? day(subject.od.patientBirthdate) : "not recorded",
              ],
              ["Subscriber", subject.od.subscriberId ?? "not recorded"],
              [
                "Service date",
                subject.od.dateService ? day(subject.od.dateService) : "not recorded",
                readings.date,
              ],
              ["Lines", linesPaired(subject), readings.lines],
              ["Billed", money(subject.od.billedCents), readings.amount],
            ]}
          />
        </div>

        {/* THE AGREEMENT, IN WORDS, AND ONLY OVER FIELDS IT COULD COMPARE. */}
        <p className="mt-3 text-sm text-foreground" data-testid="match-guidance-agreement">
          {agrees ??
            "There is not enough recorded on both sides to say they agree — read the evidence below before linking."}
        </p>

        {!linked && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => onConfirm(subject.odClaimNum)}
              disabled={busy}
              data-testid="match-guidance-confirm"
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <CheckCircle2 size={14} />
              Yes, that&rsquo;s the one
            </button>
            <button
              onClick={onShowOthers}
              data-testid="match-guidance-show-others"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Show me other claims
            </button>
          </div>
        )}
        <Footer />
      </section>
    );
  }

  // ── More than one, and they are close ──────────────────────────────────────
  return (
    <section
      className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-900/60 dark:bg-amber-950/15"
      data-testid="match-guidance-unsure"
    >
      <MatchHeading progress={progress} />
      {/* S8: the board's heading, and it COUNTS — "more than one" left the
          reader to count the cards, and the cards below show at most three. */}
      <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
        <Info size={15} />
        Not sure about this one — {candidates.length} claims could be it.
      </h2>
      {/* S7: the heading already says more than one could be it, and the cards
          below already print the differences. What is worth keeping is the
          refusal — the app has NOT chosen — and it is one click down rather
          than a paragraph between the heading and the evidence. */}
      <Explainer testId="match-guidance-unsure-why" label="How to read these">
        <p>
          Here is how each one differs from what the carrier sent. Nothing below decides between
          them — that is yours.
        </p>
      </Explainer>

      {/*
        S8 · THE CARRIER'S SIDE, ONCE, ABOVE THE CANDIDATES — what every card
        below is being compared against. The cards used to carry only Open
        Dental's figures and a list of differences, and "6 weeks earlier" is a
        distance from something the card never printed.
      */}
      <p className="mt-2 text-sm text-foreground" data-testid="match-guidance-eob-summary">
        <span className="text-muted-foreground">The carrier sent:</span>{" "}
        {eob.patientName ?? "no patient name"}
        {eob.serviceDate ? ` · ${day(eob.serviceDate)}` : ""}
        {eob.billedCents !== null ? ` · ${money(eob.billedCents)}` : ""}
        {typeof eob.lineCount === "number"
          ? ` · ${eob.lineCount} line${eob.lineCount === 1 ? "" : "s"}`
          : ""}
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {candidates.slice(0, 3).map((c) => (
          <CandidateSummary
            key={c.odClaimNum}
            candidate={c}
            eob={eob}
            linked={confirmedClaimNum === c.odClaimNum}
            busy={busy || linked}
            onConfirm={() => onConfirm(c.odClaimNum)}
          />
        ))}
      </div>

      {candidates.length > 3 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {candidates.length - 3} more below, with the full evidence for each.
        </p>
      )}

      <NeitherOfThese fromBatchId={fromBatchId} />
      <Footer />
    </section>
  );
}

/**
 * "MATCH IT UP" — the board's title row for a claim nobody has linked yet.
 *
 * The step's name (the rail's own CTA verb) and where this claim sits in the
 * check's matching: how many a person has linked, how many still need one, and
 * which of THOSE this is. Every number comes off the check's own claim list —
 * `progress`, from the read the pager already makes — and the whole line is
 * dropped when that list is not loaded, rather than guessed at.
 *
 * NOT "FOUND ON THEIR OWN". The artboard counts claims "found on their own",
 * and none are: this module never confirms a match without a person pressing a
 * button (review-then-send). The honest count is how many are MATCHED — linked
 * by somebody — and that is the word used.
 */
function MatchHeading({ progress }: { progress: MatchGuidanceProps["progress"] }) {
  return (
    <div
      className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-3"
      data-testid="match-heading"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          className="text-lg font-semibold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          Match it up
        </h2>
        {progress && (
          <span className="text-sm text-muted-foreground" data-testid="match-heading-progress">
            {progress.matched} of {progress.total} claims matched · {progress.needYou}{" "}
            {progress.needYou === 1 ? "needs" : "need"} you
          </span>
        )}
      </div>
      {progress && progress.position !== null && (
        <span className="text-xs font-medium text-muted-foreground" data-testid="match-heading-position">
          Claim {progress.position} of {progress.needYou} that needs you
        </span>
      )}
    </div>
  );
}

/**
 * "NEITHER OF THESE?" — the honest fallback.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE IS NO CLAIM SEARCH IN THIS LANE, AND THIS DOES NOT INVENT ONE
 * ═════════════════════════════════════════════════════════════════════════════
 * The obvious thing to put here is a search box: type a name, pick the claim,
 * link it. `/api/rcm` has no patient or claim search to put behind one — every
 * read on this lane is keyed by an id the app already holds, and Stage C §15.1c
 * names the missing search as an open backend ask. The searches that DO exist
 * live in other modules, behind their own entitlement gates, and reaching into
 * one of them from here would put a chart lookup on a route this practice may
 * not be entitled to at all.
 *
 * So this says what is true and names the move that works. A dead search box
 * that returns nothing, or one wired to another module's endpoint, would both
 * be worse than a sentence: the first wastes the one minute somebody had, and
 * the second is a PHI read through a door nobody opened for it.
 *
 * IT IS THE SAME ADVICE THE DEAD-END GIVES, deliberately — a biller who has read
 * one of these screens has read both, and "the claim is not in Open Dental" has
 * one answer whether the search returned nothing or returned the wrong things.
 */
function NeitherOfThese({ fromBatchId }: { fromBatchId: string | null }) {
  return (
    <div
      className="mt-3 rounded-lg border border-border bg-background p-3"
      data-testid="match-guidance-neither"
    >
      <p className="text-sm font-medium text-foreground">Neither of these?</p>
      <p className="mt-1 text-sm text-muted-foreground">
        If this claim isn&rsquo;t in Open Dental at all, save the check for tomorrow and enter the
        claim first. Then match it up again and it will be here.
      </p>
      {fromBatchId && (
        <Link
          href={remittanceHref(fromBatchId)}
          data-testid="match-guidance-neither-park"
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          Go to the check to save it for tomorrow
        </Link>
      )}
    </div>
  );
}

/**
 * THE MARK AFTER A VALUE — S8.
 *
 * A tick for a field `fieldReadings` says agrees; nothing for one it did not
 * compare. A field that DIFFERS is not marked here — the row prints the
 * difference phrase in place of the bare value, in amber (see `FieldValue`), so
 * the reader gets the value and the distance in one line.
 */
function AgreeTick({ reading }: { reading?: FieldReading }) {
  if (reading?.status !== "agrees") return null;
  return (
    <Check
      size={12}
      strokeWidth={3}
      className="ml-1 inline shrink-0 align-[-1px] text-emerald-600 dark:text-emerald-400"
      aria-label="agrees"
      role="img"
    />
  );
}

/**
 * One field's value as a card prints it: the difference phrase when the field
 * differs (value, then delta, verbatim from `differences()`), otherwise the
 * value with its tick. Notable differences are amber; the rest are muted, so a
 * card's weight lands on the thing that should stop somebody.
 */
function FieldValue({ value, reading }: { value: string; reading?: FieldReading }) {
  if (reading?.status === "differs") {
    return (
      <span
        className={
          reading.notable
            ? "font-medium text-amber-800 dark:text-amber-300"
            : "text-muted-foreground"
        }
      >
        {reading.phrase}
      </span>
    );
  }
  return (
    <span className="text-foreground">
      {value}
      <AgreeTick reading={reading} />
    </span>
  );
}

/**
 * THE LINES ROW, AS THE SCORER COMPARES IT — "2 of 2".
 *
 * How many of the carrier's lines found a line in this Open Dental claim, out of
 * how many the carrier sent: `linePairs`, the same pairing `differences()` and
 * `agreement()` read. It is NOT the chart claim's own line count. A first draft
 * printed `od.lines.length` beside a tick earned by the pairing, and on a
 * snapshot that did not carry the chart's lines that read "0 ✓" — a zero with a
 * tick beside it, the value and its mark contradicting each other. Printing the
 * compared fact itself means the tick is always about the number next to it.
 */
function linesPaired(c: MatchCandidate): string {
  // No pairing on the snapshot is "not recorded", never "0 of 0" — which would
  // read as a claim with no lines rather than a comparison nobody made. It is
  // also exactly when `fieldReadings` says `not_compared`, so no tick either.
  if (c.linePairs.length === 0) return "not recorded";
  const paired = c.linePairs.filter((p) => p.odClaimProcNum !== null).length;
  return `${paired} of ${c.linePairs.length}`;
}

/** One side of the identity comparison. */
function IdentityColumn({
  title,
  titleMark,
  accent = false,
  testId,
  rows,
}: {
  title: string;
  /** The claim-number reading, ticked on the title when it agrees. */
  titleMark?: FieldReading;
  /** Open Dental's card on the board wears the green edge. */
  accent?: boolean;
  testId: string;
  /** label, value, and — only on a field the scorer compares — its reading. */
  rows: [string, string, FieldReading?][];
}) {
  return (
    <div
      className={`rounded-lg border bg-background p-3 ${
        accent ? "border-emerald-300 dark:border-emerald-800" : "border-border"
      }`}
      data-testid={testId}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        <AgreeTick reading={titleMark} />
      </div>
      <dl className="mt-1.5 space-y-1">
        {rows.map(([label, value, reading]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-right">
              <FieldValue value={value} reading={reading} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One candidate, with its differences spelled out. */
function CandidateSummary({
  candidate: c,
  eob,
  linked,
  busy,
  onConfirm,
}: {
  candidate: MatchCandidate;
  eob: MatchGuidanceProps["eob"];
  linked: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  const readings = fieldReadings(c, eob);
  return (
    <div
      className="rounded-lg border border-border bg-background p-3"
      data-testid={`match-guidance-candidate-${c.odClaimNum}`}
    >
      {/*
        LIKELY / POSSIBLE — the scorer's own band, in two words.

        `likelihood()` reads `c.confidence`, which the SERVER computed from its
        published bands. This card invents no cutoff, re-ranks nothing and hides
        nothing; the raw `HIGH · 82` chip is still on the full candidate card in
        the workbench below, for anybody querying the ranking. What changes here
        is only that the first thing read is a word rather than a band name.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid={`match-guidance-likelihood-${c.odClaimNum}`}
          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${CONFIDENCE_TONE[c.confidence]}`}
        >
          {likelihood(c)}
        </span>
        <span className="font-mono text-sm font-medium text-foreground">
          ClaimNum {c.odClaimNum}
          <AgreeTick reading={readings.claimNumber} />
        </span>
      </div>

      {/*
        S8 · FIELD ROWS, A TICK OR A DIFFERENCE ON EACH.
        This was one summary line and, under it, a list of whatever differed —
        so a field that AGREED was simply absent, and a reader could not tell
        "the same" from "not compared". Now every field the scorer compares has
        a row: the value with a tick, or the difference phrase in its place.
        Nothing is added that `differences()` did not already say; the testid
        stays on the rows so every phrase is where the walk looks for it.
      */}
      <dl className="mt-2 space-y-0.5 text-xs" data-testid={`match-guidance-diffs-${c.odClaimNum}`}>
        {(
          [
            ["Patient", c.od.patientName ?? "not recorded", readings.name],
            ["Service date", c.od.dateService ? day(c.od.dateService) : "not recorded", readings.date],
            ["Billed", money(c.od.billedCents), readings.amount],
            ["Lines", linesPaired(c), readings.lines],
          ] as [string, string, FieldReading][]
        ).map(([label, value, reading]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-right">
              <FieldValue value={value} reading={reading} />
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-2 flex flex-col items-start gap-1">
        <button
          onClick={onConfirm}
          disabled={busy || linked}
          data-testid={`match-guidance-pick-${c.odClaimNum}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
        >
          {linked ? "Linked" : "This is the one"}
        </button>
        {/* A label that changes to "Linked" tells a reader who was watching.
            It does not tell one who arrived after the fact, and it is not a
            reason anything can enforce. */}
        {linked && (
          <DisabledReason testId={`match-guidance-linked-${c.odClaimNum}`}>
            Already tied to this claim. Look again to change it.
          </DisabledReason>
        )}
      </div>
    </div>
  );
}

/**
 * THE ONE SENTENCE THIS STEP OWES.
 *
 * Matching reads Open Dental and writes nothing to it. A biller who does not
 * know that treats every candidate press as a commitment, which is precisely
 * how somebody ends up refusing to press anything.
 */
function Footer() {
  return (
    <p className="mt-3 text-xs text-muted-foreground" data-testid="match-guidance-footer">
      Nothing is written to Open Dental in this step — matching only tells the app which claim you
      mean.
    </p>
  );
}
