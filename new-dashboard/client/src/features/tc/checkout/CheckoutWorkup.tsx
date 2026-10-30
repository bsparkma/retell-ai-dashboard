/**
 * The checkout WORKUP view (CO-1) — the front desk's full-screen surface for
 * one patient, replacing the narrow sidebar as where the work is done (the
 * sidebar stays as the quick glance).
 *
 * Sections in DESK ORDER, every one drawn from the checkout snapshot TC already
 * holds — NO Open Dental read, NO fee:
 *   1  Work up in OD           today's diagnosed treatment, copy-friendly, a
 *                              "Worked up" box per row
 *   2  Existing treatment      the disposition groups in the ratified order, a
 *                              "Ready to present" box per group
 *   3  Collect payment         the collect list, one "Collected" box
 *   4  Referrals               the EXISTING referrals panel, embedded as-is
 *                              (same component, same routes as everywhere
 *                              else), plus a "Referrals handled" box
 *   then the exit              the same three outcome buttons as the sidebar
 *                              (one shared component, unchanged semantics)
 *
 * Every box renders the checklist the server READ BACK after storing the tick,
 * never the click; a box is disabled while its save is in flight. An answered
 * checkout's checklist is a record and renders read-only.
 */
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, CheckCircle2, ClipboardCopy, Clock, CreditCard, FileText, UserPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import { tcErrorMessage } from "@/features/tc/api";
import { ReferralsPanel } from "@/features/tc/referrals/ReferralsPanel";
import { setCheckoutWorkup } from "@/features/tc/checkout/checkoutApi";
import { CheckoutOutcome, checkoutClock } from "@/features/tc/checkout/CheckoutOutcome";
import { PriorityChip, ProcedureTags, teethLine } from "@/features/tc/checkout/CheckoutSidebar";
import { ExistingTreatmentFromHygiene } from "@/features/tc/checkout/HygieneTreatmentPanel";
import {
  TC_CHECKOUT_PRIORITY_LABELS,
  TC_CHECKOUT_RECORD_STATUS_LABELS,
  TC_CHECKOUT_STATUS_LABELS,
  TC_CHECKOUT_WAITING,
  TC_CHECKOUT_WORKUP_SECTION_LABELS,
  checkoutCollectKey,
  checkoutHasHygieneData,
  checkoutItemKey,
  checkoutPresentKey,
  checkoutWorkupProgress,
  checkoutWorkupProgressLabel,
  type TcCheckoutHandoff,
  type TcCheckoutProcedure,
  type TcCheckoutWorkupRequest,
  type TcCheckoutWorkupSection,
} from "@shared/tc/checkout";
import { DX_LABELS, type DxCode } from "@shared/hyg/contract";
import { EXISTING_TX_PATIENT_LABELS, type ExistingTxPatient } from "@shared/hyg/existingTx";
import type { OfficeId } from "@shared/tc/contract";

/**
 * Groups the workup folds to a heading and count (CO-1 polish ruling): "Not
 * discussed" is the longest and least actionable list, so it starts closed.
 * The hygiene visit page and the quick-look sidebar do not pass this.
 */
const WORKUP_COLLAPSED_GROUPS: readonly ExistingTxPatient[] = ["not_discussed"];

/** "D (Decay), RD (Recurrent decay)" — a code the label table lacks prints as itself. */
export function dxText(dx: readonly string[] | undefined): string {
  return (dx ?? [])
    .map((d) => {
      const label = (DX_LABELS as Record<string, string | undefined>)[d as DxCode];
      return label ? `${d} (${label})` : d;
    })
    .join(", ");
}

/** One row as a plain line, for the copy button: "#3 O · Crown · Urgent · Dx: D (Decay)". */
export function workupLine(p: TcCheckoutProcedure): string {
  const where = [teethLine(p.teeth), p.surfaces.join("")].filter(Boolean).join(" ");
  const dx = dxText(p.dx);
  return [where, p.code, TC_CHECKOUT_PRIORITY_LABELS[p.priority], dx ? `Dx: ${dx}` : "", p.dxNote ?? ""]
    .filter(Boolean)
    .join(" · ");
}

