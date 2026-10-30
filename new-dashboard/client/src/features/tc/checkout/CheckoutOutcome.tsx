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
 *
 * CO-4a: Scheduled first asks WHICH Open Dental appointment was booked (the
 * AppointmentPicker), and the pick and the answer are one request. Once
 * Scheduled, the card shows the anchored appointment, or "No appointment
 * linked" with "Link appointment".
 */
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CalendarCheck, CalendarX, CheckCircle2, CircleSlash, Hand, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TcApiError, tcErrorMessage } from "@/features/tc/api";
import { claimCheckout, recordCheckoutOutcome } from "@/features/tc/checkout/checkoutApi";
import { AppointmentAnchorLine, AppointmentPicker } from "@/features/tc/checkout/AppointmentPicker";
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
  const [picking, setPicking] = useState(false);
  const [pickerReload, setPickerReload] = useState(0);

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

  const answer = async (outcome: TcCheckoutOutcome, aptNum: number | null = null) => {
    setBusy(outcome);
    try {
      const res = await recordCheckoutOutcome(office, handoff.handoffId, outcome, outcome === "scheduled" ? note : "", aptNum);
      setPicking(false);
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
      // CO-4a: the picked appointment is no longer upcoming in Open Dental —
      // keep the picker open on a fresh list rather than a stale one.
      if (e instanceof TcApiError && e.code === "APPOINTMENT_NOT_UPCOMING") setPickerReload((n) => n + 1);
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
        <Button className="gap-1.5 min-h-11" disabled={busy !== null} onClick={() => setPicking(true)} data-testid="checkout-outcome-scheduled">
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
      <AppointmentPicker
        open={picking}
        office={office}
        handoffId={handoff.handoffId}
        mode="outcome"
        busy={busy === "scheduled"}
        reloadToken={pickerReload}
        onClose={() => setPicking(false)}
        onPick={(aptNum) => void answer("scheduled", aptNum)}
      />
    </section>
  ) : (
    <section className="border-t border-border pt-4 text-sm space-y-1" data-testid="checkout-answered">
      <p className="flex items-center gap-2 font-medium">
        {handoff.status === "expired" ? <Send className="w-4 h-4 text-muted-foreground" /> : <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
        {TC_CHECKOUT_STATUS_LABELS[handoff.status]}
        {handoff.outcomeAt && <span className="font-normal text-muted-foreground">at {checkoutClock(handoff.outcomeAt)} by {handoff.outcomeBy}</span>}
      </p>
      <AppointmentAnchorLine office={office} handoff={handoff} canLink={handoff.caseId !== null} onLinked={onAdopt} />
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
