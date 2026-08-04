/**
 * Treatment tab — phases → items table with integer-cents totals, plus the
 * "Edit treatment plan" dialog that rebuilds the full phase list and saves it
 * atomically via replacePhases. All money renders through formatCents; user
 * dollar input parses through dollarsInputToCents (invalid input blocks save
 * with inline validation — never guessed).
 */
import { useMemo, useState } from "react";
import type { OfficeId, TcCase, TcCaseItem } from "@shared/tc/contract";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { replacePhases, tcErrorMessage } from "../api";
import type { TcPhaseCreate } from "../api";
import { cn } from "@/lib/utils";
import { centsToDollarsInput, dollarsInputToCents, formatCents } from "../money";
import { URGENCY_LABELS } from "../status";
import type { UrgencyId } from "../status";
import { UrgencyBadge } from "../components/TcShell";
import { ValueEngineeringPanel } from "./ValueEngineeringPanel";

const URGENCY_IDS = Object.keys(URGENCY_LABELS) as UrgencyId[];

// ── Read view ───────────────────────────────────────────────────────────────

interface PhaseTotals {
  feeCents: number;
  insuranceEstCents: number;
  patientPortionCents: number;
}

function totalsOf(items: readonly TcCaseItem[]): PhaseTotals {
  return items.reduce<PhaseTotals>(
    (acc, i) => ({
      feeCents: acc.feeCents + i.feeCents,
      insuranceEstCents: acc.insuranceEstCents + i.insuranceEstCents,
      patientPortionCents: acc.patientPortionCents + i.patientPortionCents,
    }),
    { feeCents: 0, insuranceEstCents: 0, patientPortionCents: 0 },
  );
}

export interface TreatmentTabProps {
  office: OfficeId;
  tcCase: TcCase;
  onCaseUpdate: (updated: TcCase) => void;
}

export function TreatmentTab({ office, tcCase, onCaseUpdate }: TreatmentTabProps) {
  const [editOpen, setEditOpen] = useState(false);
  const phases = useMemo(
    () => [...tcCase.phases].sort((a, b) => a.position - b.position),
    [tcCase.phases],
  );
  const caseTotals = totalsOf(phases.flatMap((p) => p.items));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {phases.length === 0
            ? "No treatment plan yet."
            : `Case total ${formatCents(caseTotals.feeCents)} · insurance est. ${formatCents(caseTotals.insuranceEstCents)} · patient portion ${formatCents(caseTotals.patientPortionCents)}`}
        </p>
        <Button variant="outline" onClick={() => setEditOpen(true)}>
          <Pencil size={14} />
          Edit treatment plan
        </Button>
      </div>

      {phases.map((phase) => {
        const totals = totalsOf(phase.items);
        const items = [...phase.items].sort((a, b) => a.position - b.position);
        return (
          <Card key={phase.phaseId}>
            <CardHeader className="pb-2">
              <div className="flex items-baseline justify-between gap-2">
                <CardTitle className="text-sm font-semibold">{phase.name}</CardTitle>
                <span className="text-sm font-semibold text-foreground">
                  {formatCents(totals.feeCents)}
                </span>
              </div>
              {phase.description && (
                <p className="text-xs text-muted-foreground">{phase.description}</p>
              )}
            </CardHeader>
            <CardContent>
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No items in this phase.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tooth</TableHead>
                      <TableHead>Procedure</TableHead>
                      <TableHead>For the patient</TableHead>
                      <TableHead className="text-right">Fee</TableHead>
                      <TableHead className="text-right">Ins. est.</TableHead>
                      <TableHead className="text-right">Patient portion</TableHead>
                      <TableHead>Urgency</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.itemId}>
                        <TableCell className="whitespace-nowrap">{item.tooth || "—"}</TableCell>
                        <TableCell className="font-medium">{item.procedureName}</TableCell>
                        <TableCell className="max-w-xs">
                          <span className="line-clamp-2 text-muted-foreground">
                            {item.patientDescription || "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {formatCents(item.feeCents)}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {formatCents(item.insuranceEstCents)}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap font-medium">
                          {formatCents(item.patientPortionCents)}
                        </TableCell>
                        <TableCell>
                          <UrgencyBadge urgency={item.urgency} />
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell colSpan={3} className="font-semibold">
                        Phase total
                      </TableCell>
                      <TableCell className="text-right font-semibold whitespace-nowrap">
                        {formatCents(totals.feeCents)}
                      </TableCell>
                      <TableCell className="text-right font-semibold whitespace-nowrap">
                        {formatCents(totals.insuranceEstCents)}
                      </TableCell>
                      <TableCell className="text-right font-semibold whitespace-nowrap">
                        {formatCents(totals.patientPortionCents)}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        );
      })}

      <ValueEngineeringPanel office={office} tcCase={tcCase} />

      <EditTreatmentDialog
        key={editOpen ? "open" : "closed"}
        office={office}
        tcCase={tcCase}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={onCaseUpdate}
      />
    </div>
  );
}

