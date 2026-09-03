/**
 * SHADOW MODE — the state, and what this app would have done (Stage C, §10).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT SHADOW MODE IS TO A BILLER, AND WHY A BADGE IS NOT ENOUGH
 * ═════════════════════════════════════════════════════════════════════════════
 * Posting is switched off for this practice. Everything she does still counts —
 * the matching, the checking over, the write-off decisions, the approve — and
 * the last step does not run. That is the next four weeks of this product's
 * life (RCM_POSTING §14.0), and a chip reading *Shadow* does not explain a month.
 *
 * So the banner says four things, in this order:
 *
 *   1. WHAT IS TRUE      posting is off; nothing here reaches a chart.
 *   2. WHAT IS SAFE      every decision is saved, and it will still be there.
 *   3. WHAT CHANGES      when it is switched on, the same button posts them.
 *   4. WHO CAN SWITCH IT an administrator, under Admin → Office. She is not
 *                        being asked to fix this and should not go looking.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "WHAT THIS APP WOULD HAVE DONE" — THE SAME ROLL-UP, AND WHY IT IS HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * A practice in shadow mode is posting BY HAND while this app watches. The most
 * useful thing on the screen is therefore the same table the approve page shows:
 * one row per claim, what each patient would owe, what the office decided to
 * absorb. Printed, or kept open on the second monitor, it is the worksheet.
 *
 * It is `rollUp()` over the SAME per-claim verdicts (`features/rcm/rollup.ts`),
 * so it cannot disagree with the approve page — a second table computing the
 * same money is exactly what that module exists to prevent.
 *
 * PRINTABLE for real: `@media print` hides the shell and everything on the page
 * that is not this table, so File → Print produces the worksheet and not a
 * screenshot of an app.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT HERE — C-2
 * ─────────────────────────────────────────────────────────────────────────────
 * The yes/no capture — *did the app get this check right?* — SHIPPED in C-2, as
 * `components/rcm/CheckComparison.tsx`. It is a sibling section rendered
 * directly beneath this one by `pages/rcm/RemittanceDetail.tsx`, which is the
 * room this note was reserving.
 *
 * It is deliberately NOT nested inside this component. The worksheet below
 * renders only when the roll-up has rows, and the question is asked of every
 * approved check in shadow mode — nesting it would have let an unrelated
 * condition decide whether the record gets captured at all.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { Info, Printer } from "lucide-react";
import type { ApprovalClaim, RcmOfficeId } from "@/features/rcm/api";
import { RCM_OFFICE_LABELS } from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import { SHADOW_MODE_COPY } from "@/features/rcm/posting";
import { rollUp } from "@/features/rcm/rollup";

/**
 * The class that survives printing.
 *
 * Applied to the worksheet, and to nothing else. `index.css` carries one
 * `@media print` block that hides everything without it — one rule, in one
 * place, rather than a `print:hidden` sprinkled over every layout.
 */
export const PRINT_ONLY_CLASS = "rcm-print-worksheet";

export default function ShadowModeBanner({
  office,
  claims,
  /** Where an admin would go. Null hides the affordance rather than guessing. */
  settingsHref = "/admin",
}: {
  office: RcmOfficeId;
  /**
   * The approval preview's claims, for the worksheet. Empty renders the banner
   * without the table — the state is worth saying even when there is nothing
   * approved yet to say it about.
   */
  claims: readonly ApprovalClaim[];
  settingsHref?: string | null;
}) {
  const roll = rollUp(claims);

  return (
    <section
      className="mt-4 rounded-xl border border-border bg-muted/30 p-4"
      data-testid="shadow-mode-banner"
    >
      <div className="flex items-start gap-2">
        <Info size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Posting is switched off for {RCM_OFFICE_LABELS[office]}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-foreground">
            Everything you do here still counts. Matching, checking over, the write-offs you decide
            and pressing approve are all saved, and they will still be here. The only step that does
            not run is the last one — nothing on this screen reaches a patient&rsquo;s chart.
          </p>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            When posting is switched on, the same button posts these checks — the work does not have
            to be done again.
          </p>
          {/*
            WHO CAN SWITCH IT ON. She is not being asked to fix this, and a
            state with no named owner is one people go looking for a way around.
          */}
          <p className="mt-1 text-sm text-muted-foreground" data-testid="shadow-who-can">
            <strong className="font-medium text-foreground">Who can switch this on?</strong>{" "}
            {SHADOW_MODE_COPY.fix}{" "}
            {settingsHref && (
              <a
                href={settingsHref}
                className="font-medium text-foreground underline underline-offset-4"
                data-testid="shadow-settings-link"
              >
                Open Admin
              </a>
            )}
          </p>
        </div>
      </div>

      {/* ── WHAT THIS APP WOULD HAVE DONE ──────────────────────────────────── */}
      {roll.rows.length > 0 && (
        <div className={`mt-4 ${PRINT_ONLY_CLASS}`} data-testid="shadow-would-have-done">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              What this app would have done, if posting were on
            </h3>
            <button
              onClick={() => window.print()}
              data-testid="shadow-print"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted print:hidden"
            >
              <Printer size={12} />
              Print this
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground print:hidden">
            Print this or keep it open on the second monitor while you post by hand. Every figure is
            the one the approve screen shows — this is the same table, not a second calculation.
          </p>

          <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold">Patient</th>
                  <th className="px-3 py-2 text-right font-semibold">Office write-off</th>
                  <th className="px-3 py-2 text-right font-semibold">EOB says</th>
                  <th className="px-3 py-2 text-right font-semibold">Patient would owe</th>
                </tr>
              </thead>
              <tbody>
                {roll.rows.map((row) => (
                  <tr
                    key={row.claimId}
                    className="border-b border-border last:border-b-0"
                    data-testid={`shadow-row-${row.claimId}`}
                  >
                    <td className="px-3 py-2">
                      <div className="text-sm text-foreground">{row.patientName}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        #{row.claimNumber}
                      </div>
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
                      // NOT JUDGED IS NOT ZERO — the same rule the approve page
                      // applies, and for the same reason: a blank worksheet cell
                      // is a question, a "$0.00" is a wrong answer.
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground" colSpan={3}>
                        Not judged
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30" data-testid="shadow-total">
                  <td className="px-3 py-2 text-sm font-semibold text-foreground">
                    {roll.judged} of {roll.rows.length} claim{roll.rows.length === 1 ? "" : "s"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-foreground">
                    {roll.decidedWriteOffCents === 0 ? "—" : money(roll.decidedWriteOffCents)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-foreground">
                    {money(roll.eobPatientCents)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-foreground">
                    {money(roll.projectedPatientCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/*
            C-2's yes/no capture lands directly BELOW this whole section, as its
            own component. See this file's header for why it is a sibling rather
            than a child.
          */}
        </div>
      )}
    </section>
  );
}
