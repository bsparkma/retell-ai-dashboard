/**
 * "Treatment from hygiene" — the STAFF-ONLY record of what the hygienist
 * diagnosed at checkout (queue item 50b, PM revision).
 *
 * Beau's requirement: the treatment stays visible on the case until a HUMAN
 * confirms it was entered into Open Dental. The plan phase a checkout writes
 * can be priced, edited, or replaced by a pull from Open Dental; this panel
 * renders the checkout handoff's own stored snapshot instead, so it survives
 * all of that. It is mounted on the case detail only, never in the patient
 * presentation.
 *
 * "Entered in Open Dental" is a person's attestation, not a sync: nothing here
 * reads or writes Open Dental. A mark shows only once the server has stored it
 * and read it back; undoing one is admin-only (the server says whether this
 * user may, and enforces it).
 *
 * Renders nothing while checkout is switched off for the office, or for a
 * case no checkout landed on.
 */
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Loader2, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TcApiError, tcErrorMessage } from "@/features/tc/api";
import { UrgencyBadge } from "@/features/tc/components/TcShell";
import {
  TC_CHECKOUT_OUTCOME_LABELS,
  TC_CHECKOUT_PRIORITY_LABELS,
  type TcCheckoutCaseTreatment,
  type TcCheckoutHandoff,
  type TcCheckoutPanelItem,
  type TcCheckoutPriority,
  type TcCheckoutProcedure,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";
import { odToothText, teethText } from "@shared/hyg/teeth";
import {
  EXISTING_TX_CLINICAL_LABELS,
  EXISTING_TX_PATIENT_LABELS,
  EXISTING_TX_WAIT_LABELS,
  groupExistingTxForTc,
  type ExistingTxHandoffItem,
  type ExistingTxPatient,
} from "@shared/hyg/existingTx";

import { getCaseHygieneTreatment, markItemEntered, undoItemEntered } from "./checkoutApi";
import { AppointmentAnchorLine } from "./AppointmentPicker";

/** The card's "Tx not in OD" chip (pipeline board). */
export function TxNotInOdChip() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300 text-[10px]"
      data-testid="tc-tx-not-in-od-chip"
    >
      <ClipboardList className="w-3 h-3" aria-hidden />
      Tx not in OD
    </Badge>
  );
}

/** The same priority → urgency map the server uses for the plan item. */
const URGENCY_BY_PRIORITY: Record<TcCheckoutPriority, "high" | "medium" | "low"> = {
  urgent: "high",
  preventative: "medium",
  cosmetic: "low",
};

function teethLine(p: TcCheckoutProcedure): string {
  if (p.teeth === "mouth") return "Whole mouth";
  const teeth = p.teeth.length ? teethText(p.teeth) : "";
  return [teeth, p.surfaces.join("")].filter(Boolean).join(" ") || "—";
}

/**
 * "Existing treatment discussed" — the patient's EXISTING Open Dental plan and
 * what was said about it at the visit (hygiene Slice 2b).
 *
 * Grouped by the patient's answer, in the order a treatment coordinator works
 * them: Ready to schedule first, Not discussed last. "Getting worse → urgent"
 * is a red Urgent pill — a CareIN priority, not Open Dental's. Read straight off
 * the handoff's stored snapshot, like the table above it: nothing here reads
 * Open Dental or the hygiene visit again.
 *
 * `groupAction` (CO-1) puts something beside a group's heading — the workup
 * view's "Ready to present" box. Absent, the block renders exactly as before.
 *
 * `collapsedGroups` (CO-1 polish) starts the named groups folded to their
 * heading and count; a tap opens one. Only the workup view passes it (for "Not
 * discussed"). The open/closed state lives in this component and nowhere else,
 * so it lasts for the current view only. Absent, every group renders open.
 */
