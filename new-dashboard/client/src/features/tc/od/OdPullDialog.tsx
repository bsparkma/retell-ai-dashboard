/**
 * "Pull from Open Dental" — import a treatment plan onto a case.
 *
 * NO SILENT IMPORT. The flow is deliberately three steps:
 *
 *   1. link a patient (skipped when the case already carries a PatNum)
 *   2. fetch the plan and REVIEW it — every row is editable and de-selectable,
 *      the running total updates live, and anything Open Dental could not give
 *      us is stated above the table
 *   3. replace the case's phases, only on an explicit confirm
 *
 * Step 2 is the point of the dialog. A pulled plan becomes what the patient is
 * shown and what the practice quotes, so a coordinator must see the numbers and
 * agree to them before they land. Importing straight from the fetch would make
 * an OD data problem (a truncated plan, an unreadable procedure, a stale fee)
 * into a quote the patient was given.
 *
 * The import REPLACES the case's phases, matching the legacy behavior; the
 * confirm step says so when the case already has a plan.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, DownloadCloud, Loader2 } from "lucide-react";
import {
  isOdNotConnected,
  odTreatmentPlan,
  replacePhases,
  tcErrorMessage,
  type OdPatient,
  type OdTreatmentPlan,
} from "../api";
import { centsToDollarsInput, dollarsInputToCents, formatCents } from "../money";
import { UrgencyBadge } from "../components/TcShell";
import { groupItemsIntoPhases, itemsFromOdProcedures, stripReviewFields, type OdImportItem } from "./odPlan";
import { OdError, OdNotConnected, OdPatientSearch } from "./OdShell";

type Stage = "link" | "loading" | "review" | "error";

/** A review row: the imported item plus its editable, still-a-string money. */
interface ReviewRow {
  key: string;
  include: boolean;
  item: OdImportItem;
  fee: string;
  insuranceEst: string;
}

function rowsFrom(items: OdImportItem[]): ReviewRow[] {
  return items.map((item, i) => ({
    key: `od-${item.odProcNum ?? "x"}-${i}`,
    include: true,
    item,
    fee: centsToDollarsInput(item.feeCents),
    insuranceEst: centsToDollarsInput(item.insuranceEstCents),
  }));
}

export interface OdPullDialogProps {
  office: OfficeId;
  tcCase: TcCase;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (updated: TcCase) => void;
}

