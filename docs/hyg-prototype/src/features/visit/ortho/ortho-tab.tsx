"use client"

import { useMemo, useState } from "react"
import { CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel, FieldGroup, FieldSet, FieldLegend, FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MicTextarea } from "@/components/mic-textarea"
import { Odontogram } from "@/components/Odontogram"
import { CollapsibleSection } from "@/components/collapsible-section"
import { useVisitStore, type RecordStatus } from "@/store/visit-store"
import { useStagedWritesStore } from "@/store/staged-writes-store"
import { getOdSnapshot } from "@/mock/od-snapshot"
import type { Appointment, Patient } from "@/mock/types"

interface OrthoTabProps {
  appt: Appointment
  patient: Patient
}

const CLASS_OPTIONS = ["I", "II-1", "II-2", "III"]
const CROSSBITE_OPTIONS = ["Anterior", "Posterior R", "Posterior L", "Bilateral", "Scissor"]
const ARCH_SEVERITY_OPTIONS = ["None", "Mild", "Moderate", "Severe"]
const HABITS_OPTIONS = ["Thumb", "Tongue thrust", "Mouth breathing", "Bruxism", "Nail biting"]
const AIRWAY_OPTIONS = ["Mouth breathing", "Snoring reported", "Tonsil/adenoid hx", "Sleep-disordered breathing", "None"]
const TMJ_OPTIONS = ["Clicking", "Popping", "Pain", "Limited opening", "None"]
const ASYMMETRY_FACIAL_OPTIONS = ["Chin deviation", "Nasal deviation", "Cant", "None"]
const ASYMMETRY_DENTAL_OPTIONS = ["Midline shift", "Arch width", "Tooth size discrepancy", "None"]
const RECORD_STATUS_OPTIONS: { id: RecordStatus; label: string }[] = [
  { id: "needed", label: "Needed" },
  { id: "on file", label: "On file" },
  { id: "taken today", label: "Taken today" },
]
const ORTHO_RECORDS_LIST = [
  "Pano",
  "Ceph",
  "Intraoral \u2013 frontal",
  "Intraoral \u2013 right buccal",
  "Intraoral \u2013 left buccal",
  "Intraoral \u2013 upper occlusal",
  "Intraoral \u2013 lower occlusal",
  "Extraoral \u2013 frontal smile",
  "Extraoral \u2013 frontal repose",
  "Extraoral \u2013 profile",
  "Scan \u2013 upper",
  "Scan \u2013 lower",
  "Scan \u2013 bite",
  "Impressions",
  "Models",
]
const TRACK_OPTIONS = ["Braces", "Aligners", "Expansion only", "Myofunctional", "Observation", "Refer out"]
const TREATMENT_REASON_OPTIONS = ["Esthetic", "Functional", "Airway", "Crowding", "Growth guidance", "Post-restorative"]
const BRACES_MATERIAL_OPTIONS = ["Metal", "Ceramic", "Self-ligating", "Lingual"]
const ARCH_OPTIONS = ["Upper", "Lower", "Both"]
const ALIGNER_BRAND_OPTIONS = ["AWS", "Invisalign", "ClearCorrect", "In-house"]
const MYO_TARGET_OPTIONS = ["Tongue posture", "Nasal breathing", "Lip seal", "Swallowing pattern"]
const TREATMENT_TIME_BAND_OPTIONS = ["6\u20139 months", "9\u201312 months", "12\u201318 months", "18\u201324 months", "24+ months"]
const RETENTION_TYPE_OPTIONS = ["Hawley", "Essix/clear", "Bonded fixed", "None"]
const ADDITIONAL_WORK_OPTIONS = [
  "Peg-lateral bonding",
  "Anterior fills",
  "Veneers",
  "Pontics",
  "Maryland bridge",
  "Implants",
  "FMR",
  "Smile makeover",
  "Whitening",
  "Frenectomy",
]
const REFERRAL_OPTIONS: { id: "In-house" | "Refer out" | "Joint"; label: string }[] = [
  { id: "In-house", label: "In-house" },
  { id: "Refer out", label: "Refer out" },
  { id: "Joint", label: "Joint" },
]
const HANDOFF_VISIT_TYPE_OPTIONS = ["Records", "Consult", "Financial", "Start"]
const FEE_BAND_OPTIONS = ["$2,000\u20133,000", "$3,000\u20134,000", "$4,000\u20135,000", "$5,000\u20136,000", "$6,000+"]
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date()
  d.setMonth(d.getMonth() + i)
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" })
})

const APPLIANCE_OPTIONS = ["Aligners", "Braces", "Retainer", "Expander"]
const ISSUE_OPTIONS = ["Broken bracket", "Lost tray", "IPR needed", "Attachment off", "Poor tracking", "Irritation"]
const NEXT_INTERVAL_OPTIONS = ["2 wk", "4 wk", "6 wk", "8 wk"]