export function ExistingTreatmentFromHygiene({
  items,
  groupAction,
  collapsedGroups,
}: {
  items: readonly ExistingTxHandoffItem[];
  groupAction?: (group: ExistingTxPatient) => ReactNode;
  collapsedGroups?: readonly ExistingTxPatient[];
}) {
  const groups = groupExistingTxForTc(items);
  const [expanded, setExpanded] = useState<ReadonlySet<ExistingTxPatient>>(() => new Set());
  const toggle = (group: ExistingTxPatient) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  return (
    <div className="space-y-2" data-testid="tc-existing-tx">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Existing treatment discussed ({items.length})
      </p>
      {groups.map((g) => {
        const collapsible = collapsedGroups?.includes(g.patient) ?? false;
        const open = !collapsible || expanded.has(g.patient);
        const heading = `${EXISTING_TX_PATIENT_LABELS[g.patient]} (${g.items.length})`;
        return (
          <div key={g.patient} className="space-y-1" data-testid={`tc-existing-tx-group-${g.patient}`}>
            <p className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-foreground">
              {collapsible ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-expanded={open}
                  aria-controls={`tc-existing-tx-items-${g.patient}`}
                  onClick={() => toggle(g.patient)}
                  data-testid={`tc-existing-tx-toggle-${g.patient}`}
                >
                  {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  {heading}
                </button>
              ) : (
                <span>{heading}</span>
              )}
              {groupAction ? groupAction(g.patient) : null}
            </p>
            {open ? (
              <ul className="space-y-1" id={`tc-existing-tx-items-${g.patient}`}>
                {g.items.map((i) => {
                  const where = i.tooth ? `${odToothText(i.tooth)}${i.surface ? ` ${i.surface}` : ""}` : i.surface;
                  return (
                    <li
                      key={i.procNum}
                      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-border px-2 py-1 text-sm"
                      data-testid="tc-existing-tx-item"
                    >
                      <span className="font-medium text-foreground">
                        {[where, i.code].filter(Boolean).join(" ")}
                      </span>
                      {i.description ? <span className="text-muted-foreground">{i.description}</span> : null}
                      {i.clinical === "worse_urgent" ? (
                        <span
                          className="rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-red-500"
                          data-testid="tc-existing-tx-urgent"
                        >
                          Urgent
                        </span>
                      ) : null}
                      {i.clinical && i.clinical !== "worse_urgent" ? (
                        <span className="text-xs text-muted-foreground">{EXISTING_TX_CLINICAL_LABELS[i.clinical]}</span>
                      ) : null}
                      {i.patient === "wants_to_wait" && i.waitTimeframe ? (
                        <span className="text-xs text-muted-foreground">
                          Wait: {EXISTING_TX_WAIT_LABELS[i.waitTimeframe]}
                        </span>
                      ) : null}
                      {i.scheduled ? (
                        <Badge variant="outline" className="text-[10px]">
                          Already scheduled
                        </Badge>
                      ) : null}
                      {i.note ? <span className="basis-full text-xs text-muted-foreground">Note: {i.note}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

type Visit = TcCheckoutCaseTreatment["visits"][number];

export interface HygieneTreatmentPanelProps {
  office: OfficeId;
  caseId: string;
}

export function HygieneTreatmentPanel({ office, caseId }: HygieneTreatmentPanelProps) {
  const [data, setData] = useState<TcCheckoutCaseTreatment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getCaseHygieneTreatment(office, caseId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Checkout off for this office: the panel is dark, not an error.
        if (e instanceof TcApiError && e.code === "CHECKOUT_DISABLED") return;
        setError(tcErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [office, caseId]);

  function replaceItem(handoffId: string, item: TcCheckoutPanelItem) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            visits: prev.visits.map((v) =>
              v.handoff.handoffId === handoffId
                ? { ...v, items: v.items.map((i) => (i.index === item.index ? item : i)) }
                : v,
            ),
          }
        : prev,
    );
  }

  // CO-4a: the server's read-back after an appointment is linked from here.
  function replaceHandoff(next: TcCheckoutHandoff) {
    setData((prev) =>
      prev
        ? { ...prev, visits: prev.visits.map((v) => (v.handoff.handoffId === next.handoffId ? { ...v, handoff: next } : v)) }
        : prev,
    );
  }

  async function act(handoffId: string, index: number, undo: boolean) {
    const key = `${handoffId}:${index}`;
    setBusy(key);
    try {
      const res = undo
        ? await undoItemEntered(office, handoffId, index)
        : await markItemEntered(office, handoffId, index);
      replaceItem(handoffId, res.item);
      toast.success(undo ? "Mark removed" : "Marked as entered in Open Dental");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <Card data-testid="tc-hygiene-treatment-panel">
        <CardContent className="py-3 text-sm text-destructive">
          Treatment from hygiene could not be loaded: {error}
        </CardContent>
      </Card>
    );
  }
  if (!data || data.visits.length === 0) return null;

  const items = data.visits.flatMap((v) => v.items);
  const entered = items.filter((i) => i.enteredBy !== null).length;

  return (
    <Card data-testid="tc-hygiene-treatment-panel">
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold">Treatment from hygiene</CardTitle>
          <span
            className={
              entered === items.length
                ? "text-xs font-medium text-emerald-700 dark:text-emerald-400"
                : "text-xs font-medium text-amber-700 dark:text-amber-400"
            }
            data-testid="tc-hygiene-treatment-progress"
          >
            {items.length === 0
              ? "Nothing staged"
              : entered === items.length
                ? "All entered in Open Dental"
                : `${entered} of ${items.length} entered in Open Dental`}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Staff only: what the hygienist diagnosed, as sent at checkout. Never shown to the patient.
          Mark each item once you have entered it in Open Dental.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.visits.map((v) => (
          <VisitBlock
            key={v.handoff.handoffId}
            office={office}
            visit={v}
            canUnattest={data.canUnattest}
            busy={busy}
            onAct={act}
            onHandoff={replaceHandoff}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function VisitBlock({
  office,
  visit,
  canUnattest,
  busy,
  onAct,
  onHandoff,
}: {
  office: OfficeId;
  visit: Visit;
  onHandoff: (next: TcCheckoutHandoff) => void;
  canUnattest: boolean;
  busy: string | null;
  onAct: (handoffId: string, index: number, undo: boolean) => void;
}) {
  const h = visit.handoff;
  const next = h.snapshot.nextVisit;
  const outcome =
    h.status === "scheduled" || h.status === "not_scheduled" ? TC_CHECKOUT_OUTCOME_LABELS[h.status] : null;
  const nextBits = [
    next.type,
    next.intervalMonths ? `every ${next.intervalMonths} mo` : null,
    next.lengthMin ? `${next.lengthMin} min` : null,
    next.withDoctor ? "with doctor" : null,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="space-y-2" data-testid="tc-hygiene-visit">
      <div className="text-sm">
        <span className="font-medium text-foreground">Hygiene visit {h.visitDate}</span>
        <span className="text-muted-foreground">
          {h.provider ? ` · ${h.provider}` : ""}
          {outcome ? ` · ${outcome} at checkout` : ""}
        </span>
      </div>
      {/* CO-4a: the appointment this Scheduled checkout is anchored to, on the case. */}
      <AppointmentAnchorLine office={office} handoff={h} canLink={visit.canLinkAppointment} onLinked={onHandoff} />
      {(nextBits.length > 0 || next.rtc) && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Next visit:</span>{" "}
          {nextBits.join(" · ") || "—"}
          {next.rtc ? ` (${next.rtc})` : ""}
        </p>
      )}
      {h.snapshot.frontDeskNote && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Front desk note:</span> {h.snapshot.frontDeskNote}
        </p>
      )}
      {h.snapshot.existingTx && h.snapshot.existingTx.length > 0 ? (
        <ExistingTreatmentFromHygiene items={h.snapshot.existingTx} />
      ) : null}
      {visit.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing was staged at this visit.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tooth</TableHead>
              <TableHead>Procedure</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Urgency</TableHead>
              <TableHead>Hygienist note</TableHead>
              <TableHead>Open Dental</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visit.items.map((item) => {
              const p = item.procedure;
              const key = `${h.handoffId}:${item.index}`;
              return (
                <TableRow key={key} data-testid="tc-hygiene-item">
                  <TableCell className="whitespace-nowrap">{teethLine(p)}</TableCell>
                  <TableCell className="font-medium">
                    {p.code}
                    {p.scheduleNext && (
                      <span className="block text-[11px] font-normal text-muted-foreground">Schedule next visit</span>
                    )}
                  </TableCell>
                  <TableCell>{TC_CHECKOUT_PRIORITY_LABELS[p.priority]}</TableCell>
                  <TableCell>
                    <UrgencyBadge urgency={URGENCY_BY_PRIORITY[p.priority]} />
                  </TableCell>
                  <TableCell className="max-w-xs text-muted-foreground">{p.note || "—"}</TableCell>
                  <TableCell>
                    {item.enteredBy ? (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
                          Entered · {item.enteredBy} · {when(item.enteredAt)}
                        </span>
                        {canUnattest && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy === key}
                            onClick={() => onAct(h.handoffId, item.index, true)}
                            aria-label={`Undo entered for ${p.code}`}
                          >
                            <Undo2 className="w-3.5 h-3.5" />
                            Undo
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === key}
                          onClick={() => onAct(h.handoffId, item.index, false)}
                        >
                          {busy === key && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          Mark entered in OD
                        </Button>
                        {item.stale && (
                          <p className="text-[11px] text-amber-700 dark:text-amber-400">
                            Changed since it was marked. Check Open Dental again.
                          </p>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