function SectionCard({
  n,
  section,
  done,
  applies,
  aside,
  children,
}: {
  n: number;
  section: TcCheckoutWorkupSection;
  done: boolean;
  applies: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-xl border border-border bg-card p-4 space-y-3"
      data-testid={`workup-section-${section}`}
      data-done={done ? "true" : "false"}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold ${
            done ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground"
          }`}
          aria-hidden
        >
          {done ? <Check className="size-3.5" /> : n}
        </span>
        <h2 className="text-base font-semibold text-foreground">{TC_CHECKOUT_WORKUP_SECTION_LABELS[section]}</h2>
        {done ? (
          <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            Done
          </Badge>
        ) : !applies ? (
          <Badge variant="outline" className="text-muted-foreground">
            Nothing to do
          </Badge>
        ) : null}
        {aside ? <div className="ml-auto">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

function Tick({
  id,
  label,
  hideLabel = false,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  /** The column header already says it; keep the name for screen readers only. */
  hideLabel?: boolean;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} data-testid={id} />
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </label>
  );
}

export interface CheckoutWorkupProps {
  office: OfficeId;
  handoff: TcCheckoutHandoff;
  showOfficeBadge?: boolean;
  /** The server's read-back after any change (tick, claim, outcome). */
  onChange: (next: TcCheckoutHandoff) => void;
  onReload: () => Promise<void>;
  /**
   * True while a tick is saving, false once it settles (CO-1 polish). The
   * patient rail holds a switch to another patient until this goes false.
   */
  onBusyChange?: (busy: boolean) => void;
}

export function CheckoutWorkup({ office, handoff, showOfficeBadge = false, onChange, onReload, onBusyChange }: CheckoutWorkupProps) {
  const [saving, setSaving] = useState<Set<string>>(() => new Set());
  const snap = handoff.snapshot;
  const editable = TC_CHECKOUT_WAITING.includes(handoff.status);
  const progress = checkoutWorkupProgress(handoff);
  const sectionState = (s: TcCheckoutWorkupSection): { applies: boolean; done: boolean } => {
    const found = progress.sections.find((x) => x.section === s);
    return { applies: found?.applies ?? false, done: found?.done ?? false };
  };

  // ONE save at a time (review rounds 1 and 2): every box waits while any tick
  // is in flight, so two answers can never land out of order and the older
  // read-back overwrite the newer one on screen. The ref is the real guard —
  // state only disables the boxes on the NEXT render, so two clicks inside one
  // render (a double-click) would otherwise both get through.
  const inFlight = useRef(false);
  const locked = !editable || saving.size > 0;

  const tick = async (key: string, body: TcCheckoutWorkupRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    onBusyChange?.(true);
    setSaving((prev) => new Set(prev).add(key));
    try {
      onChange(await setCheckoutWorkup(office, handoff.handoffId, body));
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await onReload();
    } finally {
      inFlight.current = false;
      onBusyChange?.(false);
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const copyAll = async () => {
    const text = snap.procedures.map(workupLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Treatment copied");
    } catch {
      toast.error("Could not copy. Select the rows and copy them instead.");
    }
  };

  const groups = Array.from(new Set((snap.existingTx ?? []).map((i) => i.patient)));
  const collect = snap.collectAtCheckout ?? [];
  // CO-5a: a card added by hand that no hygiene visit merged onto has no
  // staged treatment, existing treatment or collect list — not empty ones. It
  // says so once, and the hygiene sections are not drawn (nor counted).
  const hygieneData = checkoutHasHygieneData(handoff);

  return (
    <div className="space-y-4" data-testid="checkout-workup">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-foreground" data-testid="workup-patient">
          {handoff.patientName}
        </h1>
        {showOfficeBadge && <OfficeBadge officeId={handoff.officeId} />}
        <PriorityChip priority={snap.priority} prefix="Priority: " />
        {handoff.source === "manual" && (
          <Badge variant="outline" data-testid="workup-manual">
            <UserPlus className="w-3 h-3" /> Added by hand
          </Badge>
        )}
        {!hygieneData ? null : snap.notesPending ? (
          <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 gap-1">
            <Clock className="w-3 h-3" /> Hygiene notes still being finished
          </Badge>
        ) : (
          <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200 gap-1">
            <FileText className="w-3 h-3" /> Final notes in
          </Badge>
        )}
        <Badge variant="outline" data-testid="workup-status">
          {TC_CHECKOUT_STATUS_LABELS[handoff.status]}
          {handoff.status === "claimed" && handoff.claimedBy ? ` · ${handoff.claimedBy}` : ""}
        </Badge>
        <span className="ml-auto text-sm font-medium text-muted-foreground" data-testid="workup-progress">
          {checkoutWorkupProgressLabel(progress)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="workup-origin">
        {handoff.source === "manual"
          ? `Added by hand at ${checkoutClock(handoff.createdAt)} by ${handoff.submittedBy}`
          : `Sent by hygiene at ${checkoutClock(handoff.createdAt)}`}
        {handoff.source === "manual" && handoff.hygieneMergedAt
          ? ` · hygiene visit arrived at ${checkoutClock(handoff.hygieneMergedAt)}`
          : ""}
        {handoff.providerSeen ? ` · seen by ${handoff.providerSeen}` : ""}
        {handoff.provider ? ` · ${handoff.provider}` : ""}
        {handoff.operatory ? ` · ${handoff.operatory}` : ""}
        {!editable ? " · this checkout is answered, so its checklist is read-only" : ""}
      </p>

      {(snap.frontDeskNote || snap.financialNote) && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1" data-testid="workup-hygiene-notes">
          {snap.frontDeskNote && (
            <p><span className="text-muted-foreground">Front desk: </span>{snap.frontDeskNote}</p>
          )}
          {snap.financialNote && (
            <p><span className="text-muted-foreground">Financial: </span>{snap.financialNote}</p>
          )}
        </div>
      )}

      {!hygieneData && (
        <section className="rounded-xl border border-dashed border-border bg-muted/30 p-4 space-y-1" data-testid="workup-no-hygiene-data">
          <h2 className="text-base font-semibold text-foreground">No hygiene visit data</h2>
          <p className="text-sm text-muted-foreground">
            This patient was added at the desk, and no hygiene visit has sent anything for them today, so there is no
            staged treatment to work up, no existing treatment from hygiene, and no collect list. If a hygiene visit
            sends this patient later today, it lands on this card.
          </p>
        </section>
      )}

      {hygieneData && (
        <>
        {/* 1. WORK UP IN OD */}
        <SectionCard
          n={1}
          section="workup"
          {...sectionState("workup")}
          aside={
            snap.procedures.length > 0 ? (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void copyAll()} data-testid="workup-copy">
                <ClipboardCopy className="w-3.5 h-3.5" /> Copy list
              </Button>
            ) : undefined
          }
        >
          {snap.procedures.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="workup-empty-workup">
              Nothing was diagnosed at today&apos;s visit, so there is nothing to work up in Open Dental.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="workup-procedures">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-semibold">Worked up</th>
                    <th className="py-2 pr-3 font-semibold">Tooth</th>
                    <th className="py-2 pr-3 font-semibold">Surf</th>
                    <th className="py-2 pr-3 font-semibold">Code</th>
                    <th className="py-2 pr-3 font-semibold">Priority · category</th>
                    <th className="py-2 pr-3 font-semibold">Dx</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.procedures.map((p, i) => {
                    const mark = handoff.workup.workedUp[String(i)];
                    const current = Boolean(mark) && mark.key === checkoutItemKey(p);
                    const stale = Boolean(mark) && !current;
                    const key = `workup:${i}`;
                    return (
                      <tr key={i} className="border-b border-border/60 align-top" data-testid="workup-row">
                        <td className="py-2 pr-3">
                          <Tick
                            id={`workup-tick-${i}`}
                            label={`Worked up: ${workupLine(p)}`}
                            hideLabel
                            checked={current}
                            disabled={locked}
                            onChange={(done) => void tick(key, { section: "workup", index: i, done })}
                          />
                          {stale && (
                            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="workup-stale">
                              Changed since ticked
                            </p>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono font-semibold text-foreground select-all">{teethLine(p.teeth)}</td>
                        <td className="py-2 pr-3 font-mono select-all">{p.surfaces.join("") || "—"}</td>
                        <td className="py-2 pr-3 font-mono font-semibold text-foreground select-all">{p.code}</td>
                        <td className="py-2 pr-3">
                          <ProcedureTags priority={p.priority} category={p.category} />
                          {p.scheduleNext && <Badge variant="outline" className="ml-1.5">Schedule next visit</Badge>}
                        </td>
                        <td className="py-2 pr-3" data-testid="workup-dx">
                          {p.dx && p.dx.length > 0 ? <span>{dxText(p.dx)}</span> : <span className="text-muted-foreground">—</span>}
                          {p.dxNote ? <p className="text-xs text-muted-foreground">{p.dxNote}</p> : null}
                          {p.note ? <p className="text-xs">{p.note}</p> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {snap.records && snap.records.length > 0 ? (
            <div className="pt-1" data-testid="workup-records">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Records for the planned treatment</p>
              <ul className="flex flex-wrap gap-2 text-sm">
                {snap.records.map((r) => (
                  <li key={r.record} className="rounded-md border border-border px-2 py-0.5">
                    {r.record}:{" "}
                    <span className={r.status === "needed" ? "text-amber-700 dark:text-amber-300 font-medium" : "text-muted-foreground"}>
                      {r.status === "needed" ? "Still needed" : TC_CHECKOUT_RECORD_STATUS_LABELS[r.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SectionCard>

        {/* 2. EXISTING TREATMENT TO PRESENT */}
        <SectionCard n={2} section="present" {...sectionState("present")}>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="workup-empty-present">
              No existing treatment came with this visit.
            </p>
          ) : (
            <ExistingTreatmentFromHygiene
              items={snap.existingTx ?? []}
              collapsedGroups={WORKUP_COLLAPSED_GROUPS}
              groupAction={(group) => (
                <Tick
                  id={`workup-present-${group}`}
                  label={`Ready to present: ${EXISTING_TX_PATIENT_LABELS[group]}`}
                  checked={handoff.workup.present[group]?.key === checkoutPresentKey(snap.existingTx, group)}
                  disabled={locked}
                  onChange={(done) => void tick(`present:${group}`, { section: "present", group, done })}
                />
              )}
            />
          )}
        </SectionCard>

        {/* 3. COLLECT PAYMENT */}
        <SectionCard
          n={3}
          section="collect"
          {...sectionState("collect")}
          aside={
            collect.length > 0 ? (
              <Tick
                id="workup-collected"
                label="Collected"
                checked={handoff.workup.collected?.key === checkoutCollectKey(collect)}
                disabled={locked}
                onChange={(done) => void tick("collect", { section: "collect", done })}
              />
            ) : undefined
          }
        >
          {collect.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="workup-empty-collect">
              Nothing to collect at the desk for this visit.
            </p>
          ) : (
            <ul className="space-y-0.5 text-sm font-medium text-foreground" data-testid="workup-collect-items">
              {collect.map((label, i) => (
                <li key={i} className="flex items-center gap-2">
                  <CreditCard className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" /> {label}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        </>
      )}

      {/* 4. REFERRALS — the existing panel, embedded unchanged */}
      <SectionCard
        n={hygieneData ? 4 : 1}
        section="referrals"
        {...sectionState("referrals")}
        aside={
          <Tick
            id="workup-referrals"
            label="Referrals handled"
            checked={handoff.workup.referrals !== null}
            disabled={locked}
            onChange={(done) => void tick("referrals", { section: "referrals", done })}
          />
        }
      >
        <p className="text-xs text-muted-foreground">
          Start a referral here if today&apos;s visit needs one; tick &ldquo;Referrals handled&rdquo; when it is started, or when none is needed.
        </p>
        <ReferralsPanel office={handoff.officeId} source={{ handoffId: handoff.handoffId }} />
      </SectionCard>

      {/* THE EXIT — the same component the sidebar uses. */}
      <section className="rounded-xl border border-border bg-card p-4" data-testid="workup-exit">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <CheckCircle2 className="w-4 h-4 text-muted-foreground" /> Checkout outcome
        </h2>
        <CheckoutOutcome key={handoff.handoffId} office={office} handoff={handoff} onAdopt={onChange} onReload={onReload} />
      </section>

      {/* Kept for the desk's reference: what the next visit needs. */}
      {hygieneData && (
        <section className="rounded-xl border border-dashed border-border p-4 text-sm" data-testid="workup-next-visit">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Next visit needs</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
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
    </div>
  );
}
