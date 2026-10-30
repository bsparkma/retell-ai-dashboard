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
import { AlertTriangle, Clock, CreditCard, FileText, Loader2, Maximize2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import { tcErrorMessage } from "@/features/tc/api";
import { getCheckoutHandoff } from "@/features/tc/checkout/checkoutApi";
import { CheckoutOutcome, checkoutClock } from "@/features/tc/checkout/CheckoutOutcome";
import { ReopenedNotice } from "@/features/tc/checkout/ReopenedNotice";
import {
  TC_CHECKOUT_PRIORITY_LABELS,
  TC_CHECKOUT_RECORD_STATUS_LABELS,
  TC_CHECKOUT_STATUS_LABELS,
  checkoutHasHygieneData,
  type TcCheckoutHandoff,
  type TcCheckoutPriority,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";
import { teethText } from "@shared/hyg/teeth";
import { ExistingTreatmentFromHygiene } from "@/features/tc/checkout/HygieneTreatmentPanel";

export { checkoutClock };

export const PRIORITY_CLASS: Record<TcCheckoutPriority, string> = {
  urgent: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  preventative: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  cosmetic: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

/** The workup view's address for one checkout (CO-1): linkable, office in the query. */
export function checkoutWorkupHref(office: OfficeId, handoffId: string): string {
  return `/tc/checkout/${handoffId}?office=${office}`;
}

export function PriorityChip({ priority, prefix = "" }: { priority: TcCheckoutPriority | null; prefix?: string }) {
  if (!priority) return <Badge variant="outline">Nothing staged</Badge>;
  return (
    <Badge variant="outline" className={`border-transparent ${PRIORITY_CLASS[priority]}`} data-testid="checkout-priority">
      {prefix}
      {TC_CHECKOUT_PRIORITY_LABELS[priority]}
    </Badge>
  );
}

/**
 * One staged procedure's PRIORITY and CATEGORY, drawn as two different kinds
 * of thing (checkout v2). They used to be a coloured chip beside the code and a
 * grey "Restorative · proposed" line under it, which read as though
 * "Preventative" were the category. Now the priority is a filled, coloured pill
 * that SAYS "priority", and the category is a plain outlined tag.
 */
export function ProcedureTags({ priority, category }: { priority: TcCheckoutPriority; category: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${PRIORITY_CLASS[priority]}`}
        data-testid="checkout-proc-priority"
        aria-label={`Priority: ${TC_CHECKOUT_PRIORITY_LABELS[priority]}`}
      >
        <span className="mr-1 font-normal opacity-75">Priority</span>
        {TC_CHECKOUT_PRIORITY_LABELS[priority]}
      </span>
      <span
        className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
        data-testid="checkout-proc-category"
        aria-label={`Category: ${category}`}
      >
        {category}
      </span>
    </span>
  );
}

export function teethLine(teeth: number[] | "mouth"): string {
  if (teeth === "mouth") return "Whole mouth";
  return teeth.length ? teethText(teeth) : "—";
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
    if (open) void load();
  }, [open, load]);

  const adopt = (next: TcCheckoutHandoff) => {
    setHandoff(next);
    onChanged?.(next);
  };

  const snap = handoff?.snapshot;
  // CO-5a: a card added by hand with no hygiene visit behind it says so, rather
  // than showing "nothing staged" and a blank next visit as if hygiene had.
  const hygieneData = handoff ? checkoutHasHygieneData(handoff) : true;

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
              ? `${handoff.source === "manual" ? `Added by hand at ${checkoutClock(handoff.createdAt)} by ${handoff.submittedBy}` : `Sent by hygiene at ${checkoutClock(handoff.createdAt)}`}${handoff.providerSeen ? ` · seen by ${handoff.providerSeen}` : ""}${handoff.provider ? ` · ${handoff.provider}` : ""}${handoff.operatory ? ` · ${handoff.operatory}` : ""}`
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
                {hygieneData && <PriorityChip priority={snap.priority} prefix="Priority: " />}
                {handoff.source === "manual" && (
                  <Badge variant="outline" data-testid="checkout-manual">Added by hand</Badge>
                )}
                {!hygieneData ? null : snap.notesPending ? (
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
                {/* CO-1: the sheet is the quick glance; the workup view is where the desk works. */}
                <Link
                  href={checkoutWorkupHref(handoff.officeId, handoff.handoffId)}
                  className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-2 hover:underline"
                  data-testid="checkout-open-workup"
                >
                  <Maximize2 className="w-3.5 h-3.5" /> Open full workup
                </Link>
              </div>

              {handoff.reopenedFrom && <ReopenedNotice reopened={handoff.reopenedFrom} />}

              {/* CHECKOUT V2: WHAT TO TAKE PAYMENT FOR, FIRST. The reason this
                  patient must stop at the desk at all, so it leads the sheet. */}
              {snap.collectAtCheckout && snap.collectAtCheckout.length > 0 ? (
                <section
                  className="rounded-lg border-2 border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/40 p-3"
                  data-testid="checkout-collect"
                >
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                    <CreditCard className="w-4 h-4" /> Collect payment
                  </h3>
                  <ul className="mt-1.5 space-y-0.5 text-sm font-medium text-foreground" data-testid="checkout-collect-items">
                    {snap.collectAtCheckout.map((label, i) => (
                      <li key={i}>{label}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* The hygienist's two notes from the slip, as their own section
                  rather than a footnote under everything else. */}
              {(snap.frontDeskNote || snap.financialNote) && (
                <section className="space-y-1.5 text-sm" data-testid="checkout-hygiene-notes">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">From the hygienist</h3>
                  {snap.frontDeskNote && (
                    <p data-testid="checkout-front-desk-note"><span className="text-muted-foreground">Front desk: </span>{snap.frontDeskNote}</p>
                  )}
                  {snap.financialNote && (
                    <p data-testid="checkout-financial-note"><span className="text-muted-foreground">Financial: </span>{snap.financialNote}</p>
                  )}
                </section>
              )}

              {!hygieneData && (
                <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="checkout-no-hygiene-data">
                  No hygiene visit data: this patient was added at the desk, and no hygiene visit has sent anything for
                  them today.
                </p>
              )}

              {hygieneData && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Treatment staged</h3>
                  {snap.procedures.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing staged at the hygiene visit.</p>
                  ) : (
                    <ul className="space-y-2" data-testid="checkout-procedures">
                      {snap.procedures.map((p, i) => (
                        <li key={i} className="rounded-lg border border-border p-2.5 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">{teethLine(p.teeth)} {p.code}</span>
                            {p.surfaces.length > 0 && <span className="text-muted-foreground">{p.surfaces.join("")}</span>}
                            {p.scheduleNext && <Badge variant="outline">Schedule next visit</Badge>}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <ProcedureTags priority={p.priority} category={p.category} />
                            <span className="text-xs text-muted-foreground">{p.status}</span>
                          </div>
                          {p.note && <p className="text-xs mt-1">{p.note}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {/* CHECKOUT V2: the records the staged treatment needs, with where
                  each stands, so a case does not stall on a missing PA later. */}
              {snap.records && snap.records.length > 0 ? (
                <section data-testid="checkout-records">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Records for the planned treatment</h3>
                  <ul className="space-y-1 text-sm">
                    {snap.records.map((r) => (
                      <li key={r.record} className="flex items-center justify-between gap-2" data-testid="checkout-record">
                        <span>{r.record}</span>
                        <Badge
                          variant="outline"
                          className={
                            r.status === "needed"
                              ? "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                              : "border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                          }
                        >
                          {r.status === "needed" ? "Still needed" : TC_CHECKOUT_RECORD_STATUS_LABELS[r.status]}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {hygieneData && (
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
              )}

              {/* Slice 2b: what was said at the visit about the treatment ALREADY
                  planned in Open Dental — every item the hygiene module carried,
                  "Not discussed" included, grouped in the ratified order. This
                  sheet IS the front desk's checkout panel; 2b drew the block only
                  on the case view's HygieneTreatmentPanel, so a checkout carried
                  the answers and nobody at the desk could see them. */}
              {snap.existingTx && snap.existingTx.length > 0 ? (
                <section data-testid="checkout-existing-tx">
                  <ExistingTreatmentFromHygiene items={snap.existingTx} />
                </section>
              ) : null}

              {/* Item 53: the referral chip goes live (None / Staged / Pending
                  Dr. sign-off / Approved) with Start referral beside it. It
                  reads "None" exactly as before while referrals is off. */}
              <ReferralsPanel compact office={handoff.officeId} source={{ handoffId: handoff.handoffId }} />

              {office && (
                <CheckoutOutcome key={handoff.handoffId} office={office} handoff={handoff} onAdopt={adopt} onReload={load} />
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
