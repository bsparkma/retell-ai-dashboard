import { useMemo, useState } from "react"
import { CheckIcon, InfoIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel, FieldGroup, FieldSet, FieldLegend, FieldDescription } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { MicTextarea } from "@/components/mic-textarea"
import { Odontogram, type Dentition } from "@/components/Odontogram"
import { TreatmentItemCard } from "./treatment-item-card"
import { useVisitStore, type RecordStatus } from "@/store/visit-store"
import { useStagedWritesStore } from "@/store/staged-writes-store"
import { TREATMENT_GROUPS } from "@/mock/treatment-options"
import { recordsNeededFor } from "@/mock/records-matrix"
import { getOdSnapshot } from "@/mock/od-snapshot"
import type { Appointment, Patient, TreatmentItem } from "@/mock/types"

const DONE_TODAY_OPTIONS = [
  { id: "prophy", label: "Prophy" },
  { id: "srp-ur", label: "SRP UR" },
  { id: "srp-ul", label: "SRP UL" },
  { id: "srp-lr", label: "SRP LR" },
  { id: "srp-ll", label: "SRP LL" },
  { id: "fluoride", label: "Fluoride" },
  { id: "sealants", label: "Sealants" },
  { id: "irrigation", label: "Irrigation" },
  { id: "polish", label: "Polish" },
]

const XRAY_OPTIONS = ["FMX", "PANO", "BW-4", "PA-1", "None"]
const PRODUCT_OPTIONS = ["Fluoride toothpaste", "Sensitivity gel", "Electric toothbrush sample", "Floss picks", "Water flosser info"]
const RECORD_STATUS_OPTIONS: { id: RecordStatus; label: string }[] = [
  { id: "needed", label: "Needed" },
  { id: "on file", label: "On file" },
  { id: "taken today", label: "Taken today" },
]

interface RouterTabProps {
  appt: Appointment
  patient: Patient
}

