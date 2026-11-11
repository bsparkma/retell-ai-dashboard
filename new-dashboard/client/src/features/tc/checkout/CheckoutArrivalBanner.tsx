/**
 * The checkout arrival BANNER (Beau's prominence ruling, with CO-6/CO-7).
 *
 * "<patient> is headed to checkout" used to be a toast that slid away on its
 * own. It is now a persistent, high-contrast banner at the top of every page
 * (DashboardLayout draws it app-wide, the way the toast was), with a subtle
 * pulse on its marker, and it STAYS until the person acknowledges it:
 *
 *   Open          go to that patient's card on the Checkout page (and acknowledge it)
 *   Acknowledge   that arrival's line goes away
 *   Acknowledge all   (two or more) every line goes away
 *
 * NO SOUND. The pulse respects reduced motion (motion-safe). The arrivals come
 * from useCheckoutWatch, which holds them in memory only.
 */
import { BellRing, Check, DoorOpen } from "lucide-react";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import type { CheckoutArrival } from "@/features/tc/checkout/useCheckoutWatch";

export function CheckoutArrivalBanner({
  arrivals,
  onAcknowledge,
}: {
  arrivals: readonly CheckoutArrival[];
  /** One arrival by id, or all of them with no id. */
  onAcknowledge: (handoffId?: string) => void;
}) {
  const [, navigate] = useLocation();
  if (arrivals.length === 0) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex-shrink-0 border-b-2 border-amber-700 bg-amber-300 text-black dark:border-amber-200 dark:bg-amber-300 dark:text-black"
      data-testid="checkout-arrival-banner"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-1.5 px-4 py-2.5">
        {arrivals.map((a) => (
          <div key={a.handoffId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="checkout-arrival">
            <span className="relative flex h-3 w-3 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-600 opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-700" />
            </span>
            <BellRing className="h-4 w-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 text-sm font-semibold">
              <span data-testid="checkout-arrival-name">{a.patientName}</span> is headed to checkout
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-black text-white hover:bg-black/80"
                onClick={() => {
                  onAcknowledge(a.handoffId);
                  navigate(a.href);
                }}
                data-testid="checkout-arrival-open"
              >
                <DoorOpen className="h-3.5 w-3.5" aria-hidden /> Open
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 border-black bg-transparent text-black hover:bg-black/10"
                onClick={() => onAcknowledge(a.handoffId)}
                data-testid="checkout-arrival-ack"
              >
                <Check className="h-3.5 w-3.5" aria-hidden /> Acknowledge
              </Button>
            </div>
          </div>
        ))}
        {arrivals.length > 1 && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-black underline hover:bg-black/10"
              onClick={() => onAcknowledge()}
              data-testid="checkout-arrival-ack-all"
            >
              Acknowledge all {arrivals.length}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
