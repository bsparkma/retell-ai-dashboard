import { useMemo, useState } from "react"
import { SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useVisitStore } from "@/store/visit-store"
import { useStagedWritesStore } from "@/store/staged-writes-store"
import { noteTemplates, getTemplate } from "@/mock/templates"
import { chartSummary } from "@/features/visit/perio/perio-utils"
import type { Appointment, Patient } from "@/mock/types"

interface NotesTabProps {
  appt: Appointment
  patient: Patient
}

export function NotesTab({ appt, patient }: NotesTabProps) {
  const visit = useVisitStore((s) => s.getVisit(appt.id))
  const updateNotes = useVisitStore((s) => s.updateNotes)
  const stage = useStagedWritesStore((s) => s.stage)
  const [staged, setStaged] = useState(false)

  const template = getTemplate(visit.notes.templateId)

  function autofillValue(source: "Router" | "Perio" | "Findings" | "Ortho", fieldId: string, defaultValue?: string) {
    if (source === "Router") {
      if (fieldId === "quads") return visit.router.doneToday.filter((d) => d.startsWith("srp")).join(", ").toUpperCase() || defaultValue || ""
      if (fieldId === "procedures") return visit.router.doneToday.join(", ") || defaultValue || ""
      if (fieldId === "nextVisit") return `${visit.router.nextType}, ${visit.router.nextInterval}mo`
      return defaultValue ?? ""
    }
    if (source === "Ortho") {
      if (fieldId === "compliance") return `${visit.orthoAdj.complianceHours}h/day reported`
      if (fieldId === "issues") return visit.orthoAdj.issues.join(", ")
      if (fieldId === "appliance")
        return `${visit.orthoAdj.applianceType}${visit.orthoAdj.trayNumber ? ` (tray ${visit.orthoAdj.trayNumber}${visit.orthoAdj.trayTotal ? ` of ${visit.orthoAdj.trayTotal}` : ""})` : ""}`
      if (fieldId === "nextVisit") return `${visit.orthoAdj.nextTrayCount ? `trays ${visit.orthoAdj.nextTrayCount}, ` : ""}${visit.orthoAdj.nextInterval}`
      return defaultValue ?? ""
    }
    if (source === "Perio") {
      const summary = chartSummary(visit.perioTeeth)
      return `${summary.bopPercent}% BOP, ${summary.deepSites} sites ≥5mm, ${summary.plaqueSites} plaque sites.`
    }
    if (source === "Findings") {
      return visit.findings.chiefConcern || defaultValue || ""
    }
    return defaultValue ?? ""
  }

  function handleSelectTemplate(id: string) {
    const tpl = getTemplate(id)
    if (!tpl) return
    const fieldValues: Record<string, string> = {}
    for (const field of tpl.fields) {
      fieldValues[field.id] = field.autofillSource
        ? autofillValue(field.autofillSource, field.id, field.defaultValue)
        : field.defaultValue ?? ""
    }
    updateNotes(appt.id, { templateId: id, fieldValues })
  }

  const narrative = useMemo(() => {
    if (!template) return ""
    let text = template.narrativePattern
    for (const field of template.fields) {
      text = text.replaceAll(`{{${field.id}}}`, visit.notes.fieldValues[field.id] ?? "")
    }
    return text
  }, [template, visit.notes.fieldValues])

  function handleStage() {
    stage({
      apptId: appt.id,
      kind: "note",
      title: `Clinical note — ${template?.name ?? "Untitled"}`,
      summary: `Signed by ${visit.notes.signatureName || "unsigned"}`,
      preview: narrative.split(". ").map((s) => s.trim()).filter(Boolean),
    })
    setStaged(true)
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <FieldGroup>
        <Field>
          <FieldLabel>Note template</FieldLabel>
          <Select value={visit.notes.templateId} onValueChange={handleSelectTemplate}>
            <SelectTrigger className="h-11">
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {noteTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>

      {template && (
        <>
          <FieldGroup>
            {template.fields.map((field) => (
              <Field key={field.id}>
                <FieldLabel htmlFor={field.id} className="flex items-center gap-1.5">
                  {field.label}
                  {field.autofillSource && (
                    <span className="inline-flex items-center gap-1 text-xs font-normal text-primary">
                      <SparklesIcon className="size-3" />
                      from {field.autofillSource}
                    </span>
                  )}
                </FieldLabel>
                {field.type === "textarea" ? (
                  <Textarea
                    id={field.id}
                    value={visit.notes.fieldValues[field.id] ?? ""}
                    onChange={(e) => updateNotes(appt.id, { fieldValues: { ...visit.notes.fieldValues, [field.id]: e.target.value } })}
                  />
                ) : field.type === "select" ? (
                  <Select
                    value={visit.notes.fieldValues[field.id] ?? ""}
                    onValueChange={(v) => updateNotes(appt.id, { fieldValues: { ...visit.notes.fieldValues, [field.id]: v } })}
                  >
                    <SelectTrigger id={field.id} className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(field.options ?? []).map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={field.id}
                    value={visit.notes.fieldValues[field.id] ?? ""}
                    onChange={(e) => updateNotes(appt.id, { fieldValues: { ...visit.notes.fieldValues, [field.id]: e.target.value } })}
                  />
                )}
              </Field>
            ))}
          </FieldGroup>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Narrative preview</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-foreground">{narrative}</p>
            </CardContent>
          </Card>

          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="sig-name">Signed by</FieldLabel>
                <Input
                  id="sig-name"
                  placeholder={patient.orthoPatient ? "Dr. Jane Doe" : "Your name"}
                  value={visit.notes.signatureName}
                  onChange={(e) => updateNotes(appt.id, { signatureName: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sig-credential">Credential</FieldLabel>
                <Input
                  id="sig-credential"
                  value={visit.notes.signatureCredential}
                  onChange={(e) => updateNotes(appt.id, { signatureCredential: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sig-license">License #</FieldLabel>
                <Input
                  id="sig-license"
                  value={visit.notes.signatureLicense}
                  onChange={(e) => updateNotes(appt.id, { signatureLicense: e.target.value })}
                />
              </Field>
            </div>
          </FieldGroup>

          <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t border-border bg-card px-6 py-4">
            <p className="text-sm text-muted-foreground">{staged ? "Note staged." : "Stage this clinical note."}</p>
            <Button size="lg" className="h-11" onClick={handleStage} disabled={!visit.notes.signatureName}>
              {staged ? "Update staged note" : "Stage clinical note"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
