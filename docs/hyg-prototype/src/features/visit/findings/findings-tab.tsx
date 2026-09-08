import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldLabel, FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ClipboardPlusIcon, ArrowUpRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useVisitStore } from "@/store/visit-store"
import { useStagedWritesStore } from "@/store/staged-writes-store"
import { deriveCategory, DX_LABELS, type Appointment, type Patient, type TreatmentItem } from "@/mock/types"
import { treatmentLabel } from "@/mock/treatment-options"

const RADIOGRAPH_OPTIONS = ["FMX", "PANO", "BW", "PA"]

const PRIORITY_LABEL: Record<TreatmentItem["priority"], string> = {
  1: "P1 · Urgent",
  2: "P2 · Soon",
  3: "P3 · Routine",
  4: "P4 · Watch",
}

const PRIORITY_CLASS: Record<TreatmentItem["priority"], string> = {
  1: "bg-destructive text-destructive-foreground",
  2: "bg-warning text-warning-foreground",
  3: "bg-secondary text-secondary-foreground",
  4: "bg-muted text-muted-foreground",
}

interface FindingsTabProps {
  appt: Appointment
  patient: Patient
  onEditOnRouter?: () => void
  onOpenOrtho?: () => void
}

function teethLabel(teeth: TreatmentItem["teeth"]) {
  if (teeth === "mouth") return "Whole mouth"
  if (teeth.length === 0) return "—"
  return `#${teeth.join(",")}`
}

function ItemRow({
  item,
  includeInHandoff,
  onToggleInclude,
  onOpenOrtho,
}: {
  item: TreatmentItem
  includeInHandoff?: boolean
  onToggleInclude?: (checked: boolean) => void
  onOpenOrtho?: () => void
}) {
  const isOrtho = item.category === "Ortho"
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-secondary/50 px-3 py-2 text-sm">
      {onToggleInclude && (
        <Checkbox
          checked={includeInHandoff}
          onCheckedChange={(v: boolean | "indeterminate") => onToggleInclude(v === true)}
          aria-label="Include in handoff"
        />
      )}
      <Badge variant="secondary" className="font-mono">
        {teethLabel(item.teeth)}
      </Badge>
      <span className="font-medium text-foreground">{treatmentLabel(item.code)}</span>
      <span className="text-muted-foreground">
        {item.dx.length ? item.dx.map((d) => DX_LABELS[d]).join(", ") : "no dx noted"}
      </span>
      {isOrtho && onOpenOrtho && (
        <Button type="button" variant="link" size="sm" className="h-auto gap-1 p-0" onClick={onOpenOrtho}>
          Open Ortho tab
          <ArrowUpRightIcon className="size-3" />
        </Button>
      )}
      <Badge className={cn("ml-auto", PRIORITY_CLASS[item.priority])}>{PRIORITY_LABEL[item.priority]}</Badge>
      <Badge variant={item.status === "confirmed" || item.status === "scheduled" ? "default" : "outline"}>
        {item.status === "proposed" ? "Doctor to confirm" : item.status}
      </Badge>
    </div>
  )
}

