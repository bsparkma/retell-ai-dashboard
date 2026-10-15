/**
 * The checkout patient SIDEBAR (queue item 50).
 *
 * ONE component, opened from two places: a row on the Checkout page, and the
 * arrival toast (which navigates to the page with `?handoff=` and so opens
 * THIS same sheet). Nothing here reads Open Dental or the hygiene visit — it
 * renders the snapshot the hygiene module sent.
 *
 * The three outcome buttons are the front desk's answer:
 *   Scheduled       → the case lands in the Scheduled column (appointment note optional)
 *   Not scheduled   → the case waits on the patient
 *   Nothing needed  → the checkout closes, no case
 * The answer renders from the server's read-back, never from the click.
 */
import { useCallback, useEffect, useState } from "react";
import { ReferralsPanel } from "@/features/tc/referrals/ReferralsPanel";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarCheck,
  CalendarX,
  CheckCircle2,
  CircleSlash,
  Clock,
  FileText,
  Hand,
  Loader2,
  Send,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import { tcErrorMessage } from "@/features/tc/api";
import {
  claimCheckout,
  getCheckoutHandoff,
  recordCheckoutOutcome,
} from "@/features/tc/checkout/checkoutApi";
import {
  TC_CHECKOUT_PRIORITY_LABELS,
  TC_CHECKOUT_STATUS_LABELS,
  TC_CHECKOUT_WAITING,
  type TcCheckoutHandoff,
  type TcCheckoutOutcome,
  type TcCheckoutPriority,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

const PRIORITY_CLASS: Record<TcCheckoutPriority, string> = {
  urgent: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  preventative: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  cosmetic: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

/** "9:42 AM" in the office's own reading of the instant. */
export function checkoutClock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
}

export function PriorityChip({ priority }: { priority: TcCheckoutPriority | null }) {
  if (!priority) return <Badge variant="outline">Nothing staged</Badge>;
  return (
    <Badge variant="outline" className={`border-transparent ${PRIORITY_CLASS[priority]}`} data-testid="checkout-priority">
      {TC_CHECKOUT_PRIORITY_LABELS[priority]}
    </Badge>
  );
}

function teethText(teeth: number[] | "mouth"): string {
  if (teeth === "mouth") return "Whole mouth";
  return teeth.length ? `#${teeth.join(", #")}` : "—";
}

export interface CheckoutSidebarProps {
  office: OfficeId | null;
  handoffId: string | null;
  showOfficeBadge?: boolean;
  onClose: () => void;
  /** Called with the server's read-back after any change, so the page can update its row. */
  onChanged?: (handoff: TcCheckoutHandoff) => void;
}

export function CheckoutSidebar({ office, handoffId, showOfficeBadge = false, onClose, onChanged }: CheckoutSidebarProps) {
  const open = office !== null && handoffId !== null;
  const [handoff, setHandoff] = useState<TcCheckoutHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<TcCheckoutOutcome | "claim" | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!office || !handoffId) return;
    setError(null);
    try {
      setHandoff(await getCheckoutHandoff(office, handoffId));
    } catch (e) {
      setError(tcErrorMessage(e));
    }
  }, [office, handoffId]);

  useEffect(() => {
    setHandoff(null);
    setNote("");
    if (open) void load();
  }, [open, load]);

  const adopt = (next: TcCheckoutHandoff) => {
    setHandoff(next);
    onChanged?.(next);
  };

  const claim = async () => {
    if (!office || !handoff) return;
    setBusy("claim");
    try {
      adopt(await claimCheckout(office, handoff.handoffId));
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const answer = async (outcome: TcCheckoutOutcome) => {
    if (!office || !handoff) return;
    setBusy(outcome);
    try {
      const res = await recordCheckoutOutcome(office, handoff.handoffId, outcome, outcome === "scheduled" ? note : "");
      adopt(res.handoff);
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
      await load();
    } finally {
      setBusy(null);
    }
  };

  const waiting = handoff ? TC_CHECKOUT_WAITING.includes(handoff.status) : false;
  const snap = handoff?.snapshot;

  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" data-testid="checkout-sidebar">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {handoff ? handoff.patientName : "Checkout"}
            {handoff && showOfficeBadge && <OfficeBadge officeId={handoff.officeId} />}
          </SheetTitle>
          <SheetDescription>
            {handoff
              ? `Sent by hygiene at ${checkoutClock(handoff.createdAt)}${handoff.providerSeen ? ` · seen by ${handoff.providerSeen}` : ""}${handoff.provider ? ` · ${handoff.provider}` : ""}${handoff.operatory ? ` · ${handoff.operatory}` : ""}`
              : "Loading the checkout…"}
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-5">
          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}
          {!handoff && !error && (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}

          {handoff && snap && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <PriorityChip priority={snap.priority} />
                {snap.notesPending ? (
                  <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 gap-1" data-testid="checkout-notes-pending">
                    <Clock className="w-3 h-3" /> Hygiene notes still being finished
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200 gap-1" data-testid="checkout-notes-final">
                    <FileText className="w-3 h-3" /> Final notes in
                  </Badge>
                )}
                <Badge variant="outline" data-testid="checkout-status">
                  {TC_CHECKOUT_STATUS_LABELS[handoff.status]}
                  {handoff.status === "claimed" && handoff.claimedBy ? ` · ${handoff.claimedBy}` : ""}
                </Badge>
              </div>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Treatment staged</h3>
                {snap.procedures.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing staged at the hygiene visit.</p>
                ) : (
                  <ul className="space-y-2" data-testid="checkout-procedures">
                    {snap.procedures.map((p, i) => (
                      <li key={i} className="rounded-lg border border-border p-2.5 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{teethText(p.teeth)} {p.code}</span>
                          {p.surfaces.length > 0 && <span className="text-muted-foreground">{p.surfaces.join("")}</span>}
                          <PriorityChip priority={p.priority} />
                          {p.scheduleNext && <Badge variant="outline">Schedule next visit</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{p.category} · {p.status}</p>
                        {p.note && <p className="text-xs mt-1">{p.note}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Next visit needs</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="checkout-next-visit">
                  <dt className="text-muted-foreground">Visit</dt>
                  <dd>{snap.nextVisit.type ?? "Not set"}</dd>
                  <dt className="text-muted-foreground">When</dt>
                  <dd>{snap.nextVisit.intervalMonths ? `${snap.nextVisit.intervalMonths} months` : "Not set"}</dd>
                  <dt className="text-muted-foreground">Length</dt>
                  <dd>{snap.nextVisit.lengthMin ? `${snap.nextVisit.lengthMin} min` : "Not set"}</dd>
                  <dt className="text-muted-foreground">Doctor</dt>
                  <dd>{snap.nextVisit.withDoctor ? "With the doctor" : "Hygiene only"}</dd>
                  {snap.nextVisit.rtc && (
                    <>
                      <dt className="text-muted-foreground">RTC</dt>
                      <dd>{snap.nextVisit.rtc}</dd>
                    </>
                  )}
                </dl>
              </section>

              {(snap.frontDeskNote || snap.financialNote) && (
                <section className="space-y-1 text-sm">
                  {snap.frontDeskNote && <p><span className="text-muted-foreground">Front desk: </span>{snap.frontDeskNote}</p>}
                  {snap.financialNote && <p><span className="text-muted-foreground">Financial: </span>{snap.financialNote}</p>}
                </section>
              )}

              {/* Item 53: the referral chip goes live (None / Staged / Pending
                  Dr. sign-off / Approved) with Start referral beside it. It
                  reads "None" exactly as before while referrals is off. */}
              <ReferralsPanel compact office={handoff.officeId} source={{ handoffId: handoff.handoffId }} />

              {waiting ? (
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
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
