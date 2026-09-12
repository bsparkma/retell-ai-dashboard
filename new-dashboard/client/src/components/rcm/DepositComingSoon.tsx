/**
 * DEPOSIT — the step after Finished, which this app does not do yet (S5, artboard L).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A CARD FOR SOMETHING THAT DOES NOT EXIST
 * ═════════════════════════════════════════════════════════════════════════════
 * A biller who has just watched a check land in Open Dental asks the next
 * question herself: did the money hit the bank? The honest answer is that this
 * app cannot tell her, and silence reads as "that is taken care of". It is not.
 *
 * So the card is quiet on purpose — no colour, no button, no date — and it says
 * the one useful thing: keep doing deposits the way you do now. THIS CHECK's
 * amount sits beside an em-dash under HIT THE BANK, because a dash is what this
 * app actually knows about the bank side, and a $0.00 or a "pending" would be a
 * figure it made up.
 *
 * NO PROMISES. No "coming next month", no roadmap language. The day matching
 * lands, this component is replaced — not re-dated.
 */
import { Landmark } from "lucide-react";
import { money } from "@/features/rcm/format";
import Explainer from "@/components/rcm/Explainer";

export default function DepositComingSoon({
  checkAmountCents,
}: {
  /** The carrier's check total, as the bank would see it. Null renders a dash. */
  checkAmountCents: number | null;
}) {
  return (
    <section
      className="mt-3 rounded-lg border border-dashed border-border bg-background p-4"
      data-testid="deposit-coming-soon"
      aria-label="Deposit — coming soon"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Landmark size={14} className="text-muted-foreground" />
          Deposit
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Coming soon
        </span>
      </div>
      {/* S7: the chip above already says "Coming soon". The thirty words under
          it explaining what the feature WOULD do, and what to keep doing
          meanwhile, are worth one click and are not worth reading on every
          finished check. */}
      <Explainer testId="deposit-coming-soon-why" label="What this will do">
        <p className="max-w-3xl">
          Match this check against the bank deposit it arrived in — this app does not do that
          yet. Until then, keep reconciling deposits the way you do today.
        </p>
      </Explainer>
      <dl className="mt-3 grid max-w-sm grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="font-medium uppercase tracking-wide text-muted-foreground">This check</dt>
          <dd
            className="mt-0.5 font-mono text-sm tabular-nums text-foreground"
            data-testid="deposit-check-amount"
          >
            {checkAmountCents == null ? "—" : money(checkAmountCents)}
          </dd>
        </div>
        <div>
          <dt className="font-medium uppercase tracking-wide text-muted-foreground">
            Hit the bank
          </dt>
          <dd
            className="mt-0.5 font-mono text-sm tabular-nums text-muted-foreground"
            data-testid="deposit-bank-amount"
          >
            —
          </dd>
        </div>
      </dl>
    </section>
  );
}
