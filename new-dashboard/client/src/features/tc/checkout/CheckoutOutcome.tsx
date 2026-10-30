/**
 * The checkout's EXIT: "I've got this patient", the appointment note, and the
 * three outcomes — or, once answered, what was answered.
 *
 * Extracted UNCHANGED from CheckoutSidebar (CO-1) so the sidebar and the
 * full-screen workup view share one implementation rather than two copies of
 * the same three buttons:
 *   Scheduled       → the case lands in the Scheduled column (appointment note optional)
 *   Not scheduled   → the case waits on the patient
 *   Nothing needed  → the checkout closes, no case
 * The answer renders from the server's read-back, never from the click.
 */
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CalendarCheck, CalendarX, CheckCircle2, CircleSlash, Hand, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { claimCheckout, recordCheckoutOutcome } from "@/features/tc/checkout/checkoutApi";
import {
  TC_CHECKOUT_STATUS_LABELS,
  TC_CHECKOUT_WAITING,
  type TcCheckoutHandoff,
  type TcCheckoutOutcome,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

/** "9:42 AM" in the office's own reading of the instant. */
export function checkoutClock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
}

export interface CheckoutOutcomeProps {
  office: OfficeId;
  handoff: TcCheckoutHandoff;
  /** The server's read-back after a claim or an answer. */
  onAdopt: (next: TcCheckoutHandoff) => void;
  /** Re-read after a refusal, so the screen shows where it stands now. */
  onReload: () => Promise<void>;
}

export function CheckoutOutcome({ office, handoff, onAdopt, onReload }: CheckoutOutcomeProps) {
  const [busy, setBusy] = useState<TcCheckoutOutcome | "claim" | null>(null);
  const [note, setNote] = useState("");

  const claim = async () => {
    setBusy("claim");
    try {
      onAdopt(await claimCheckout(office, handoff.handoffId));
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await onReload();
    } finally {
      setBusy(null);
    }
  };

  const answer = async (outcome: TcCheckoutOutcome) => {
    setBusy(outcome);
    try {
      const res = await recordCheckoutOutcome(office, handoff.handoffId, outcome, outcome === "scheduled" ? note : "");
      onAdopt(res.handoff);
      const url = res.url;
      toast.success(
        outcome === "nothing_needed"
          ? "Checkout closed — nothing to schedule"
          : res.attached
            ? "Added to the patient's open case"
            : "Case created",
        url ? { action: { label: "Open case", onClick: () => window.location.assign(url) } } : undefined,
      );
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await onReload();
    } finally {
      setBusy(null);
    }
  };

  const waiting = TC_CHECKOUT_WAITING.includes(handoff.status);

  return waiting ? (
    <section className="space-y-3 border-t border-border pt-4">
      {handoff.status === "open" && (
        <Button variant="outline" size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void claim()} data-testid="checkout-claim">
          {busy === "claim" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hand className="w-3.5 h-3.5" />}
          I&apos;ve got this patient
        </Button>
      )}
      <div>
        <label htmlFor="checkout-appointment-note" className="text-xs font-medium text-muted-foreground">
          Appointment note (for Scheduled)
        </label>
        <Textarea
          id="checkout-appointment-note"
          value={note}
          maxLength={500}
          rows={2}
          placeholder="e.g. Tue 10/21 9:00, Dr. chair"
          onChange={(e) => setNote(e.target.value)}
          data-testid="checkout-appointment-note"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Button className="gap-1.5 min-h-11" disabled={busy !== null} onClick={() => void answer("scheduled")} data-testid="checkout-outcome-scheduled">
          {busy === "scheduled" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarCheck className="w-4 h-4" />}
          Scheduled
        </Button>
        <Button variant="outline" className="gap-1.5 min-h-11" disabled={busy !== null} onClick={() => void answer("not_scheduled")} data-testid="checkout-outcome-not_scheduled">
          {busy === "not_scheduled" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarX className="w-4 h-4" />}
          Not scheduled
        </Button>
        <Button variant="outline" className="gap-1.5 min-h-11" disabled={busy !== null} onClick={() => void answer("nothing_needed")} data-testid="checkout-outcome-nothing_needed">
          {busy === "nothing_needed" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CircleSlash className="w-4 h-4" />}
          Nothing needed
        </Button>
      </div>
    </section>
  ) : (
    <section className="border-t border-border pt-4 text-sm space-y-1" data-testid="checkout-answered">
      <p className="flex items-center gap-2 font-medium">
        {handoff.status === "expired" ? <Send className="w-4 h-4 text-muted-foreground" /> : <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
        {TC_CHECKOUT_STATUS_LABELS[handoff.status]}
        {handoff.outcomeAt && <span className="font-normal text-muted-foreground">at {checkoutClock(handoff.outcomeAt)} by {handoff.outcomeBy}</span>}
      </p>
      {handoff.appointmentNote && <p className="text-muted-foreground">{handoff.appointmentNote}</p>}
      {handoff.dismissedReason && <p className="text-muted-foreground">Dismissed: {handoff.dismissedReason}</p>}
      {handoff.caseId && (
        <Link href={`/tc/cases/${handoff.caseId}`} className="underline text-primary">
          Open the case
        </Link>
      )}
    </section>
  );
}
