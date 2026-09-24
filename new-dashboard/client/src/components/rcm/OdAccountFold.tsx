/**
 * "IN THE PATIENT'S ACCOUNT" — S8 flow-speed, item 2.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS ANSWERS, AND WHY IT WAS NOT ANSWERABLE
 * ═════════════════════════════════════════════════════════════════════════════
 * A biller deciding whether an Open Dental claim is the one this EOB paid asks
 * one thing first: what is actually on it? The match panel printed six summary
 * rows — patient, born, subscriber, date, lines, billed — and a candidate card
 * printed four. None of them said which PROCEDURES the chart claim carries, what
 * each was billed, or whether the chart has already been paid something.
 *
 * All of that was already in hand. The match fetched the claimprocs to score the
 * candidate and `MatchCandidate.od.lines` has carried them since Slice 6a; the
 * screen simply never drew them. So this is not a new read and not a new
 * endpoint — it is the evidence the ranking was built from, shown to the person
 * being asked to agree with it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS A REAL `<details>`, FOR THE SAME TWO REASONS `Explainer` IS
 * ─────────────────────────────────────────────────────────────────────────────
 * Keyboard-operable and screen-reader-announced without JavaScript having to be
 * right about anything — and, for the word budget, genuinely absent from the
 * screen a reader arrives at. The sweep walks visible text and skips a closed
 * fold's body while keeping its summary, so the cost of this region on arrival
 * is the four words on its face, per card, and nothing else.
 *
 * It is NOT `Explainer`, deliberately: that component is the word diet's one
 * mechanism for moving PROSE down a level, and its body is muted 11px helper
 * text. This is evidence — a table of money a person compares by eye — and
 * giving it the explainer's face would tell a reader it was another paragraph
 * she could skip.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE COLOUR RULING
 * ═════════════════════════════════════════════════════════════════════════════
 * Red and amber on these screens mean the carrier and the chart DISAGREE. A
 * chart claim that has not been received yet is the normal state of a claim this
 * check is about to pay, so it renders in the neutral panel style, labelled
 * *Pending in Open Dental*, and says so in words.
 *
 * ONE THING IN HERE COLOURS: a line whose billed fee differs from the carrier's,
 * and it colours because `linePairs[].billedDeltaCents` — computed by the match,
 * read by `differences()` — says so. Nothing in this component re-compares two
 * amounts; a second opinion about agreement is precisely how an amber row ends
 * up beside a green verdict.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { Wallet } from "lucide-react";
import type { MatchCandidate } from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import { alreadyOnTheClaim, odAccountLines, odClaimStanding } from "@/features/rcm/odAccount";

export default function OdAccountFold({
  candidate,
  testId,
}: {
  candidate: MatchCandidate;
  testId: string;
}) {
  const standing = odClaimStanding(candidate.od.claimStatus);
  const lines = odAccountLines(candidate);
  const already = alreadyOnTheClaim(candidate);

  return (
    <details className="group mt-2" data-testid={testId}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        <Wallet size={12} aria-hidden />
        In the patient&rsquo;s account
      </summary>

      <div className="mt-2 rounded-lg border border-border bg-background p-3">
        {/*
          THE STANDING, IN THE NEUTRAL PANEL STYLE. Not amber, not rose — see
          the colour ruling in this file's header. The raw code rides beside the
          words because this repo can only prove what `R` means, and whoever
          needs to know which of the other letters it is should be able to read
          it rather than be told a guess.
        */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            data-testid={`${testId}-standing`}
            data-received={standing.received ? "true" : "false"}
          >
            {standing.label}
          </span>
          {standing.code && (
            <span className="font-mono text-[11px] text-muted-foreground">{standing.code}</span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-standing-detail`}>
          {standing.detail}
        </p>

        {/*
          ALREADY CARRYING MONEY is the one fact in this region worth more than
          the table under it, so it sits above the table rather than in it. It
          is stated, never coloured: whether it is a problem is the verdict's
          question and the verdict answers it elsewhere.
        */}
        {already && (
          <p className="mt-1 text-xs text-foreground" data-testid={`${testId}-already`}>
            {already}
          </p>
        )}

        {lines.length === 0 ? (
          /*
            NOT "no lines". The match may have read the claim header and not its
            procedures, and "this claim has no procedures on it" is a different
            and much more alarming statement than "this read did not carry them".
          */
          <p className="mt-2 text-xs text-muted-foreground" data-testid={`${testId}-no-lines`}>
            This match did not record the procedures on the chart claim.
          </p>
        ) : (
          <table className="mt-2 w-full text-xs" data-testid={`${testId}-lines`}>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-medium">Procedure</th>
                <th className="py-1 text-right font-medium">Billed</th>
                <th className="py-1 text-right font-medium">Estimate</th>
                <th className="py-1 text-right font-medium">Paid</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const differs = l.billedDeltaCents !== null && l.billedDeltaCents !== 0;
                return (
                  <tr
                    key={l.claimProcNum}
                    className="border-t border-border"
                    data-testid={`${testId}-line-${l.claimProcNum}`}
                    data-differs={differs ? "true" : undefined}
                  >
                    <td className="py-1">
                      <span className="font-mono text-foreground">{l.code || "—"}</span>
                      <span className="ml-1.5 font-mono text-muted-foreground">{l.status}</span>
                      {l.paymentAttached && (
                        <span className="ml-1.5 text-muted-foreground">check attached</span>
                      )}
                      {l.unreadable && (
                        <span className="ml-1.5 text-muted-foreground">not read</span>
                      )}
                    </td>
                    {/*
                      THE ONE CELL THAT MAY COLOUR, and only on the match's own
                      `billedDeltaCents`. The amount the chart holds stays
                      readable beside the distance, so the reader gets the value
                      and the disagreement in one glance.
                    */}
                    <td
                      className={`py-1 text-right font-mono tabular-nums ${
                        differs
                          ? "font-medium text-amber-800 dark:text-amber-300"
                          : "text-foreground"
                      }`}
                    >
                      {money(l.feeBilledCents)}
                      {differs && (
                        <span className="ml-1 font-sans">
                          ({money(Math.abs(l.billedDeltaCents as number))} apart)
                        </span>
                      )}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums text-muted-foreground">
                      {/* NULL IS NOT ZERO — Open Dental writes -1 for "not
                          calculated", so $0.00 here would state a number nobody
                          computed. */}
                      {l.insEstCents === null ? "not calculated" : money(l.insEstCents)}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums text-muted-foreground">
                      {money(l.insPayAmtCents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/*
          LINES THE READ COULD NOT SEE. The match excludes them from every total
          it computed, so a reader comparing the billed figure above against the
          carrier's needs to know the set it was summed over was short.
        */}
        {candidate.od.unknownDeletedLineCount > 0 && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid={`${testId}-unread`}>
            {candidate.od.unknownDeletedLineCount} more could not be read, and {}
            {candidate.od.unknownDeletedLineCount === 1 ? "it is" : "they are"} out of every total
            here.
          </p>
        )}
      </div>
    </details>
  );
}
