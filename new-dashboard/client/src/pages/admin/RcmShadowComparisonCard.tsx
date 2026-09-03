/**
 * Admin → Offices → "Shadow-mode comparison" — the evidence behind the switch.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT IS ON THIS PAGE AND NOT ON A PAGE OF ITS OWN
 * ═════════════════════════════════════════════════════════════════════════════
 * Directly beneath the card that switches posting on, because it is the only
 * thing anybody should be reading before they press that. Shadow mode exists to
 * answer one question — does what this app worked out match what the biller
 * would have done by hand — and until C-2 the answer lived in a spreadsheet
 * somebody kept at 9pm, so the decision rested on an impression.
 *
 * No new nav item, no chart, no dashboard. An exit criterion beside the control
 * it justifies is one screen; anywhere else it is a report somebody has to
 * remember exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NUMBER THAT MATTERS IS THE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a proportion, and deliberately never one. The question is *has it stopped
 * getting things wrong*, and an average cannot answer that: nine matching checks
 * followed by one that differed is the same average as one that differed
 * followed by nine matching, and they mean opposite things.
 *
 * So the run is the headline, and it is computed server-side over the whole
 * practice rather than over the date range — a run that a start date happens to
 * cut in half is not a run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS NOT A REPORT CARD ON THE BILLER
 * ─────────────────────────────────────────────────────────────────────────────
 * The same rule the capture keeps. She is checking the software; the software is
 * the thing under examination. Nothing on this card is phrased as her record,
 * and `tests/rcm-plain-language.test.ts` holds a tighter banned list over this
 * file to keep it that way.
 *
 * `rcm.settings` — admin only, the same tier as the switch. The card renders
 * nothing at all for anybody else, because the server refuses even the read.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import {
  getComparisonSummary,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type ComparisonSummary,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { comparisonReasonLabel } from "@/features/rcm/comparison";
import { officeStamp } from "@/features/rcm/time";

function OfficeSummary({ office }: { office: RcmOfficeId }) {
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [summary, setSummary] = useState<ComparisonSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    getComparisonSummary(office, {
      from: range.from || undefined,
      to: range.to || undefined,
    }).then(
      (s) => {
        if (cancelled) return;
        setSummary(s);
        setError(null);
      },
      (e: unknown) => {
        if (cancelled) return;
        // The server's own sentence — a tenant without the RCM module says
        // exactly that rather than this card inventing "something went wrong".
        setError(
          e instanceof RcmApiError ? e.message : "Could not read this practice's comparisons.",
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [office, range.from, range.to]);

  useEffect(load, [load]);

  if (error) {
    return (
      <div
        className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
        data-testid={`rcm-comparison-error-${office}`}
      >
        <span className="font-medium text-foreground">{RCM_OFFICE_LABELS[office]}</span>
        <span>{error}</span>
      </div>
    );
  }

  if (!summary) {
    return (
      <div
        className="flex items-center gap-2 p-3 text-sm text-muted-foreground"
        data-testid={`rcm-comparison-loading-${office}`}
      >
        <Loader2 size={14} className="animate-spin" />
        {RCM_OFFICE_LABELS[office]}
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid={`rcm-comparison-${office}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{RCM_OFFICE_LABELS[office]}</span>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <label htmlFor={`rcm-comparison-from-${office}`}>From</label>
          <input
            id={`rcm-comparison-from-${office}`}
            type="date"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
          <label htmlFor={`rcm-comparison-to-${office}`}>to</label>
          <input
            id={`rcm-comparison-to-${office}`}
            type="date"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
        </div>
      </div>

      {/*
        THE HEADLINE, AND IT IS THE RUN.
        Stated in words rather than as a bare figure beside a label, because the
        thing being claimed — "the last N in a row came out the same" — is a
        sentence, and a reader who has to assemble it from a tile is a reader who
        will assemble it wrong.
      */}
      <p className="mt-2 text-sm text-foreground" data-testid={`rcm-comparison-run-${office}`}>
        {summary.matchedRun === 0
          ? summary.comparedAllTime === 0
            ? "No checks have been compared here yet."
            : "The most recent check compared here did not come out the same."
          : `The last ${summary.matchedRun} check${summary.matchedRun === 1 ? "" : "s"} compared here came out the same as the hand posting.`}
      </p>

      <p className="mt-1 text-sm text-muted-foreground" data-testid={`rcm-comparison-counts-${office}`}>
        {summary.compared} compared in this range — {summary.same} the same, {summary.differed} off.
        {summary.comparedAllTime !== summary.compared
          ? ` ${summary.comparedAllTime} compared in all.`
          : ""}
      </p>

      {summary.differences.length > 0 && (
        <>
          {/*
            ── THE NOTES BELOW ARE THE BILLER'S OWN WORDS ─────────────────────
            And she may have named a patient in one. The migration says exactly
            that of `comparison_note`, and it is true of every free-text column
            in this schema — which is why none of them is ever copied into an
            audit row or a log line.

            This screen has ONE reader: somebody writing up how the shadow
            period went. That is precisely the moment a patient's name gets
            copied out of a clinical system into a document that leaves it, and
            nothing downstream of here would catch it.

            So the caution sits directly above the notes rather than in the card
            header — a warning three paragraphs from the thing it is about is a
            warning people scroll past — and it names the safe alternative,
            because "do not copy this" with no way left to refer to the check
            is an instruction people work around rather than follow.
          */}
          <p
            className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground"
            data-testid={`rcm-comparison-phi-note-${office}`}
          >
            These lines are in the biller&rsquo;s own words, and one of them may name a patient.
            Read them here — don&rsquo;t paste them into a report, a message or a ticket. Refer to
            the check number instead.
          </p>
          <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[38rem] text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5 text-left font-semibold">Check</th>
                <th className="px-2 py-1.5 text-left font-semibold">What was off</th>
                <th className="px-2 py-1.5 text-left font-semibold">In their words</th>
                <th className="px-2 py-1.5 text-left font-semibold">Answered</th>
              </tr>
            </thead>
            <tbody>
              {summary.differences.map((d) => (
                <tr
                  key={d.batchId}
                  className="border-b border-border last:border-b-0 align-top"
                  data-testid={`rcm-comparison-row-${d.batchId}`}
                >
                  <td className="px-2 py-1.5">
                    <div className="font-mono text-xs text-foreground">
                      {d.checkNumber ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">{d.payer ?? "—"}</div>
                  </td>
                  <td className="px-2 py-1.5 text-sm text-foreground">
                    {comparisonReasonLabel(d.reason)}
                  </td>
                  <td className="px-2 py-1.5 text-sm text-muted-foreground">{d.note ?? "—"}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">
                    {d.answeredBy ? `${d.answeredBy} · ` : ""}
                    {officeStamp(d.answeredAt, office)}
                    {/* An answer that was changed says so — the newest one is not
                        presented as though it had always been the only one. */}
                    {d.revision > 1 ? " · changed since" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function RcmShadowComparisonCard() {
  const auth = useAuth();
  const scope = useRcmOfficeScope();

  const permissions = auth.status === "authenticated" ? auth.user.permissions : undefined;
  // Not merely "don't render" — don't ASK, on the settings card's own reasoning:
  // a request per office that we know will 403 fills the audit trail with noise
  // on every visit by somebody who is not an admin.
  if (!can(permissions, "rcm.settings")) return null;
  if (scope.loading || scope.offices.length === 0) return null;

  return (
    <Card data-testid="rcm-shadow-comparison-summary">
      <CardContent className="p-5">
        <div className="text-sm font-semibold text-foreground">Shadow-mode comparison</div>
        <p className="mt-1 text-sm text-muted-foreground">
          While posting is switched off, the biller says on each approved check whether what the app
          worked out came out the same as what she put into Open Dental by hand. This is what those
          answers add up to — and it is what switching posting on should be decided from.
        </p>
        <div className="mt-4 space-y-2">
          {scope.offices.map((office) => (
            <OfficeSummary key={office} office={office} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