// ── Edit dialog ─────────────────────────────────────────────────────────────

/** Item fields the dialog doesn't surface — carried through the save untouched. */
type CarriedItemFields = Pick<
  TcCaseItem,
  "odProcNum" | "timeEstimate" | "benefits" | "risksOfDelay" | "expectedOutcome"
>;

interface DraftItem {
  key: string;
  tooth: string;
  procedureName: string;
  patientDescription: string;
  fee: string;
  insuranceEst: string;
  patientPortion: string;
  urgency: UrgencyId;
  carry: CarriedItemFields;
}

interface DraftPhase {
  key: string;
  name: string;
  description: string;
  items: DraftItem[];
}

let draftSeq = 0;
const nextKey = () => `draft-${++draftSeq}`;

const EMPTY_CARRY: CarriedItemFields = {
  odProcNum: null,
  timeEstimate: "",
  benefits: [],
  risksOfDelay: [],
  expectedOutcome: "",
};

function draftFromCase(tcCase: TcCase): DraftPhase[] {
  return [...tcCase.phases]
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      key: nextKey(),
      name: p.name,
      description: p.description,
      items: [...p.items]
        .sort((a, b) => a.position - b.position)
        .map((i) => ({
          key: nextKey(),
          tooth: i.tooth,
          procedureName: i.procedureName,
          patientDescription: i.patientDescription,
          fee: centsToDollarsInput(i.feeCents),
          insuranceEst: centsToDollarsInput(i.insuranceEstCents),
          patientPortion: centsToDollarsInput(i.patientPortionCents),
          urgency: i.urgency,
          carry: {
            odProcNum: i.odProcNum,
            timeEstimate: i.timeEstimate,
            benefits: i.benefits,
            risksOfDelay: i.risksOfDelay,
            expectedOutcome: i.expectedOutcome,
          },
        })),
    }));
}

const moneyInvalid = (text: string) => dollarsInputToCents(text) === null;