export function FindingsTab({ appt, patient, onEditOnRouter, onOpenOrtho }: FindingsTabProps) {
  const visit = useVisitStore((s) => s.getVisit(appt.id))
  const findings = visit.findings
  const treatmentItems = visit.treatmentItems
  const updateFindings = useVisitStore((s) => s.updateFindings)
  const stage = useStagedWritesStore((s) => s.stage)
  const [staged, setStaged] = useState(false)
  const [hasCase, setHasCase] = useState(appt.hasOpenTcCase || treatmentItems.length > 0)
  const [includedWatch, setIncludedWatch] = useState<Record<string, boolean>>({})

  const optimalItems = useMemo(
    () => treatmentItems.filter((t) => t.status === "proposed" || t.status === "confirmed" || t.status === "scheduled"),
    [treatmentItems],
  )
  const holdingItems = useMemo(() => treatmentItems.filter((t) => t.status === "watch"), [treatmentItems])
  const category = useMemo(() => deriveCategory(treatmentItems), [treatmentItems])

  const preview = useMemo(() => {
    const includedHolding = holdingItems.filter((t) => includedWatch[t.id])
    const handoffItems = [...optimalItems, ...includedHolding]
    return [
      `${category} · ${findings.urgency || "Routine"}`,
      findings.chiefConcern ? `Chief concern: ${findings.chiefConcern}` : "",
      findings.hygienistRecommendation ? `Hygienist recommendation: ${findings.hygienistRecommendation}` : "",
      findings.patientInterest ? `Patient interest: ${findings.patientInterest}` : "",
      ...handoffItems.map(
        (t) =>
          `Treatment item: ${teethLabel(t.teeth)} ${treatmentLabel(t.code)} — ${
            t.dx.map((d) => DX_LABELS[d]).join(", ") || "no dx noted"
          } (${PRIORITY_LABEL[t.priority]})`,
      ),
    ].filter(Boolean)
  }, [category, findings, optimalItems, holdingItems, includedWatch])

  function handleStage() {
    stage({
      apptId: appt.id,
      kind: "tc-handoff",
      title: `TC handoff — ${category}`,
      summary: findings.chiefConcern || "New case for treatment coordinator review",
      preview,
    })
    setStaged(true)
  }

  if (!hasCase) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty className="max-w-md border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardPlusIcon />
            </EmptyMedia>
            <EmptyTitle>No case flagged for {patient.name}</EmptyTitle>
            <EmptyDescription>Start a treatment coordinator handoff if you noticed something during this visit.</EmptyDescription>
          </EmptyHeader>
          <Button size="lg" className="h-11" onClick={() => setHasCase(true)}>
            Start TC handoff
          </Button>
        </Empty>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">{category}</h2>
          <span className="text-sm text-muted-foreground">derived from Router treatment items</span>
        </div>
        {onEditOnRouter && (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onEditOnRouter}>
            Edit on Router
          </Button>
        )}
      </div>

      {optimalItems.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            <h3 className="text-sm font-semibold text-foreground">Optimal treatment</h3>
            <div className="flex flex-col gap-2">
              {optimalItems.map((t) => (
                <ItemRow key={t.id} item={t} onOpenOrtho={t.category === "Ortho" ? onOpenOrtho : undefined} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {holdingItems.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Holding</h3>
              <span className="text-xs text-muted-foreground">Check to include in this handoff</span>
            </div>
            <div className="flex flex-col gap-2">
              {holdingItems.map((t) => (
                <ItemRow
                  key={t.id}
                  item={t}
                  includeInHandoff={includedWatch[t.id] ?? false}
                  onToggleInclude={(checked) => setIncludedWatch((prev) => ({ ...prev, [t.id]: checked }))}
                  onOpenOrtho={t.category === "Ortho" ? onOpenOrtho : undefined}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel>Urgency</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={findings.urgency}
            onValueChange={(v) => v && updateFindings(appt.id, { urgency: v })}
          >
            <ToggleGroupItem value="Routine" className="h-11 flex-1">
              Routine
            </ToggleGroupItem>
            <ToggleGroupItem value="Soon" className="h-11 flex-1">
              Soon
            </ToggleGroupItem>
            <ToggleGroupItem value="Urgent" className="h-11 flex-1">
              Urgent
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="chief-concern">Chief concern / what you noticed</FieldLabel>
          <Textarea
            id="chief-concern"
            placeholder="e.g. Patient reports sensitivity on #30, visible fracture line on distal cusp"
            value={findings.chiefConcern}
            onChange={(e) => updateFindings(appt.id, { chiefConcern: e.target.value })}
          />
        </Field>
      </FieldGroup>

      <FieldSet>
        <FieldLegend>Radiographs taken</FieldLegend>
        <div className="flex flex-wrap gap-2 pt-2">
          {RADIOGRAPH_OPTIONS.map((opt) => {
            const active = findings.radiographsTaken.includes(opt)
            return (
              <Button
                key={opt}
                type="button"
                variant={active ? "default" : "outline"}
                size="lg"
                className="h-11 rounded-full"
                onClick={() =>
                  updateFindings(appt.id, {
                    radiographsTaken: active
                      ? findings.radiographsTaken.filter((r) => r !== opt)
                      : [...findings.radiographsTaken, opt],
                  })
                }
              >
                {opt}
              </Button>
            )
          })}
        </div>
      </FieldSet>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="hygienist-recommendation">Your recommendation to the doctor</FieldLabel>
          <Textarea
            id="hygienist-recommendation"
            placeholder="e.g. Recommend doctor evaluate at today's exam"
            value={findings.hygienistRecommendation}
            onChange={(e) => updateFindings(appt.id, { hygienistRecommendation: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel>Patient interest level</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={findings.patientInterest}
            onValueChange={(v) => v && updateFindings(appt.id, { patientInterest: v })}
          >
            <ToggleGroupItem value="Curious" className="h-11 flex-1">
              Curious
            </ToggleGroupItem>
            <ToggleGroupItem value="Ready to book" className="h-11 flex-1">
              Ready to book
            </ToggleGroupItem>
            <ToggleGroupItem value="Hesitant" className="h-11 flex-1">
              Hesitant
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="insurance-noted">Insurance notes</FieldLabel>
          <Textarea
            id="insurance-noted"
            placeholder="e.g. Benefits reset in January, patient asked about payment plans"
            value={findings.insuranceNoted}
            onChange={(e) => updateFindings(appt.id, { insuranceNoted: e.target.value })}
          />
        </Field>
      </FieldGroup>

      <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t border-border bg-card px-6 py-4">
        <p className="text-sm text-muted-foreground">
          {staged ? "TC handoff staged — review before sending in Finish." : "Stage this case for the treatment coordinator."}
        </p>
        <Button size="lg" className="h-11" onClick={handleStage}>
          {staged ? "Update staged handoff" : "Stage TC handoff"}
        </Button>
      </div>
    </div>
  )
}