export function OdPullDialog({ office, tcCase, open, onOpenChange, onImported }: OdPullDialogProps) {
  const [patNum, setPatNum] = useState<number | null>(tcCase.odPatientId);
  const [linked, setLinked] = useState<OdPatient | null>(null);
  const [stage, setStage] = useState<Stage>(tcCase.odPatientId ? "loading" : "link");
  const [plan, setPlan] = useState<OdTreatmentPlan | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchPlan = useCallback(
    (target: number) => {
      setStage("loading");
      setError(null);
      odTreatmentPlan(office, target)
        .then((p) => {
          setPlan(p);
          setRows(rowsFrom(itemsFromOdProcedures(p.procedures)));
          setStage("review");
        })
        .catch((e: unknown) => {
          if (isOdNotConnected(e)) {
            setNotConnected(true);
            setStage("error");
            return;
          }
          setError(tcErrorMessage(e));
          setStage("error");
        });
    },
    [office],
  );

  // Reset to a clean state every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setNotConnected(false);
    setError(null);
    setPlan(null);
    setRows([]);
    setSaving(false);
    setLinked(null);
    setPatNum(tcCase.odPatientId);
    if (tcCase.odPatientId) fetchPlan(tcCase.odPatientId);
    else setStage("link");
  }, [open, tcCase.odPatientId, fetchPlan]);

  const included = useMemo(() => rows.filter((r) => r.include), [rows]);

  const totals = useMemo(() => {
    let feeCents = 0;
    let insCents = 0;
    let invalid = false;
    for (const r of included) {
      const f = dollarsInputToCents(r.fee);
      const i = dollarsInputToCents(r.insuranceEst);
      if (f === null || i === null) {
        invalid = true;
        continue;
      }
      feeCents += f;
      insCents += i;
    }
    return { feeCents, insCents, patientCents: Math.max(0, feeCents - insCents), invalid };
  }, [included]);

  const patch = (key: string, next: Partial<ReviewRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...next } : r)));

  async function confirmImport() {
    if (included.length === 0 || totals.invalid) return;
    setSaving(true);
    try {
      const items = included.map((r) => {
        const feeCents = dollarsInputToCents(r.fee) ?? 0;
        const insuranceEstCents = Math.min(dollarsInputToCents(r.insuranceEst) ?? 0, feeCents);
        return {
          ...r.item,
          feeCents,
          insuranceEstCents,
          patientPortionCents: Math.max(0, feeCents - insuranceEstCents),
        };
      });
      const phases = groupItemsIntoPhases(stripReviewFields(items));
      const updated = await replacePhases(office, tcCase.caseId, phases);
      // Confirmed-save rule: toast only after the server has persisted.
      toast.success(`Imported ${items.length} procedure${items.length === 1 ? "" : "s"} from Open Dental`);
      onImported(updated);
      onOpenChange(false);
    } catch (e: unknown) {
      setError(tcErrorMessage(e));
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Pull treatment plan from Open Dental</DialogTitle>
          <DialogDescription>
            {stage === "link"
              ? "Find this patient in Open Dental first. Nothing is imported until you review it."
              : "Review what Open Dental sent. Nothing lands on the case until you confirm."}
          </DialogDescription>
        </DialogHeader>

        {notConnected && <OdNotConnected />}

        {!notConnected && stage === "link" && (
          <OdPatientSearch
            office={office}
            autoFocus
            selected={linked}
            onClear={() => {
              setLinked(null);
              setPatNum(null);
            }}
            onSelect={(p) => {
              setLinked(p);
              setPatNum(p.patNum);
              fetchPlan(p.patNum);
            }}
          />
        )}

        {!notConnected && stage === "loading" && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Reading the treatment plan from Open Dental…
          </div>
        )}

        {!notConnected && stage === "error" && error && (
          <OdError message={error} onRetry={patNum ? () => fetchPlan(patNum) : undefined} />
        )}

        {!notConnected && stage === "review" && plan && (
          <div className="space-y-3">
            {/* What OD gave us, and what it could not. */}
            <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-xs">
              <p className="text-muted-foreground">
                {plan.source
                  ? `From the ${plan.source.status} plan${plan.source.heading ? ` “${plan.source.heading}”` : ""} (TreatPlanNum ${plan.source.treatPlanNum}).`
                  : "No plan procedures came back."}
              </p>
              {plan.notes.map((n) => (
                <p key={n} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                  {n}
                </p>
              ))}
              {plan.unreadable.length > 0 && (
                <p className="text-muted-foreground">
                  Not imported: {plan.unreadable.map((u) => `#${u.procNum}`).join(", ")}
                </p>
              )}
            </div>

            {rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Open Dental returned no billable procedures for this patient.
              </p>
            ) : (
              <>
                <div className="max-h-[45vh] overflow-y-auto rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <span className="sr-only">Include</span>
                        </TableHead>
                        <TableHead>Tooth</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead>Procedure</TableHead>
                        <TableHead className="w-28 text-right">Fee</TableHead>
                        <TableHead className="w-28 text-right">Ins. est.</TableHead>
                        <TableHead>Urgency</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => {
                        const feeBad = dollarsInputToCents(r.fee) === null;
                        const insBad = dollarsInputToCents(r.insuranceEst) === null;
                        return (
                          <TableRow key={r.key} className={r.include ? undefined : "opacity-50"}>
                            <TableCell>
                              <Checkbox
                                checked={r.include}
                                onCheckedChange={(v) => patch(r.key, { include: v === true })}
                                aria-label={`Include ${r.item.procedureName}`}
                              />
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {r.item.odToothNum === "N/A" ? "—" : r.item.odToothNum}
                            </TableCell>
                            <TableCell className="whitespace-nowrap font-mono text-xs">
                              {r.item.odProcCode || "—"}
                            </TableCell>
                            <TableCell className="font-medium">{r.item.procedureName}</TableCell>
                            <TableCell>
                              <Input
                                value={r.fee}
                                onChange={(e) => patch(r.key, { fee: e.target.value })}
                                className={feeBad ? "border-destructive text-right" : "text-right"}
                                aria-label={`Fee for ${r.item.procedureName}`}
                                aria-invalid={feeBad}
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                value={r.insuranceEst}
                                onChange={(e) => patch(r.key, { insuranceEst: e.target.value })}
                                className={insBad ? "border-destructive text-right" : "text-right"}
                                aria-label={`Insurance estimate for ${r.item.procedureName}`}
                                aria-invalid={insBad}
                              />
                            </TableCell>
                            <TableCell>
                              <UrgencyBadge urgency={r.item.urgency} />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {included.length} of {rows.length} selected
                  </span>
                  {totals.invalid ? (
                    <span className="text-destructive">
                      Fix the highlighted amounts before importing.
                    </span>
                  ) : (
                    <span className="font-medium text-foreground">
                      {formatCents(totals.feeCents)} · insurance est. {formatCents(totals.insCents)} ·
                      patient portion {formatCents(totals.patientCents)}
                    </span>
                  )}
                </div>

                {tcCase.phases.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    This case already has a treatment plan. Importing replaces every existing phase.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={confirmImport}
            disabled={stage !== "review" || saving || included.length === 0 || totals.invalid}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
            Import {included.length > 0 ? `${included.length} ` : ""}
            {included.length === 1 ? "procedure" : "procedures"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
