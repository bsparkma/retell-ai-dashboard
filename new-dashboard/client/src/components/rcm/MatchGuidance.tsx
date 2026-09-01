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
import { Building2, CheckCircle2, Info, Search } from "lucide-react";
import { Link } from "wouter";
import type { MatchCandidate, MatchSnapshot } from "@/features/rcm/api";
import { agreement, differences } from "@/features/rcm/matchWords";
import { day, money } from "@/features/rcm/format";
import { remittanceHref } from "@/features/rcm/flow";

export interface MatchGuidanceProps {
  snapshot: MatchSnapshot | null;
  /** What the CARRIER sent, for the comparison. */
  eob: { serviceDate: string | null; billedCents: number | null; patientName: string | null };
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
              href="/rcm/bring-in"
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

  // ── One clear candidate ────────────────────────────────────────────────────
  if (clear) {
    return (
      <section
        className="mt-4 rounded-xl border border-border bg-card p-4"
        data-testid="match-guidance-confident"
      >
        {/*
          THE HEADING NAMES WHAT THIS PANEL IS, NOT WHAT STATE THE CLAIM IS IN.
          Stage C-3, item 1: the state is said once, at the top of the page. Once
          a claim is linked this block stops being a recommendation and becomes
          the comparison — the carrier's version beside Open Dental's — which is
          the useful thing to keep on screen and a different thing to call it.
        */}
        <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
          <CheckCircle2 size={15} />
          {linked ? "How the two sides line up" : "This looks like the one"}
        </h2>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <IdentityColumn
            title="What the carrier sent"
            testId="match-guidance-eob"
            rows={[
              ["Patient", eob.patientName ?? "not recorded"],
              ["Service date", eob.serviceDate ? day(eob.serviceDate) : "not recorded"],
              ["Billed", eob.billedCents === null ? "not recorded" : money(eob.billedCents)],
            ]}
          />
          <IdentityColumn
            title="What Open Dental holds"
            testId="match-guidance-od"
            rows={[
              ["Patient", subject.od.patientName ?? "not recorded"],
              [
                "Born",
                subject.od.patientBirthdate ? day(subject.od.patientBirthdate) : "not recorded",
              ],
              ["Subscriber", subject.od.subscriberId ?? "not recorded"],
              ["Service date", subject.od.dateService ? day(subject.od.dateService) : "not recorded"],
              ["Billed", money(subject.od.billedCents)],
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
      <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
        <Info size={15} />
        More than one of these could be it
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Here is how each one differs from what the carrier sent. Nothing below decides between
        them — that is yours.
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
      <Footer />
    </section>
  );
}

/** One side of the identity comparison. */
function IdentityColumn({
  title,
  testId,
  rows,
}: {
  title: string;
  testId: string;
  rows: [string, string][];
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3" data-testid={testId}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <dl className="mt-1.5 space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right text-foreground">{value}</dd>
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
  const diffs = differences(c, eob);
  return (
    <div
      className="rounded-lg border border-border bg-background p-3"
      data-testid={`match-guidance-candidate-${c.odClaimNum}`}
    >
      <div className="font-mono text-sm font-medium text-foreground">ClaimNum {c.odClaimNum}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">
        {c.od.patientName ?? "Unknown patient"} · {c.od.dateService ? day(c.od.dateService) : "no date"}{" "}
        · {money(c.od.billedCents)}
      </div>

      {diffs.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing this app can compare differs from what the carrier sent.
        </p>
      ) : (
        <ul className="mt-2 space-y-0.5" data-testid={`match-guidance-diffs-${c.odClaimNum}`}>
          {diffs.map((d) => (
            <li
              key={d.kind}
              className={`text-xs ${
                d.notable ? "font-medium text-amber-800 dark:text-amber-300" : "text-muted-foreground"
              }`}
            >
              {d.phrase}
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={onConfirm}
        disabled={busy || linked}
        data-testid={`match-guidance-pick-${c.odClaimNum}`}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
      >
        {linked ? "Linked" : "This is the one"}
      </button>
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
