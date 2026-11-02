/**
 * A checkout card a later hygiene visit REOPENED (CO-5a fix, PM ruling): it had
 * been answered, the visit arrived, and it is back in Waiting. The badge says
 * so; the history line says what it had been answered with, by whom and when.
 * Nothing here is editable: the history is the server's `reopenedFrom`.
 */
import { History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { TC_CHECKOUT_OUTCOME_LABELS, type TcCheckoutReopened } from "@shared/tc/checkout";
import { checkoutClock } from "./CheckoutOutcome";

export const REOPENED_LABEL = "Updated — hygiene visit arrived after this was answered";

/** The badge alone, for a list row or a rail card. */
export function ReopenedBadge() {
  return (
    <Badge
      variant="outline"
      className="border-transparent bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200 gap-1"
      data-testid="checkout-reopened"
    >
      <History className="w-3 h-3" /> {REOPENED_LABEL}
    </Badge>
  );
}

/** "Was answered: Nothing needed · by … at …", plus the appointment note if there was one. Pure. */
export function reopenedHistoryLine(r: TcCheckoutReopened): string {
  const by = r.outcomeBy ? ` by ${r.outcomeBy}` : "";
  const at = r.outcomeAt ? ` at ${checkoutClock(r.outcomeAt)}` : "";
  const note = r.appointmentNote ? ` (${r.appointmentNote})` : "";
  return `Was answered: ${TC_CHECKOUT_OUTCOME_LABELS[r.outcome]}${note}${by}${at}. Reopened at ${checkoutClock(r.reopenedAt)}.`;
}

/** The badge and the history line together, for the workup and the sheet. */
export function ReopenedNotice({ reopened }: { reopened: TcCheckoutReopened }) {
  return (
    <div className="rounded-lg border border-sky-300/60 bg-sky-50 dark:bg-sky-950/40 p-3 space-y-1" data-testid="checkout-reopened-notice">
      <ReopenedBadge />
      <p className="text-sm text-foreground" data-testid="checkout-reopened-history">
        {reopenedHistoryLine(reopened)}
      </p>
    </div>
  );
}