function HardCheckRow({
  label,
  value,
  onChange,
  id,
}: {
  label: string
  value: "" | "Y" | "N"
  onChange: (v: "" | "Y" | "N") => void
  id: string
}) {
  return (
    <div
      id={id}
      className={
        value === ""
          ? "flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 sm:flex-row sm:items-center sm:justify-between"
          : "flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:flex-row sm:items-center sm:justify-between"
      }
    >
      <FieldLabel className="font-medium">{label}</FieldLabel>
      <ToggleGroup type="single" variant="outline" value={value} onValueChange={(v) => v && onChange(v as "Y" | "N")}>
        <ToggleGroupItem value="Y" className="h-10 px-6">
          Yes
        </ToggleGroupItem>
        <ToggleGroupItem value="N" className="h-10 px-6">
          No
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}

export function RouterTab({ appt, patient }: RouterTabProps) {
  const visit = useVisitStore((s) => s.getVisit(appt.id))
  const router = visit.router
  const treatmentItems = visit.treatmentItems
  const updateRouter = useVisitStore((s) => s.updateRouter)
  const addTreatmentItem = useVisitStore((s) => s.addTreatmentItem)
  const updateTreatmentItem = useVisitStore((s) => s.updateTreatmentItem)
  const removeTreatmentItem = useVisitStore((s) => s.removeTreatmentItem)
  const stage = useStagedWritesStore((s) => s.stage)
  const [staged, setStaged] = useState(false)

  const [dentition, setDentition] = useState<Dentition>(appt.type === "Prophy Child" ? "primary" : "adult")
  const [pendingSelection, setPendingSelection] = useState<string[]>([])
  const [editingItemId, setEditingItemId] = useState<string | null>(null)

  const odSnapshot = getOdSnapshot(appt.id)
  const missingTeeth = visit.perioTeeth.filter((t) => t.missing).map((t) => t.toothNumber)
  const itemCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of treatmentItems) {
      if (item.teeth === "mouth") continue
      for (const tooth of item.teeth) counts[String(tooth)] = (counts[String(tooth)] ?? 0) + 1
    }
    return counts
  }, [treatmentItems])

  const editingItem = editingItemId ? treatmentItems.find((t) => t.id === editingItemId) : undefined
  const chartSelection = editingItem ? (editingItem.teeth === "mouth" ? [] : editingItem.teeth.map(String)) : pendingSelection

  const recordsNeeded = useMemo(() => recordsNeededFor(treatmentItems), [treatmentItems])
  const nextRestorativeItems = useMemo(() => treatmentItems.filter((t) => t.scheduleNext), [treatmentItems])

  function handleToggleTooth(tooth: string) {
    if (editingItem && editingItem.teeth !== "mouth") {
      const current = editingItem.teeth as number[]
      const num = Number(tooth)
      const teeth = current.includes(num) ? current.filter((t) => t !== num) : [...current, num]
      updateTreatmentItem(appt.id, editingItem.id, { teeth })
      return
    }
    setPendingSelection((prev) => (prev.includes(tooth) ? prev.filter((t) => t !== tooth) : [...prev, tooth]))
  }

  function handleSelectMany(teeth: string[]) {
    if (editingItem && editingItem.teeth !== "mouth") {
      const current = editingItem.teeth as number[]
      const nums = teeth.map(Number).filter((n) => !Number.isNaN(n))
      updateTreatmentItem(appt.id, editingItem.id, { teeth: Array.from(new Set([...current, ...nums])) })
      return
    }
    setPendingSelection((prev) => Array.from(new Set([...prev, ...teeth])))
  }

  function handlePickTreatment(code: string, category: TreatmentItem["category"], mouthLevel?: boolean) {
    if (!mouthLevel && pendingSelection.length === 0) return
    const teeth: number[] | "mouth" = mouthLevel
      ? "mouth"
      : pendingSelection.map(Number).filter((n) => !Number.isNaN(n))
    addTreatmentItem(appt.id, {
      teeth,
      code,
      category,
      surfaces: [],
      dx: [],
      priority: 4,
      motivation: [],
      status: "proposed",
      scheduleNext: false,
      photos: [],
    })
    setPendingSelection([])
  }

  function statusLabel(status: TreatmentItem["status"]) {
    if (status === "confirmed") return "doctor confirmed"
    if (status === "watch") return "watching"
    if (status === "scheduled") return "scheduled"
    return "doctor to confirm"
  }

  const summaryLines = useMemo(() => {
    const lines: string[] = []
    if (treatmentItems.length) {
      lines.push(`Treatment identified today (${treatmentItems.length}):`)
      for (const t of treatmentItems) {
        const teethLabel = t.teeth === "mouth" ? "Whole mouth" : `#${t.teeth.join(",")}`
        lines.push(`  ${teethLabel} · ${t.code} · ${t.dx.join(", ") || "no dx noted"} · P${t.priority} · ${statusLabel(t.status)}`)
      }
    }
    if (router.doneToday.length) {
      lines.push(`Done today: ${router.doneToday.map((id) => DONE_TODAY_OPTIONS.find((o) => o.id === id)?.label ?? id).join(", ")}`)
    }
    if (router.freeTextDoneToday) lines.push(router.freeTextDoneToday)
    if (router.xrayTypes.length) lines.push(`X-rays: ${router.xrayTypes.join(", ")}`)
    lines.push(`Exam status: ${router.examStatus}`)
    if (router.perioClassification.stage) {
      lines.push(`Perio classification: ${router.perioClassification.stage}${router.perioClassification.grade ? ` (Grade ${router.perioClassification.grade})` : ""}`)
    }
    lines.push(`Next hygiene visit: ${router.nextType}, ${router.nextInterval}mo, ${router.nextLength}min${router.scheduleWithDoctor ? " (with doctor)" : ""} — recare scheduled: ${router.recareScheduled || "not answered"}`)
    if (nextRestorativeItems.length) {
      lines.push(`Next restorative visit: ${nextRestorativeItems.map((t) => `${t.code}${t.teeth === "mouth" ? "" : ` #${(t.teeth as number[]).join(",")}`}`).join(", ")} — TX entered in OD: ${router.txEnteredInOD || "not answered"}`)
    }
    if (router.treatmentToSchedule) lines.push(`To schedule: ${router.treatmentToSchedule}`)
    if (router.frontDeskNotes) lines.push(`Front desk: ${router.frontDeskNotes}`)
    if (router.financialNotes) lines.push(`Financial: ${router.financialNotes}`)
    if (router.productsDispensed.length) lines.push(`Dispensed: ${router.productsDispensed.join(", ")}`)
    if (recordsNeeded.length) {
      lines.push(`Records needed: ${recordsNeeded.map((r) => `${r} (${router.recordsNeededStatus[r] ?? "needed"})`).join(", ")}`)
    }
    return lines
  }, [router, treatmentItems, nextRestorativeItems, recordsNeeded])

  function handleStage() {
    stage({
      apptId: appt.id,
      kind: "router",
      title: "Router slip",
      summary: `Front desk + next-visit routing for ${appt.type}`,
      preview: summaryLines,
    })
    setStaged(true)
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      {/* (a) From Open Dental — read only */}
      <FieldSet>
        <FieldLegend className="flex items-center gap-2">
          <InfoIcon className="size-4 text-muted-foreground" />
          From Open Dental
        </FieldLegend>
        <FieldDescription>Read-only — pulled from the practice management system, not editable here.</FieldDescription>
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-secondary/30 p-4 text-sm sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">Scheduled today: </span>
            <span className="font-medium text-foreground">{odSnapshot?.scheduledProcedures.join(", ") || "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Recall: </span>
            <span className="font-medium text-foreground">{odSnapshot?.recallDue || "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Insurance: </span>
            <span className="font-medium text-foreground">{odSnapshot?.insuranceRemaining || "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Medical alerts: </span>
            <span className="font-medium text-foreground">{odSnapshot?.medicalAlerts.join(", ") || "None on file"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Pending tx on file: </span>
            <span className="font-medium text-foreground">{odSnapshot?.pendingTx.join("; ") || "None"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Family due: </span>
            <span className="font-medium text-foreground">{odSnapshot?.familyMembersDue.join(", ") || "None"}</span>
          </div>
        </div>
      </FieldSet>

      {/* (b) Pre-visit checks */}
      <FieldSet>
        <FieldLegend>Pre-visit checks</FieldLegend>
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex items-center gap-2">
            <Switch
              id="name-contact"
              checked={router.preVisit.nameContactUpdated}
              onCheckedChange={(v) => updateRouter(appt.id, { preVisit: { ...router.preVisit, nameContactUpdated: v } })}
            />
            <FieldLabel htmlFor="name-contact" className="font-normal">
              Name / contact info confirmed
            </FieldLabel>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="insurance-verified"
              checked={router.preVisit.insuranceVerified}
              onCheckedChange={(v) => updateRouter(appt.id, { preVisit: { ...router.preVisit, insuranceVerified: v } })}
            />
            <FieldLabel htmlFor="insurance-verified" className="font-normal">
              Insurance verified
            </FieldLabel>
          </div>
          <Field>
            <FieldLabel htmlFor="balance-due">Balance to collect</FieldLabel>
            <Input
              id="balance-due"
              placeholder="e.g. $0 or $45 copay"
              value={router.preVisit.balanceToCollect}
              onChange={(e) => updateRouter(appt.id, { preVisit: { ...router.preVisit, balanceToCollect: e.target.value } })}
            />
          </Field>
          {patient.premedRequired && (
            <Field>
              <FieldLabel>Pre-medication taken</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={router.preVisit.premedTaken}
                onValueChange={(v) => v && updateRouter(appt.id, { preVisit: { ...router.preVisit, premedTaken: v as typeof router.preVisit.premedTaken } })}
              >
                <ToggleGroupItem value="Y" className="h-10 flex-1">
                  Yes
                </ToggleGroupItem>
                <ToggleGroupItem value="N" className="h-10 flex-1">
                  No
                </ToggleGroupItem>
                <ToggleGroupItem value="N/A" className="h-10 flex-1">
                  N/A
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="med-clearance">Medical clearance from doctor (if needed)</FieldLabel>
            <Input
              id="med-clearance"
              placeholder="e.g. Dr. Patel cleared for treatment 8/20"
              value={router.preVisit.medicalClearanceDoctor}
              onChange={(e) => updateRouter(appt.id, { preVisit: { ...router.preVisit, medicalClearanceDoctor: e.target.value } })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="health-changes">Health history changes</FieldLabel>
            <MicTextarea
              id="health-changes"
              value={router.preVisit.healthChangesNote}
              onChange={(v) => updateRouter(appt.id, { preVisit: { ...router.preVisit, healthChangesNote: v } })}
              placeholder="e.g. Started blood thinner last month"
              dictationSample="Patient reports starting a new blood pressure medication last month."
            />
          </Field>
        </div>
      </FieldSet>

      {/* (c) Visit type + last check-up */}
      <FieldSet>
        <FieldLegend>Visit type</FieldLegend>
        <div className="flex flex-col gap-4 pt-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={router.visitType}
            onValueChange={(v) => v && updateRouter(appt.id, { visitType: v as typeof router.visitType })}
            className="justify-start"
          >
            <ToggleGroupItem value="RA" className="h-11 px-4">
              RA
            </ToggleGroupItem>
            <ToggleGroupItem value="NP" className="h-11 px-4">
              New patient
            </ToggleGroupItem>
            <ToggleGroupItem value="Limited" className="h-11 px-4">
              Limited
            </ToggleGroupItem>
            <ToggleGroupItem value="Emergency" className="h-11 px-4">
              Emergency
            </ToggleGroupItem>
          </ToggleGroup>
          <Field>
            <FieldLabel>Last check-up</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={router.lastCheckup}
              onValueChange={(v) => v && updateRouter(appt.id, { lastCheckup: v as typeof router.lastCheckup })}
            >
              <ToggleGroupItem value="On time" className="h-10 flex-1">
                On time
              </ToggleGroupItem>
              <ToggleGroupItem value="Overdue" className="h-10 flex-1">
                Overdue
              </ToggleGroupItem>
              <ToggleGroupItem value="Unknown" className="h-10 flex-1">
                Unknown
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </div>
      </FieldSet>

      {/* (d) Records today */}
      <FieldSet>
        <FieldLegend>Records today</FieldLegend>
        <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="photos-count">Intraoral photos taken</FieldLabel>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 rounded-full"
                onClick={() => updateRouter(appt.id, { recordsToday: { ...router.recordsToday, photosCount: Math.max(0, router.recordsToday.photosCount - 1) } })}
              >
                &minus;
              </Button>
              <Input id="photos-count" readOnly value={router.recordsToday.photosCount} className="h-10 text-center" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 rounded-full"
                onClick={() => updateRouter(appt.id, { recordsToday: { ...router.recordsToday, photosCount: router.recordsToday.photosCount + 1 } })}
              >
                +
              </Button>
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="pa-teeth">PA teeth taken (comma-separated)</FieldLabel>
            <Input
              id="pa-teeth"
              placeholder="e.g. 3, 14, 19"
              value={router.recordsToday.paTeeth.join(", ")}
              onChange={(e) =>
                updateRouter(appt.id, {
                  recordsToday: {
                    ...router.recordsToday,
                    paTeeth: e.target.value
                      .split(",")
                      .map((s) => Number(s.trim()))
                      .filter((n) => !Number.isNaN(n)),
                  },
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel>Perio chart scope</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={router.recordsToday.perioChartScope}
              onValueChange={(v) => v && updateRouter(appt.id, { recordsToday: { ...router.recordsToday, perioChartScope: v as typeof router.recordsToday.perioChartScope } })}
            >
              <ToggleGroupItem value="full" className="h-10 flex-1">
                Full
              </ToggleGroupItem>
              <ToggleGroupItem value="partial" className="h-10 flex-1">
                Partial
              </ToggleGroupItem>
              <ToggleGroupItem value="none" className="h-10 flex-1">
                None
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <div className="flex flex-wrap items-center gap-4 pt-1">
            {(["bw", "pano", "ceph", "scan", "fluoride"] as const).map((key) => (
              <div key={key} className="flex items-center gap-2">
                <Switch
                  id={`records-${key}`}
                  checked={router.recordsToday[key]}
                  onCheckedChange={(v) => updateRouter(appt.id, { recordsToday: { ...router.recordsToday, [key]: v } })}
                />
                <FieldLabel htmlFor={`records-${key}`} className="font-normal uppercase">
                  {key}
                </FieldLabel>
              </div>
            ))}
          </div>
        </div>
      </FieldSet>

      {/* (e) Done today */}
      <FieldSet>
        <FieldLegend>Done today</FieldLegend>
        <FieldDescription>Tap everything completed this visit. This becomes the front-desk routing slip.</FieldDescription>
        {!!odSnapshot?.scheduledProcedures.length && (
          <p className="text-xs text-muted-foreground">Front desk scheduled: {odSnapshot.scheduledProcedures.join(", ")}</p>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          {DONE_TODAY_OPTIONS.map((opt) => {
            const active = router.doneToday.includes(opt.id)
            return (
              <Button
                key={opt.id}
                type="button"
                variant={active ? "default" : "outline"}
                size="lg"
                className="h-11 rounded-full"
                onClick={() =>
                  updateRouter(appt.id, {
                    doneToday: active ? router.doneToday.filter((id) => id !== opt.id) : [...router.doneToday, opt.id],
                  })
                }
              >
                {active && <CheckIcon data-icon="inline-start" />}
                {opt.label}
              </Button>
            )
          })}
        </div>
      </FieldSet>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="free-text-done">Anything else done today</FieldLabel>
          <Textarea
            id="free-text-done"
            placeholder="e.g. Extra time on lower anteriors, patient anxious about gag reflex"
            value={router.freeTextDoneToday}
            onChange={(e) => updateRouter(appt.id, { freeTextDoneToday: e.target.value })}
          />
        </Field>
      </FieldGroup>

      <FieldSet>
        <FieldLegend>X-rays taken</FieldLegend>
        <div className="flex flex-wrap gap-2 pt-2">
          {XRAY_OPTIONS.map((opt) => {
            const active = router.xrayTypes.includes(opt)
            return (
              <Button
                key={opt}
                type="button"
                variant={active ? "default" : "outline"}
                size="lg"
                className="h-11 rounded-full"
                onClick={() =>
                  updateRouter(appt.id, {
                    xrayTypes: active ? router.xrayTypes.filter((x) => x !== opt) : [...router.xrayTypes, opt],
                  })
                }
              >
                {opt}
              </Button>
            )
          })}
        </div>
      </FieldSet>

      {/* (f) Perio classification */}
      <FieldSet>
        <FieldLegend>Perio classification</FieldLegend>
        {router.visitType === "RA" && !router.perioClassification.stage && (
          <FieldDescription className="text-warning-foreground">Recommended for RA visits — not yet recorded.</FieldDescription>
        )}
        <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="perio-stage">Stage</FieldLabel>
            <Select
              value={router.perioClassification.stage}
              onValueChange={(v) => updateRouter(appt.id, { perioClassification: { ...router.perioClassification, stage: v as typeof router.perioClassification.stage } })}
            >
              <SelectTrigger id="perio-stage" className="h-11">
                <SelectValue placeholder="Choose a stage" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {["Health", "Gingivitis", "Stage I", "Stage II", "Stage III", "Stage IV"].map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Grade</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={router.perioClassification.grade}
              onValueChange={(v) => v && updateRouter(appt.id, { perioClassification: { ...router.perioClassification, grade: v as typeof router.perioClassification.grade } })}
            >
              <ToggleGroupItem value="A" className="h-11 flex-1">
                A
              </ToggleGroupItem>
              <ToggleGroupItem value="B" className="h-11 flex-1">
                B
              </ToggleGroupItem>
              <ToggleGroupItem value="C" className="h-11 flex-1">
                C
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </div>
      </FieldSet>

      {/* (g) Doctor exam */}
      <FieldGroup>
        <Field>
          <FieldLabel>Doctor exam status</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={router.examStatus}
            onValueChange={(v) => v && updateRouter(appt.id, { examStatus: v as typeof router.examStatus })}
            className="justify-start"
          >
            <ToggleGroupItem value="Needed today" className="h-11 px-4">
              Needed today
            </ToggleGroupItem>
            <ToggleGroupItem value="Completed" className="h-11 px-4">
              Completed
            </ToggleGroupItem>
            <ToggleGroupItem value="Not due" className="h-11 px-4">
              Not due
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <Switch
              id="exam-findings"
              checked={router.examFindingsReceived}
              onCheckedChange={(v) => updateRouter(appt.id, { examFindingsReceived: v })}
            />
            <FieldLabel htmlFor="exam-findings" className="font-normal">
              Findings received from doctor
            </FieldLabel>
          </div>
          <Field>
            <FieldLabel htmlFor="doctor-picker">Doctor seen</FieldLabel>
            <Input
              id="doctor-picker"
              placeholder="e.g. Dr. Patel"
              value={router.doctorPicker}
              onChange={(e) => updateRouter(appt.id, { doctorPicker: e.target.value })}
            />
          </Field>
        </div>
      </FieldGroup>

      {/* (h) Patient concerns / hygiene findings */}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="patient-concerns">Patient concerns</FieldLabel>
          <MicTextarea
            id="patient-concerns"
            value={router.patientConcerns}
            onChange={(v) => updateRouter(appt.id, { patientConcerns: v })}
            placeholder="e.g. Sensitivity on lower left when drinking cold water"
            dictationSample="Patient reports sensitivity on the lower left when drinking cold water."
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="hygiene-findings">Hygiene findings</FieldLabel>
          <MicTextarea
            id="hygiene-findings"
            value={router.hygieneFindings}
            onChange={(v) => updateRouter(appt.id, { hygieneFindings: v })}
            placeholder="e.g. Generalized moderate plaque, localized bleeding on probing lower anteriors"
            dictationSample="Generalized moderate plaque, localized bleeding on probing in the lower anteriors."
          />
        </Field>
      </FieldGroup>

      {/* Treatment identification via odontogram */}
      <FieldSet>
        <FieldLegend>Treatment identified today</FieldLegend>
        <FieldDescription>
          Tap teeth on the chart, then pick a treatment to create an item. Whole-mouth treatments (ortho, whitening, appliances) don&apos;t need a tooth selection.
        </FieldDescription>
        <div className="flex flex-col gap-4 pt-2">
          <Odontogram
            dentition={dentition}
            onDentitionChange={setDentition}
            selected={chartSelection}
            onToggleTooth={handleToggleTooth}
            onClear={() => setPendingSelection([])}
            onSelectMany={handleSelectMany}
            missingTeeth={missingTeeth}
            itemCounts={itemCounts}
          />

          {editingItem && (
            <div className="flex items-center justify-between rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
              <span>Editing teeth for {editingItem.code} — tap teeth to add or remove.</span>
              <Button size="sm" variant="ghost" onClick={() => setEditingItemId(null)}>
                Done
              </Button>
            </div>
          )}

          {!editingItem && (
            <div className="flex flex-col gap-2">
              <FieldLabel className="text-sm text-muted-foreground">
                {pendingSelection.length > 0 ? `Pick a treatment for ${pendingSelection.length} tooth/teeth selected` : "Select teeth above, then pick a treatment (or pick a whole-mouth treatment directly)"}
              </FieldLabel>
              <div className="flex flex-col gap-2">
                {TREATMENT_GROUPS.map((g) => (
                  <div key={g.category} className="flex flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {g.category}
                    </span>
                    {g.treatments.map((t) => (
                      <Button
                        key={t.code}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-full"
                        disabled={!t.mouthLevel && pendingSelection.length === 0}
                        onClick={() => handlePickTreatment(t.code, t.category, t.mouthLevel)}
                      >
                        {t.label}
                      </Button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {treatmentItems.length > 0 && (
            <div className="flex flex-col gap-3">
              {treatmentItems.map((item) => (
                <TreatmentItemCard
                  key={item.id}
                  item={item}
                  editingTeeth={editingItemId === item.id}
                  onStartEditTeeth={() => setEditingItemId(item.id)}
                  onStopEditTeeth={() => setEditingItemId(null)}
                  onRemoveTooth={(tooth) =>
                    updateTreatmentItem(appt.id, item.id, {
                      teeth: item.teeth === "mouth" ? "mouth" : item.teeth.filter((t) => t !== tooth),
                    })
                  }
                  onUpdate={(patch) => updateTreatmentItem(appt.id, item.id, patch)}
                  onDelete={() => removeTreatmentItem(appt.id, item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </FieldSet>

      {/* (i) Next hygiene visit — hard check #1 */}
      <FieldSet>
        <FieldLegend>Next hygiene visit</FieldLegend>
        <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="next-type">Type</FieldLabel>
            <Select value={router.nextType} onValueChange={(v) => updateRouter(appt.id, { nextType: v })}>
              <SelectTrigger id="next-type" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {["Prophy", "Perio Maint", "SRP", "Ortho Adj", "Doctor exam"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="next-interval">Interval (months)</FieldLabel>
            <Select value={router.nextInterval} onValueChange={(v) => updateRouter(appt.id, { nextInterval: v as typeof router.nextInterval })}>
              <SelectTrigger id="next-interval" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {["3", "4", "6", "12"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t} mo
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="next-length">Length (min)</FieldLabel>
            <Select value={router.nextLength} onValueChange={(v) => updateRouter(appt.id, { nextLength: v as typeof router.nextLength })}>
              <SelectTrigger id="next-length" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {["30", "45", "60", "90"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t} min
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="flex items-center gap-2 pt-3">
          <Switch
            id="schedule-doctor"
            checked={router.scheduleWithDoctor}
            onCheckedChange={(v) => updateRouter(appt.id, { scheduleWithDoctor: v })}
          />
          <FieldLabel htmlFor="schedule-doctor" className="font-normal">
            Schedule with doctor
          </FieldLabel>
        </div>
        <div className="pt-3">
          <HardCheckRow
            id="recare-scheduled"
            label="Recare scheduled?"
            value={router.recareScheduled}
            onChange={(v) => updateRouter(appt.id, { recareScheduled: v })}
          />
        </div>
      </FieldSet>

      {/* (j) Next restorative visit — hard check #2 */}
      <FieldSet>
        <FieldLegend>Next restorative visit</FieldLegend>
        <FieldDescription>Auto-built from treatment items marked &quot;Schedule at next restorative visit&quot;.</FieldDescription>
        <div className="flex flex-col gap-2 pt-2">
          {nextRestorativeItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No treatment items flagged for the next restorative visit.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {nextRestorativeItems.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
                  <span>
                    {t.code} {t.teeth === "mouth" ? "(whole mouth)" : `#${(t.teeth as number[]).join(",")}`}
                  </span>
                  <Badge variant="outline">P{t.priority}</Badge>
                </div>
              ))}
            </div>
          )}
          <div className="pt-2">
            <HardCheckRow
              id="tx-entered-od"
              label="TX entered in OD?"
              value={router.txEnteredInOD}
              onChange={(v) => updateRouter(appt.id, { txEnteredInOD: v })}
            />
          </div>
        </div>
      </FieldSet>

      {/* (k) Admin */}
      <FieldSet>
        <FieldLegend>Admin</FieldLegend>
        <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="pre-auth">Pre-auth items</FieldLabel>
            <Input
              id="pre-auth"
              placeholder="e.g. Crown #14 pre-auth submitted"
              value={router.admin.preAuthItems}
              onChange={(e) => updateRouter(appt.id, { admin: { ...router.admin, preAuthItems: e.target.value } })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="referral">Referral</FieldLabel>
            <Input
              id="referral"
              placeholder="e.g. Refer to periodontist"
              value={router.admin.referral}
              onChange={(e) => updateRouter(appt.id, { admin: { ...router.admin, referral: e.target.value } })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="rx">Rx</FieldLabel>
            <Input
              id="rx"
              placeholder="e.g. Chlorhexidine rinse"
              value={router.admin.rx}
              onChange={(e) => updateRouter(appt.id, { admin: { ...router.admin, rx: e.target.value } })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="family-recare">Family recare</FieldLabel>
            <Input
              id="family-recare"
              placeholder="e.g. Schedule spouse for overdue recall"
              value={router.admin.familyRecare}
              onChange={(e) => updateRouter(appt.id, { admin: { ...router.admin, familyRecare: e.target.value } })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="room-setup">Room setup for next visit</FieldLabel>
            <Input
              id="room-setup"
              placeholder="e.g. Set up surgical tray"
              value={router.admin.roomSetup}
              onChange={(e) => updateRouter(appt.id, { admin: { ...router.admin, roomSetup: e.target.value } })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="assistant">Assistant needed</FieldLabel>
            <Input
              id="assistant"
              placeholder="e.g. Yes, for crown prep"
              value={router.admin.assistant}
              onChange={(e) => updateRouter(appt.id, { admin: { ...router.admin, assistant: e.target.value } })}
            />
          </Field>
        </div>
      </FieldSet>

      {/* (l) Records needed for planned treatment */}
      <FieldSet>
        <FieldLegend>Records needed for planned treatment</FieldLegend>
        <FieldDescription>Generated from the treatment items above.</FieldDescription>
        <div className="flex flex-col gap-2 pt-2">
          {recordsNeeded.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records required by the treatment identified so far.</p>
          ) : (
            recordsNeeded.map((r) => {
              const status = router.recordsNeededStatus[r] ?? "needed"
              return (
                <div key={r} className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <FieldLabel className="font-normal">{r}</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={status}
                    onValueChange={(v) => v && updateRouter(appt.id, { recordsNeededStatus: { ...router.recordsNeededStatus, [r]: v as RecordStatus } })}
                  >
                    {RECORD_STATUS_OPTIONS.map((o) => (
                      <ToggleGroupItem key={o.id} value={o.id} className="h-9 px-3 text-xs">
                        {o.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              )
            })
          )}
        </div>
      </FieldSet>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="treatment-schedule" className="flex items-center justify-between">
            <span>Treatment to schedule (manual shortcut)</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 rounded-full"
              disabled={treatmentItems.length === 0 && !router.treatmentToSchedule}
              onClick={() =>
                stage({
                  apptId: appt.id,
                  kind: "tc-handoff",
                  title: "TC handoff — from Router",
                  summary: router.treatmentToSchedule || `${treatmentItems.length} treatment item(s) identified today`,
                  preview: treatmentItems.map(
                    (t) => `${t.code} ${t.teeth === "mouth" ? "(whole mouth)" : `#${(t.teeth as number[]).join(",")}`} — ${t.dx.join(", ") || "no dx noted"} (P${t.priority})`,
                  ),
                })
              }
            >
              Send to TC
            </Button>
          </FieldLabel>
          <FieldDescription>Optional — the tooth chart above is the preferred way to flag treatment.</FieldDescription>
          <Input
            id="treatment-schedule"
            placeholder="e.g. Crown #14, occlusal composite #30"
            value={router.treatmentToSchedule}
            onChange={(e) => updateRouter(appt.id, { treatmentToSchedule: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="front-desk-notes">Notes for front desk</FieldLabel>
          <Textarea
            id="front-desk-notes"
            placeholder="e.g. Wants morning appointments only"
            value={router.frontDeskNotes}
            onChange={(e) => updateRouter(appt.id, { frontDeskNotes: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="financial-notes">Financial notes</FieldLabel>
          <Textarea
            id="financial-notes"
            placeholder="e.g. Confirm insurance eligibility before next visit"
            value={router.financialNotes}
            onChange={(e) => updateRouter(appt.id, { financialNotes: e.target.value })}
          />
        </Field>
      </FieldGroup>

      <FieldSet>
        <FieldLegend>Products dispensed</FieldLegend>
        <div className="flex flex-wrap gap-2 pt-2">
          {PRODUCT_OPTIONS.map((opt) => {
            const active = router.productsDispensed.includes(opt)
            return (
              <Button
                key={opt}
                type="button"
                variant={active ? "default" : "outline"}
                size="lg"
                className="h-11 rounded-full"
                onClick={() =>
                  updateRouter(appt.id, {
                    productsDispensed: active ? router.productsDispensed.filter((p) => p !== opt) : [...router.productsDispensed, opt],
                  })
                }
              >
                {opt}
              </Button>
            )
          })}
        </div>
      </FieldSet>

      <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t border-border bg-card px-6 py-4">
        <p className="text-sm text-muted-foreground">
          {staged ? "Router slip staged — review before sending in Finish." : "Stage the router slip when done filling this out."}
        </p>
        <Button size="lg" className="h-11" onClick={handleStage}>
          {staged ? "Update staged slip" : "Stage router slip"}
        </Button>
      </div>
    </div>
  )
}