function ChipGroup({
  options,
  value,
  onToggle,
}: {
  options: string[]
  value: string[]
  onToggle: (opt: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {options.map((opt) => {
        const active = value.includes(opt)
        return (
          <Button
            key={opt}
            type="button"
            variant={active ? "default" : "outline"}
            size="lg"
            className="h-11 rounded-full"
            onClick={() => onToggle(opt)}
          >
            {opt}
          </Button>
        )
      })}
    </div>
  )
}

function Stepper({
  value,
  onChange,
  suffix,
  step = 0.5,
  min = 0,
  max = 15,
}: {
  value: string
  onChange: (v: string) => void
  suffix: string
  step?: number
  min?: number
  max?: number
}) {
  const num = Number.parseFloat(value) || 0
  function set(n: number) {
    const clamped = Math.min(max, Math.max(min, n))
    onChange(String(clamped))
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="icon" className="size-11 shrink-0 rounded-full" onClick={() => set(num - step)}>
        &minus;
      </Button>
      <Input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 text-center"
        placeholder="0"
      />
      <span className="w-8 shrink-0 text-sm text-muted-foreground">{suffix}</span>
      <Button type="button" variant="outline" size="icon" className="size-11 shrink-0 rounded-full" onClick={() => set(num + step)}>
        +
      </Button>
    </div>
  )
}

function RecordStatusRow({
  label,
  status,
  onChange,
}: {
  label: string
  status: RecordStatus
  onChange: (status: RecordStatus) => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <FieldLabel className="font-normal">{label}</FieldLabel>
      <ToggleGroup type="single" variant="outline" value={status} onValueChange={(v) => v && onChange(v as RecordStatus)}>
        {RECORD_STATUS_OPTIONS.map((o) => (
          <ToggleGroupItem key={o.id} value={o.id} className="h-9 px-3 text-xs">
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

function toggleInArray<T>(arr: T[], value: T) {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
}

export function OrthoTab({ appt, patient }: OrthoTabProps) {
  const workup = useVisitStore((s) => s.getVisit(appt.id).ortho)
  const updateOrtho = useVisitStore((s) => s.updateOrtho)
  const adj = useVisitStore((s) => s.getVisit(appt.id).orthoAdj)
  const updateOrthoAdj = useVisitStore((s) => s.updateOrthoAdj)
  const treatmentItems = useVisitStore((s) => s.getVisit(appt.id).treatmentItems)
  const addTreatmentItem = useVisitStore((s) => s.addTreatmentItem)
  const removeTreatmentItem = useVisitStore((s) => s.removeTreatmentItem)
  const stage = useStagedWritesStore((s) => s.stage)
  const [staged, setStaged] = useState(false)
  const [mode, setMode] = useState<"workup" | "adjustment">(appt.type === "Ortho Adj" ? "adjustment" : "workup")
  const odSnapshot = getOdSnapshot(appt.id)

  const postOrthoItems = useMemo(
    () => treatmentItems.filter((t) => t.tags?.includes("post-ortho")),
    [treatmentItems],
  )

  function toggleAdditionalWork(opt: string) {
    const existing = postOrthoItems.find((t) => t.note === opt)
    if (existing) {
      removeTreatmentItem(appt.id, existing.id)
      updateOrtho(appt.id, { additionalWorkAfterOrtho: workup.additionalWorkAfterOrtho.filter((w) => w !== opt) })
    } else {
      addTreatmentItem(appt.id, {
        teeth: "mouth",
        code: "Watch",
        category: "Other",
        dx: [],
        priority: 4,
        motivation: [],
        status: "watch",
        scheduleNext: false,
        note: opt,
        photos: [],
        tags: ["post-ortho"],
      })
      updateOrtho(appt.id, { additionalWorkAfterOrtho: [...workup.additionalWorkAfterOrtho, opt] })
    }
  }

  const appliancesSummary = useMemo(() => {
    const parts: string[] = []
    if (workup.track === "Braces" || workup.bracesMaterial) {
      parts.push(`Braces${workup.bracesMaterial ? ` (${workup.bracesMaterial}${workup.bracesArch ? `, ${workup.bracesArch}` : ""})` : ""}`)
    }
    if (workup.track === "Aligners" || workup.alignerBrand) {
      parts.push(`Aligners${workup.alignerBrand ? ` (${workup.alignerBrand}${workup.alignerEstTrays ? `, ~${workup.alignerEstTrays} trays` : ""})` : ""}`)
    }
    if (workup.expansionUpper === "Y") parts.push(`Upper expansion${workup.expansionUpperAppliance ? ` (${workup.expansionUpperAppliance})` : ""}`)
    if (workup.expansionLower === "Y") parts.push(`Lower expansion${workup.expansionLowerAppliance ? ` (${workup.expansionLowerAppliance})` : ""}`)
    if (workup.myobrace) parts.push("Myobrace")
    return parts.length ? parts.join(", ") : workup.track || "Not specified"
  }, [workup])

  const handoffPreview = useMemo(
    () => [
      `Track: ${workup.track || "Not specified"}`,
      `Estimated months: ${workup.treatmentMonths || workup.treatmentTimeBand || "TBD"}`,
      `Appliances: ${appliancesSummary}`,
      `Retention: ${workup.retentionType || "TBD"}${workup.retentionPonticTeeth.length ? ` (pontics #${workup.retentionPonticTeeth.join(",")})` : ""}`,
      `Post-ortho work: ${workup.additionalWorkAfterOrtho.length ? workup.additionalWorkAfterOrtho.join(", ") : "None anticipated"}`,
    ],
    [workup, appliancesSummary],
  )

  const adjPreview = useMemo(
    () => [
      `Appliance: ${adj.applianceType}${adj.trayNumber ? ` (tray ${adj.trayNumber}${adj.trayTotal ? ` of ${adj.trayTotal}` : ""})` : ""}`,
      `Compliance: ~${adj.complianceHours}h/day`,
      adj.issues.length ? `Issues: ${adj.issues.join(", ")}` : "No issues reported",
      adj.elastics ? `Elastics: ${adj.elasticsPattern || "worn as directed"}` : "",
      adj.wireChange ? `Wire change: ${adj.wireChange}` : "",
      adj.ohGrade ? `OH grade: ${adj.ohGrade}` : "",
      adj.whiteSpotTeeth.length ? `White-spot lesions: #${adj.whiteSpotTeeth.join(",")}` : "",
      adj.monthsRemaining ? `Months remaining: ${adj.monthsRemaining}` : "",
      adj.debondMonth ? `Debond anticipated: ${adj.debondMonth}` : "",
      `Next: ${adj.nextTrayCount ? `trays ${adj.nextTrayCount}, ` : ""}${adj.nextInterval}`,
      adj.notes,
    ].filter(Boolean),
    [adj],
  )

  function handleStageAdjustment() {
    stage({
      apptId: appt.id,
      kind: "note",
      title: "Ortho adjustment note",
      summary: `Adjustment visit for ${patient.name}`,
      preview: adjPreview,
    })
    setStaged(true)
  }

  function handleSendToTc() {
    addTreatmentItem(appt.id, {
      teeth: "mouth",
      code: workup.track === "Aligners" ? "Aligners" : "Ortho",
      category: "Ortho",
      dx: [],
      priority: 3,
      motivation: [],
      status: "proposed",
      scheduleNext: false,
      note: workup.chiefComplaint,
      photos: [],
    })
    stage({
      apptId: appt.id,
      kind: "tc-handoff",
      title: "TC handoff \u2014 Ortho case",
      summary: workup.track ? `${workup.track} workup for ${patient.name}` : `Ortho workup for ${patient.name}`,
      preview: handoffPreview,
      caseType: "ortho",
    })
    setStaged(true)
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode}
          onValueChange={(v) => v && setMode(v as "workup" | "adjustment")}
          className="w-full sm:w-auto"
        >
          <ToggleGroupItem value="workup" className="h-11 flex-1 sm:flex-initial sm:px-6">
            Workup
          </ToggleGroupItem>
          <ToggleGroupItem value="adjustment" className="h-11 flex-1 sm:flex-initial sm:px-6">
            Adjustment
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {mode === "adjustment" ? (
        <>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Appliance type</FieldLabel>
                <Select value={adj.applianceType} onValueChange={(v) => updateOrthoAdj(appt.id, { applianceType: v })}>
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {APPLIANCE_OPTIONS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="tray-number">Current tray #</FieldLabel>
                  <Input
                    id="tray-number"
                    inputMode="numeric"
                    placeholder="14"
                    value={adj.trayNumber}
                    onChange={(e) => updateOrthoAdj(appt.id, { trayNumber: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tray-total">Total trays</FieldLabel>
                  <Input
                    id="tray-total"
                    inputMode="numeric"
                    placeholder="32"
                    value={adj.trayTotal}
                    onChange={(e) => updateOrthoAdj(appt.id, { trayTotal: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup>
            <Field>
              <FieldLabel>Reported compliance (hours/day): {adj.complianceHours}</FieldLabel>
              <Slider
                value={[adj.complianceHours]}
                min={0}
                max={22}
                step={1}
                onValueChange={([v]) => updateOrthoAdj(appt.id, { complianceHours: v })}
                className="py-2"
              />
            </Field>
          </FieldGroup>

          <FieldSet>
            <FieldLegend>Issues today</FieldLegend>
            <ChipGroup
              options={ISSUE_OPTIONS}
              value={adj.issues}
              onToggle={(opt) =>
                updateOrthoAdj(appt.id, { issues: toggleInArray(adj.issues, opt) })
              }
            />
          </FieldSet>

          <FieldGroup>
            <div className="flex items-center gap-3">
              <Switch
                id="elastics"
                checked={adj.elastics}
                onCheckedChange={(v) => updateOrthoAdj(appt.id, { elastics: v })}
              />
              <FieldLabel htmlFor="elastics" className="font-normal">
                Elastics worn
              </FieldLabel>
            </div>
            {adj.elastics && (
              <Field>
                <FieldLabel htmlFor="elastics-pattern">Elastics pattern</FieldLabel>
                <Input
                  id="elastics-pattern"
                  placeholder="e.g. Class II, nightly"
                  value={adj.elasticsPattern}
                  onChange={(e) => updateOrthoAdj(appt.id, { elasticsPattern: e.target.value })}
                />
              </Field>
            )}
          </FieldGroup>

          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="wire-change">Wire change</FieldLabel>
                <Input
                  id="wire-change"
                  placeholder="e.g. .016 NiTi \u2192 .018 SS"
                  value={adj.wireChange}
                  onChange={(e) => updateOrthoAdj(appt.id, { wireChange: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>Oral hygiene grade</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={adj.ohGrade}
                  onValueChange={(v) => v && updateOrthoAdj(appt.id, { ohGrade: v as typeof adj.ohGrade })}
                >
                  <ToggleGroupItem value="Good" className="h-11 flex-1">
                    Good
                  </ToggleGroupItem>
                  <ToggleGroupItem value="Fair" className="h-11 flex-1">
                    Fair
                  </ToggleGroupItem>
                  <ToggleGroupItem value="Poor" className="h-11 flex-1">
                    Poor
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </div>
          </FieldGroup>

          <FieldSet>
            <FieldLegend>White-spot lesions</FieldLegend>
            <FieldDescription>Tap teeth with visible white-spot lesions.</FieldDescription>
            <Odontogram
              className="pt-2"
              dentition="adult"
              allowDentitionToggle={false}
              selected={adj.whiteSpotTeeth.map(String)}
              onToggleTooth={(tooth) =>
                updateOrthoAdj(appt.id, {
                  whiteSpotTeeth: toggleInArray(adj.whiteSpotTeeth, Number.parseInt(tooth, 10)),
                })
              }
            />
          </FieldSet>

          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="months-remaining">Months remaining</FieldLabel>
                <Input
                  id="months-remaining"
                  inputMode="numeric"
                  placeholder="e.g. 8"
                  value={adj.monthsRemaining}
                  onChange={(e) => updateOrthoAdj(appt.id, { monthsRemaining: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>Debond anticipated</FieldLabel>
                <Select value={adj.debondMonth} onValueChange={(v) => updateOrthoAdj(appt.id, { debondMonth: v })}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Choose a month" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {MONTH_OPTIONS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </FieldGroup>

          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="next-tray">Next tray count given</FieldLabel>
                <Input
                  id="next-tray"
                  placeholder="e.g. 15-16"
                  value={adj.nextTrayCount}
                  onChange={(e) => updateOrthoAdj(appt.id, { nextTrayCount: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>Next visit interval</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={adj.nextInterval}
                  onValueChange={(v) => v && updateOrthoAdj(appt.id, { nextInterval: v })}
                >
                  {NEXT_INTERVAL_OPTIONS.map((v) => (
                    <ToggleGroupItem key={v} value={v} className="h-11 flex-1">
                      {v}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="adj-notes">Notes</FieldLabel>
              <MicTextarea
                id="adj-notes"
                value={adj.notes}
                onChange={(v) => updateOrthoAdj(appt.id, { notes: v })}
                dictationSample="Tracking well, no sore spots reported today."
              />
            </Field>
          </FieldGroup>

          <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t border-border bg-card px-6 py-4">
            <p className="text-sm text-muted-foreground">{staged ? "Adjustment note staged." : "Stage this adjustment note."}</p>
            <Button size="lg" className="h-11" onClick={handleStageAdjustment}>
              {staged ? "Update staged note" : "Stage note"}
            </Button>
          </div>
        </>
      ) : (
        <>
          {/* A. Clinical findings */}
          <CollapsibleSection
            title="A. Clinical findings"
            notAssessed={workup.notAssessed.clinical}
            onNotAssessedChange={(v) => updateOrtho(appt.id, { notAssessed: { ...workup.notAssessed, clinical: v } })}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Age</FieldLabel>
                <p className="flex h-11 items-center rounded-md border border-border bg-secondary/30 px-3 text-sm text-foreground">
                  {patient.age} years
                </p>
              </Field>
              <Field>
                <FieldLabel>Growth status</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={workup.growing}
                  onValueChange={(v) => v && updateOrtho(appt.id, { growing: v as typeof workup.growing })}
                >
                  <ToggleGroupItem value="Growing" className="h-11 flex-1">
                    Growing
                  </ToggleGroupItem>
                  <ToggleGroupItem value="Non-growing" className="h-11 flex-1">
                    Non-growing
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </div>

            <div className="flex items-center gap-3">
              <Switch
                id="mixed-dentition"
                checked={workup.mixedDentition}
                onCheckedChange={(v) => updateOrtho(appt.id, { mixedDentition: v })}
              />
              <FieldLabel htmlFor="mixed-dentition" className="font-normal">
                Mixed dentition
              </FieldLabel>
            </div>

            <Field>
              <FieldLabel>Dentition</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={workup.dentition}
                onValueChange={(v) => v && updateOrtho(appt.id, { dentition: v as typeof workup.dentition })}
              >
                <ToggleGroupItem value="adult" className="h-11 flex-1">
                  Adult (1\u201332)
                </ToggleGroupItem>
                <ToggleGroupItem value="primary" className="h-11 flex-1">
                  Primary (A\u2013T)
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>

            <FieldSet>
              <FieldLegend>Molar / canine classification</FieldLegend>
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Molar class \u2014 left</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.molarClassLeft} onValueChange={(v) => v && updateOrtho(appt.id, { molarClassLeft: v })}>
                    {CLASS_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel>Molar class \u2014 right</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.molarClassRight} onValueChange={(v) => v && updateOrtho(appt.id, { molarClassRight: v })}>
                    {CLASS_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel>Canine class \u2014 left</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.canineClassLeft} onValueChange={(v) => v && updateOrtho(appt.id, { canineClassLeft: v })}>
                    {CLASS_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel>Canine class \u2014 right</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.canineClassRight} onValueChange={(v) => v && updateOrtho(appt.id, { canineClassRight: v })}>
                    {CLASS_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              </div>
            </FieldSet>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Overjet</FieldLabel>
                <Stepper value={workup.overjet} onChange={(v) => updateOrtho(appt.id, { overjet: v })} suffix="mm" step={0.5} min={-5} max={15} />
              </Field>
              <Field>
                <FieldLabel>Overbite</FieldLabel>
                <Stepper value={workup.overbite} onChange={(v) => updateOrtho(appt.id, { overbite: v })} suffix="%" step={5} min={-50} max={100} />
                <div className="flex items-center gap-2 pt-2">
                  <Switch
                    id="open-bite"
                    checked={workup.openBite}
                    onCheckedChange={(v) => updateOrtho(appt.id, { openBite: v })}
                  />
                  <FieldLabel htmlFor="open-bite" className="font-normal">
                    Open bite
                  </FieldLabel>
                </div>
              </Field>
            </div>

            <FieldSet>
              <FieldLegend>Crossbite</FieldLegend>
              <ChipGroup
                options={CROSSBITE_OPTIONS}
                value={workup.crossbite}
                onToggle={(opt) => updateOrtho(appt.id, { crossbite: toggleInArray(workup.crossbite, opt) })}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Crowding per arch</FieldLegend>
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Upper</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.crowdingUpper} onValueChange={(v) => v && updateOrtho(appt.id, { crowdingUpper: v })}>
                    {ARCH_SEVERITY_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs sm:text-sm">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel>Lower</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.crowdingLower} onValueChange={(v) => v && updateOrtho(appt.id, { crowdingLower: v })}>
                    {ARCH_SEVERITY_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs sm:text-sm">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Spacing per arch</FieldLegend>
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Upper</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.spacingUpper} onValueChange={(v) => v && updateOrtho(appt.id, { spacingUpper: v })}>
                    {ARCH_SEVERITY_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs sm:text-sm">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel>Lower</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.spacingLower} onValueChange={(v) => v && updateOrtho(appt.id, { spacingLower: v })}>
                    {ARCH_SEVERITY_OPTIONS.map((c) => (
                      <ToggleGroupItem key={c} value={c} className="h-11 flex-1 text-xs sm:text-sm">
                        {c}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Midline deviation</FieldLegend>
              <FieldDescription>Distance off midline, in mm (left or right).</FieldDescription>
              <div className="grid grid-cols-2 gap-4 pt-2 sm:grid-cols-4">
                <Field>
                  <FieldLabel htmlFor="mid-ul">Upper \u2014 left</FieldLabel>
                  <Input id="mid-ul" inputMode="decimal" placeholder="0" value={workup.midlineUpperLeft} onChange={(e) => updateOrtho(appt.id, { midlineUpperLeft: e.target.value })} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="mid-ur">Upper \u2014 right</FieldLabel>
                  <Input id="mid-ur" inputMode="decimal" placeholder="0" value={workup.midlineUpperRight} onChange={(e) => updateOrtho(appt.id, { midlineUpperRight: e.target.value })} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="mid-ll">Lower \u2014 left</FieldLabel>
                  <Input id="mid-ll" inputMode="decimal" placeholder="0" value={workup.midlineLowerLeft} onChange={(e) => updateOrtho(appt.id, { midlineLowerLeft: e.target.value })} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="mid-lr">Lower \u2014 right</FieldLabel>
                  <Input id="mid-lr" inputMode="decimal" placeholder="0" value={workup.midlineLowerRight} onChange={(e) => updateOrtho(appt.id, { midlineLowerRight: e.target.value })} />
                </Field>
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Missing teeth</FieldLegend>
              <Odontogram
                className="pt-2"
                dentition={workup.dentition}
                allowDentitionToggle={false}
                selected={workup.missingTeeth.map(String)}
                onToggleTooth={(tooth) =>
                  updateOrtho(appt.id, {
                    missingTeeth: toggleInArray(workup.missingTeeth, Number.parseInt(tooth, 10)),
                  })
                }
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Impacted teeth</FieldLegend>
              <Odontogram
                className="pt-2"
                dentition={workup.dentition}
                allowDentitionToggle={false}
                selected={workup.impactedTeeth.map(String)}
                onToggleTooth={(tooth) =>
                  updateOrtho(appt.id, {
                    impactedTeeth: toggleInArray(workup.impactedTeeth, Number.parseInt(tooth, 10)),
                  })
                }
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Ectopic teeth</FieldLegend>
              <Odontogram
                className="pt-2"
                dentition={workup.dentition}
                allowDentitionToggle={false}
                selected={workup.ectopicTeeth.map(String)}
                onToggleTooth={(tooth) =>
                  updateOrtho(appt.id, {
                    ectopicTeeth: toggleInArray(workup.ectopicTeeth, Number.parseInt(tooth, 10)),
                  })
                }
              />
            </FieldSet>

            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch id="peg-laterals" checked={workup.pegLaterals} onCheckedChange={(v) => updateOrtho(appt.id, { pegLaterals: v })} />
                <FieldLabel htmlFor="peg-laterals" className="font-normal">
                  Peg laterals
                </FieldLabel>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="supernumerary" checked={workup.supernumerary} onCheckedChange={(v) => updateOrtho(appt.id, { supernumerary: v })} />
                <FieldLabel htmlFor="supernumerary" className="font-normal">
                  Supernumerary teeth
                </FieldLabel>
              </div>
            </div>

            <FieldSet>
              <FieldLegend>Habits noted</FieldLegend>
              <ChipGroup
                options={HABITS_OPTIONS}
                value={workup.habits}
                onToggle={(opt) => updateOrtho(appt.id, { habits: toggleInArray(workup.habits, opt) })}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Airway concerns</FieldLegend>
              <ChipGroup
                options={AIRWAY_OPTIONS}
                value={workup.airwayConcerns}
                onToggle={(opt) => updateOrtho(appt.id, { airwayConcerns: toggleInArray(workup.airwayConcerns, opt) })}
              />
              <div className="pt-3">
                <MicTextarea
                  value={workup.airwayNote}
                  onChange={(v) => updateOrtho(appt.id, { airwayNote: v })}
                  placeholder="Additional airway notes..."
                  dictationSample="Parent reports snoring most nights, no formal sleep study."
                />
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>TMJ symptoms</FieldLegend>
              <ChipGroup
                options={TMJ_OPTIONS}
                value={workup.tmjSymptoms}
                onToggle={(opt) => updateOrtho(appt.id, { tmjSymptoms: toggleInArray(workup.tmjSymptoms, opt) })}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Facial asymmetry</FieldLegend>
              <ChipGroup
                options={ASYMMETRY_FACIAL_OPTIONS}
                value={workup.asymmetryFacial}
                onToggle={(opt) => updateOrtho(appt.id, { asymmetryFacial: toggleInArray(workup.asymmetryFacial, opt) })}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Dental asymmetry</FieldLegend>
              <ChipGroup
                options={ASYMMETRY_DENTAL_OPTIONS}
                value={workup.asymmetryDental}
                onToggle={(opt) => updateOrtho(appt.id, { asymmetryDental: toggleInArray(workup.asymmetryDental, opt) })}
              />
            </FieldSet>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Profile</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={workup.profile}
                  onValueChange={(v) => v && updateOrtho(appt.id, { profile: v as typeof workup.profile })}
                >
                  <ToggleGroupItem value="Straight" className="h-11 flex-1">
                    Straight
                  </ToggleGroupItem>
                  <ToggleGroupItem value="Convex" className="h-11 flex-1">
                    Convex
                  </ToggleGroupItem>
                  <ToggleGroupItem value="Concave" className="h-11 flex-1">
                    Concave
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <div className="flex items-end gap-2 pb-1">
                <Switch id="lip-competence" checked={workup.lipCompetence} onCheckedChange={(v) => updateOrtho(appt.id, { lipCompetence: v })} />
                <FieldLabel htmlFor="lip-competence" className="font-normal">
                  Lip competence
                </FieldLabel>
              </div>
            </div>

            <Field>
              <FieldLabel htmlFor="chief-complaint">Chief complaint</FieldLabel>
              <MicTextarea
                id="chief-complaint"
                value={workup.chiefComplaint}
                onChange={(v) => updateOrtho(appt.id, { chiefComplaint: v })}
                dictationSample="Patient reports crowding on lower front teeth and wants a straighter smile."
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ortho-goals">Patient / parent goals</FieldLabel>
              <MicTextarea
                id="ortho-goals"
                value={workup.goals}
                onChange={(v) => updateOrtho(appt.id, { goals: v })}
                dictationSample="Wants a straighter smile before starting high school."
              />
            </Field>
          </CollapsibleSection>

          {/* B. Records */}
          <CollapsibleSection
            title="B. Records"
            description="Tap each record's current status."
            notAssessed={workup.notAssessed.records}
            onNotAssessedChange={(v) => updateOrtho(appt.id, { notAssessed: { ...workup.notAssessed, records: v } })}
          >
            <div className="flex flex-col gap-2">
              {ORTHO_RECORDS_LIST.map((r) => (
                <RecordStatusRow
                  key={r}
                  label={r}
                  status={workup.recordsStatus[r] ?? "needed"}
                  onChange={(status) => updateOrtho(appt.id, { recordsStatus: { ...workup.recordsStatus, [r]: status } })}
                />
              ))}
            </div>
          </CollapsibleSection>

          {/* C. Proposed treatment */}
          <CollapsibleSection
            title="C. Proposed treatment"
            notAssessed={workup.notAssessed.treatment}
            onNotAssessedChange={(v) => updateOrtho(appt.id, { notAssessed: { ...workup.notAssessed, treatment: v } })}
          >
            <Field>
              <FieldLabel>Track</FieldLabel>
              <Select value={workup.track} onValueChange={(v) => updateOrtho(appt.id, { track: v })}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="Choose a track" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {TRACK_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel>Complexity</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={workup.complexity}
                onValueChange={(v) => v && updateOrtho(appt.id, { complexity: v as typeof workup.complexity })}
              >
                <ToggleGroupItem value="Mild" className="h-11 flex-1">
                  Mild
                </ToggleGroupItem>
                <ToggleGroupItem value="Moderate" className="h-11 flex-1">
                  Moderate
                </ToggleGroupItem>
                <ToggleGroupItem value="Complex" className="h-11 flex-1">
                  Complex
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>

            <FieldSet>
              <FieldLegend>Treatment reasons</FieldLegend>
              <ChipGroup
                options={TREATMENT_REASON_OPTIONS}
                value={workup.treatmentReasons}
                onToggle={(opt) => updateOrtho(appt.id, { treatmentReasons: toggleInArray(workup.treatmentReasons, opt) })}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Braces</FieldLegend>
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Material</FieldLabel>
                  <Select value={workup.bracesMaterial} onValueChange={(v) => updateOrtho(appt.id, { bracesMaterial: v })}>
                    <SelectTrigger className="h-11">
                      <SelectValue placeholder="Choose material" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {BRACES_MATERIAL_OPTIONS.map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Arch</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.bracesArch} onValueChange={(v) => v && updateOrtho(appt.id, { bracesArch: v })}>
                    {ARCH_OPTIONS.map((o) => (
                      <ToggleGroupItem key={o} value={o} className="h-11 flex-1">
                        {o}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Aligners</FieldLegend>
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3">
                <Field>
                  <FieldLabel>Brand</FieldLabel>
                  <Select value={workup.alignerBrand} onValueChange={(v) => updateOrtho(appt.id, { alignerBrand: v })}>
                    <SelectTrigger className="h-11">
                      <SelectValue placeholder="Choose brand" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {ALIGNER_BRAND_OPTIONS.map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Arch</FieldLabel>
                  <ToggleGroup type="single" variant="outline" value={workup.alignerArch} onValueChange={(v) => v && updateOrtho(appt.id, { alignerArch: v })}>
                    {ARCH_OPTIONS.map((o) => (
                      <ToggleGroupItem key={o} value={o} className="h-11 flex-1 text-xs">
                        {o}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel htmlFor="aligner-trays">Est. trays</FieldLabel>
                  <Input
                    id="aligner-trays"
                    inputMode="numeric"
                    placeholder="e.g. 28"
                    value={workup.alignerEstTrays}
                    onChange={(e) => updateOrtho(appt.id, { alignerEstTrays: e.target.value })}
                  />
                </Field>
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Expansion</FieldLegend>
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Upper expansion</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={workup.expansionUpper}
                    onValueChange={(v) => v && updateOrtho(appt.id, { expansionUpper: v as typeof workup.expansionUpper })}
                  >
                    <ToggleGroupItem value="Y" className="h-11 flex-1">
                      Yes
                    </ToggleGroupItem>
                    <ToggleGroupItem value="N" className="h-11 flex-1">
                      No
                    </ToggleGroupItem>
                  </ToggleGroup>
                  {workup.expansionUpper === "Y" && (
                    <Input
                      className="mt-2"
                      placeholder="Appliance, e.g. RPE"
                      value={workup.expansionUpperAppliance}
                      onChange={(e) => updateOrtho(appt.id, { expansionUpperAppliance: e.target.value })}
                    />
                  )}
                </Field>
                <Field>
                  <FieldLabel>Lower expansion</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={workup.expansionLower}
                    onValueChange={(v) => v && updateOrtho(appt.id, { expansionLower: v as typeof workup.expansionLower })}
                  >
                    <ToggleGroupItem value="Y" className="h-11 flex-1">
                      Yes
                    </ToggleGroupItem>
                    <ToggleGroupItem value="N" className="h-11 flex-1">
                      No
                    </ToggleGroupItem>
                  </ToggleGroup>
                  {workup.expansionLower === "Y" && (
                    <Input
                      className="mt-2"
                      placeholder="Appliance, e.g. lip bumper"
                      value={workup.expansionLowerAppliance}
                      onChange={(e) => updateOrtho(appt.id, { expansionLowerAppliance: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Myofunctional therapy</FieldLegend>
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="myo-timing">Timing</FieldLabel>
                  <Input
                    id="myo-timing"
                    placeholder="e.g. concurrent with braces"
                    value={workup.myoTiming}
                    onChange={(e) => updateOrtho(appt.id, { myoTiming: e.target.value })}
                  />
                </Field>
                <div className="flex items-end gap-2 pb-1">
                  <Switch id="myobrace" checked={workup.myobrace} onCheckedChange={(v) => updateOrtho(appt.id, { myobrace: v })} />
                  <FieldLabel htmlFor="myobrace" className="font-normal">
                    Myobrace appliance
                  </FieldLabel>
                </div>
              </div>
              <FieldLabel className="pt-1">Targets</FieldLabel>
              <ChipGroup
                options={MYO_TARGET_OPTIONS}
                value={workup.myoTargets}
                onToggle={(opt) => updateOrtho(appt.id, { myoTargets: toggleInArray(workup.myoTargets, opt) })}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Anticipated extractions</FieldLegend>
              <Odontogram
                className="pt-2"
                dentition={workup.dentition}
                allowDentitionToggle={false}
                selected={workup.anticipatedExtractions.map(String)}
                onToggleTooth={(tooth) =>
                  updateOrtho(appt.id, {
                    anticipatedExtractions: toggleInArray(workup.anticipatedExtractions, Number.parseInt(tooth, 10)),
                  })
                }
              />
            </FieldSet>

            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch id="ipr" checked={workup.ipr} onCheckedChange={(v) => updateOrtho(appt.id, { ipr: v })} />
                <FieldLabel htmlFor="ipr" className="font-normal">
                  IPR anticipated
                </FieldLabel>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="space-maintenance"
                  checked={workup.spaceMaintenance}
                  onCheckedChange={(v) => updateOrtho(appt.id, { spaceMaintenance: v })}
                />
                <FieldLabel htmlFor="space-maintenance" className="font-normal">
                  Space maintenance
                </FieldLabel>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Treatment time band</FieldLabel>
                <Select value={workup.treatmentTimeBand} onValueChange={(v) => updateOrtho(appt.id, { treatmentTimeBand: v })}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Choose a range" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TREATMENT_TIME_BAND_OPTIONS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="treatment-months">Explicit months</FieldLabel>
                <Input
                  id="treatment-months"
                  inputMode="numeric"
                  placeholder="e.g. 18"
                  value={workup.treatmentMonths}
                  onChange={(e) => updateOrtho(appt.id, { treatmentMonths: e.target.value })}
                />
              </Field>
            </div>

            <FieldSet>
              <FieldLegend>Retention</FieldLegend>
              <div className="pt-2">
                <FieldLabel>Type</FieldLabel>
                <Select value={workup.retentionType} onValueChange={(v) => updateOrtho(appt.id, { retentionType: v })}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Choose retention type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {RETENTION_TYPE_OPTIONS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <FieldLabel className="pt-3">Pontics on retainer (if any)</FieldLabel>
              <Odontogram
                className="pt-2"
                dentition={workup.dentition}
                allowDentitionToggle={false}
                selected={workup.retentionPonticTeeth.map(String)}
                onToggleTooth={(tooth) =>
                  updateOrtho(appt.id, {
                    retentionPonticTeeth: toggleInArray(workup.retentionPonticTeeth, Number.parseInt(tooth, 10)),
                  })
                }
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend>Additional work after ortho</FieldLegend>
              <FieldDescription>Checking an item adds it to Findings as a Holding item, tagged post-ortho.</FieldDescription>
              <div className="flex flex-wrap gap-2 pt-2">
                {ADDITIONAL_WORK_OPTIONS.map((opt) => {
                  const active = workup.additionalWorkAfterOrtho.includes(opt)
                  return (
                    <Button
                      key={opt}
                      type="button"
                      variant={active ? "default" : "outline"}
                      size="lg"
                      className="h-11 gap-1.5 rounded-full"
                      onClick={() => toggleAdditionalWork(opt)}
                    >
                      {active && <CheckIcon className="size-3.5" />}
                      {opt}
                    </Button>
                  )
                })}
              </div>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Referral</FieldLegend>
              <ToggleGroup
                type="single"
                variant="outline"
                value={workup.referral}
                onValueChange={(v) => v && updateOrtho(appt.id, { referral: v as typeof workup.referral })}
                className="pt-2"
              >
                {REFERRAL_OPTIONS.map((o) => (
                  <ToggleGroupItem key={o.id} value={o.id} className="h-11 flex-1">
                    {o.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {workup.referral === "Refer out" && (
                <Input
                  className="mt-2"
                  placeholder="Referral name"
                  value={workup.referralName}
                  onChange={(e) => updateOrtho(appt.id, { referralName: e.target.value })}
                />
              )}
            </FieldSet>
          </CollapsibleSection>

          {/* D. Handoff */}
          <CollapsibleSection
            title="D. Handoff"
            notAssessed={workup.notAssessed.handoff}
            onNotAssessedChange={(v) => updateOrtho(appt.id, { notAssessed: { ...workup.notAssessed, handoff: v } })}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Appointment sequence</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={workup.handoff.apptSequence}
                  onValueChange={(v) =>
                    v && updateOrtho(appt.id, { handoff: { ...workup.handoff, apptSequence: v as typeof workup.handoff.apptSequence } })
                  }
                >
                  <ToggleGroupItem value="1st" className="h-11 flex-1">
                    1st
                  </ToggleGroupItem>
                  <ToggleGroupItem value="2nd" className="h-11 flex-1">
                    2nd
                  </ToggleGroupItem>
                  <ToggleGroupItem value="3rd" className="h-11 flex-1">
                    3rd
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel>Consult location</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={workup.handoff.consultLocation}
                  onValueChange={(v) =>
                    v && updateOrtho(appt.id, { handoff: { ...workup.handoff, consultLocation: v as typeof workup.handoff.consultLocation } })
                  }
                >
                  <ToggleGroupItem value="Phone" className="h-11 flex-1">
                    Phone
                  </ToggleGroupItem>
                  <ToggleGroupItem value="In-office" className="h-11 flex-1">
                    In-office
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </div>

            <FieldSet>
              <FieldLegend>Visit type</FieldLegend>
              <ChipGroup
                options={HANDOFF_VISIT_TYPE_OPTIONS}
                value={workup.handoff.visitTypes}
                onToggle={(opt) =>
                  updateOrtho(appt.id, { handoff: { ...workup.handoff, visitTypes: toggleInArray(workup.handoff.visitTypes, opt) } })
                }
              />
            </FieldSet>

            <Field>
              <FieldLabel>Presenter</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={workup.handoff.presenter}
                onValueChange={(v) => v && updateOrtho(appt.id, { handoff: { ...workup.handoff, presenter: v as typeof workup.handoff.presenter } })}
              >
                <ToggleGroupItem value="TC" className="h-11 flex-1">
                  Treatment coordinator
                </ToggleGroupItem>
                <ToggleGroupItem value="Doctor" className="h-11 flex-1">
                  Doctor
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>

            <Field>
              <FieldLabel>Insurance ortho benefit</FieldLabel>
              <p className="flex min-h-11 items-center rounded-md border border-border bg-secondary/30 px-3 text-sm text-foreground">
                {odSnapshot?.orthoBenefit ?? "Not on file \u2014 verify with front desk"}
              </p>
            </Field>

            <Field>
              <FieldLabel>Estimated fee band</FieldLabel>
              <Select
                value={workup.handoff.feeBand}
                onValueChange={(v) => updateOrtho(appt.id, { handoff: { ...workup.handoff, feeBand: v } })}
              >
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="Not estimated yet" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {FEE_BAND_OPTIONS.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="notes-for-tc">Notes for TC</FieldLabel>
              <MicTextarea
                id="notes-for-tc"
                value={workup.handoff.notesForTc}
                onChange={(v) => updateOrtho(appt.id, { handoff: { ...workup.handoff, notesForTc: v } })}
                dictationSample="Parent wants to start after summer break, flexible on financing."
              />
            </Field>
          </CollapsibleSection>

          <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t border-border bg-card px-6 py-4">
            <p className="text-sm text-muted-foreground">{staged ? "Ortho case sent to TC." : "Send this workup to the treatment coordinator."}</p>
            <Button size="lg" className="h-11" onClick={handleSendToTc}>
              {staged ? "Update TC case" : "Send to TC as Ortho case"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
