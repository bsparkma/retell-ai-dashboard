/**
 * "Alert checkout" — the hygienist tells the front desk this patient is on the
 * way, with what she staged (queue item 49).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE PRESS, ONE HANDOFF
 * ═════════════════════════════════════════════════════════════════════════════
 * The button sends NOW, because the point is catching the patient before they
 * leave. The visit's Send then updates the same handoff with the final notes
 * and treatment; this component says which of those has happened. A second
 * press is answered by the server as "already alerted" and sends nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HONEST STATES
 * ═════════════════════════════════════════════════════════════════════════════
 * "Checkout alerted" renders from `sent` — the visit's `checkoutSend`, which the
 * server writes only after TC answered with a handoff. A refusal shows here in
 * words. A visit Send whose handoff update did not land says so, with a retry
 * that re-sends ONLY the handoff (the chart writes are done and stay done).
 */
import { AlertTriangle, BellRing, CheckCircle2, Loader2, RefreshCw } from "lucide-react";

import type { CheckoutDelivery, CheckoutSend } from "@shared/hyg/contract";
import { cn } from "@/lib/utils";

/** "9:42 AM" in the office's own reading of the instant. */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

export interface CheckoutAlertProps {
  sent: CheckoutSend | null;
  sending: boolean;
  error: string | null;
  /** What the last visit Send said about the handoff; null when it has not run. */
  delivery: CheckoutDelivery | null;
  onAlert: () => void;
  onRetryFinal: () => void;
}

export function CheckoutAlert({
  sent,
  sending,
  error,
  delivery,
  onAlert,
  onRetryFinal,
}: CheckoutAlertProps) {
  const undelivered = delivery !== null && delivery.state === "not_delivered";
  return (
    <section
      className="rounded-xl border border-border bg-card p-3"
      aria-label="Checkout"
      data-testid="checkout-alert"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        {sent ? (
          <div
            className="flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
            data-testid="checkout-alerted"
          >
            <CheckCircle2 size={18} aria-hidden />
            <span>
              Checkout alerted at {clock(sent.sentAt)}
              <span className="font-normal text-muted-foreground">
                {sent.finalAt
                  ? ` · final notes sent at ${clock(sent.finalAt)}`
                  : " · your final notes go with Send"}
              </span>
            </span>
          </div>
        ) : (
          <p className="max-w-md text-sm text-muted-foreground">
            Tell the front desk this patient is on the way, with what you staged. Send updates it
            with your final notes.
          </p>
        )}
        {!sent ? (
          <button
            type="button"
            onClick={onAlert}
            disabled={sending}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold",
              "bg-primary text-primary-foreground disabled:opacity-50",
            )}
            data-testid="checkout-alert-button"
          >
            {sending ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : (
              <BellRing size={16} aria-hidden />
            )}
            {sending ? "Alerting checkout…" : "Alert checkout"}
          </button>
        ) : null}
      </div>

      {undelivered ? (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          role="status"
          data-testid="checkout-undelivered"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle size={16} aria-hidden />
            The front desk did not get your final notes. Your chart writes are not affected.
          </span>
          <button
            type="button"
            onClick={onRetryFinal}
            disabled={sending}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-amber-400 px-3 font-medium disabled:opacity-50 dark:border-amber-700"
            data-testid="checkout-retry-final"
          >
            <RefreshCw size={14} aria-hidden /> Send to the front desk again
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-sm text-destructive" role="alert" data-testid="checkout-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