function EditTreatmentDialog({
  office,
  tcCase,
  open,
  onOpenChange,
  onSaved,
}: {
  office: OfficeId;
  tcCase: TcCase;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: TcCase) => void;
}) {
  const [draft, setDraft] = useState<DraftPhase[]>(() => draftFromCase(tcCase));
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patchPhase = (key: string, patch: Partial<Omit<DraftPhase, "key" | "items">>) =>
    setDraft((d) => d.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const patchItem = (phaseKey: string, itemKey: string, patch: Partial<Omit<DraftItem, "key" | "carry">>) =>
    setDraft((d) =>
      d.map((p) =>
        p.key === phaseKey
          ? { ...p, items: p.items.map((i) => (i.key === itemKey ? { ...i, ...patch } : i)) }
          : p,
      ),
    );

  const addPhase = () =>
    setDraft((d) => [...d, { key: nextKey(), name: `Phase ${d.length + 1}`, description: "", items: [] }]);

  const removePhase = (key: string) => setDraft((d) => d.filter((p) => p.key !== key));

  const addItem = (phaseKey: string) =>
    setDraft((d) =>
      d.map((p) =>
        p.key === phaseKey
          ? {
              ...p,
              items: [
                ...p.items,
                {
                  key: nextKey(),
                  tooth: "",
                  procedureName: "",
                  patientDescription: "",
                  fee: "0",
                  insuranceEst: "0",
                  patientPortion: "0",
                  urgency: "medium" as UrgencyId,
                  carry: EMPTY_CARRY,
                },
              ],
            }
          : p,
      ),
    );

  const removeItem = (phaseKey: string, itemKey: string) =>
    setDraft((d) =>
      d.map((p) =>
        p.key === phaseKey ? { ...p, items: p.items.filter((i) => i.key !== itemKey) } : p,
      ),
    );

  const save = async () => {
    // Validate the whole draft before touching the API.
    for (let pi = 0; pi < draft.length; pi++) {
      const phase = draft[pi];
      if (!phase) continue;
      if (phase.name.trim() === "") {
        setInlineError(`Phase ${pi + 1} needs a name.`);
        return;
      }
      for (let ii = 0; ii < phase.items.length; ii++) {
        const item = phase.items[ii];
        if (!item) continue;
        if (item.procedureName.trim() === "") {
          setInlineError(`Phase ${pi + 1}, item ${ii + 1} needs a procedure name.`);
          return;
        }
        if (moneyInvalid(item.fee) || moneyInvalid(item.insuranceEst) || moneyInvalid(item.patientPortion)) {
          setInlineError(
            `Phase ${pi + 1}, item ${ii + 1} has an invalid dollar amount. Use numbers like 1250 or 1,250.50.`,
          );
          return;
        }
      }
    }
    setInlineError(null);

    const body: TcPhaseCreate[] = draft.map((phase, pi) => ({
      position: pi,
      name: phase.name.trim(),
      description: phase.description,
      items: phase.items.map((item, ii) => ({
        ...item.carry,
        position: ii,
        tooth: item.tooth,
        procedureName: item.procedureName.trim(),
        patientDescription: item.patientDescription,
        feeCents: dollarsInputToCents(item.fee) ?? 0,
        insuranceEstCents: dollarsInputToCents(item.insuranceEst) ?? 0,
        patientPortionCents: dollarsInputToCents(item.patientPortion) ?? 0,
        urgency: item.urgency,
      })),
    }));

    setSubmitting(true);
    try {
      const updated = await replacePhases(office, tcCase.caseId, body);
      toast.success("Treatment plan saved");
      onSaved(updated);
      onOpenChange(false);
    } catch (e) {
      toast.error(tcErrorMessage(e));
      setSubmitting(false);
    }
  };

  const moneyInput = (
    phaseKey: string,
    item: DraftItem,
    field: "fee" | "insuranceEst" | "patientPortion",
    label: string,
  ) => (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        value={item[field]}
        inputMode="decimal"
        aria-invalid={moneyInvalid(item[field])}
        className={cn("h-8", moneyInvalid(item[field]) && "border-red-500 dark:border-red-500")}
        onChange={(e) => {
          const v = e.target.value;
          patchItem(
            phaseKey,
            item.key,
            field === "fee"
              ? { fee: v }
              : field === "insuranceEst"
                ? { insuranceEst: v }
                : { patientPortion: v },
          );
        }}
      />
      {moneyInvalid(item[field]) && (
        <span className="text-[11px] text-red-600 dark:text-red-400">Enter a dollar amount</span>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit treatment plan</DialogTitle>
          <DialogDescription>
            Phases and items save together — the plan below replaces the current one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {draft.map((phase, pi) => (
            <div key={phase.key} className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <span className="text-xs text-muted-foreground">Phase {pi + 1} name</span>
                  <Input
                    value={phase.name}
                    className="h-8"
                    onChange={(e) => patchPhase(phase.key, { name: e.target.value })}
                  />
                </div>
                <div className="flex-[2] space-y-1">
                  <span className="text-xs text-muted-foreground">Description</span>
                  <Input
                    value={phase.description}
                    className="h-8"
                    onChange={(e) => patchPhase(phase.key, { description: e.target.value })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove phase ${pi + 1}`}
                  onClick={() => removePhase(phase.key)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>

              {phase.items.map((item) => (
                <div key={item.key} className="rounded-md bg-muted/40 p-2 space-y-2">
                  <div className="flex items-end gap-2">
                    <div className="w-20 space-y-1">
                      <span className="text-xs text-muted-foreground">Tooth</span>
                      <Input
                        value={item.tooth}
                        className="h-8"
                        onChange={(e) => patchItem(phase.key, item.key, { tooth: e.target.value })}
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <span className="text-xs text-muted-foreground">Procedure</span>
                      <Input
                        value={item.procedureName}
                        className="h-8"
                        aria-invalid={item.procedureName.trim() === ""}
                        onChange={(e) =>
                          patchItem(phase.key, item.key, { procedureName: e.target.value })
                        }
                      />
                    </div>
                    <div className="w-32 space-y-1">
                      <span className="text-xs text-muted-foreground">Urgency</span>
                      <Select
                        value={item.urgency}
                        onValueChange={(v) =>
                          patchItem(phase.key, item.key, { urgency: v as UrgencyId })
                        }
                      >
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {URGENCY_IDS.map((u) => (
                            <SelectItem key={u} value={u}>
                              {URGENCY_LABELS[u]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove item"
                      onClick={() => removeItem(phase.key, item.key)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Patient description</span>
                    <Input
                      value={item.patientDescription}
                      className="h-8"
                      onChange={(e) =>
                        patchItem(phase.key, item.key, { patientDescription: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {moneyInput(phase.key, item, "fee", "Fee ($)")}
                    {moneyInput(phase.key, item, "insuranceEst", "Insurance est. ($)")}
                    {moneyInput(phase.key, item, "patientPortion", "Patient portion ($)")}
                  </div>
                </div>
              ))}

              <Button variant="outline" size="sm" onClick={() => addItem(phase.key)}>
                <Plus size={14} />
                Add item
              </Button>
            </div>
          ))}

          <Button variant="outline" onClick={addPhase}>
            <Plus size={14} />
            Add phase
          </Button>

          {inlineError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {inlineError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
