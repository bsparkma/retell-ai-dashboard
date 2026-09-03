import type { NoteTemplate } from "./types"

export const noteTemplates: NoteTemplate[] = [
  {
    id: "tpl-prophy-adult",
    name: "Prophy Adult",
    fields: [
      { id: "procedures", label: "Procedures completed", type: "text", autofillSource: "Router", defaultValue: "Adult prophylaxis" },
      { id: "tissue", label: "Tissue / gingival status", type: "select", options: ["Healthy", "Mild inflammation", "Generalized inflammation"], defaultValue: "Healthy" },
      { id: "ohi", label: "OHI given", type: "textarea", defaultValue: "Reviewed brushing and flossing technique." },
      { id: "findings", label: "Findings / concerns", type: "textarea", autofillSource: "Findings" },
      { id: "nextVisit", label: "Next visit plan", type: "text", autofillSource: "Router" },
    ],
    narrativePattern:
      "Patient presented for {{procedures}}. Gingival tissue: {{tissue}}. {{ohi}} Findings: {{findings}}. Next visit: {{nextVisit}}.",
  },
  {
    id: "tpl-prophy-child",
    name: "Prophy Child",
    fields: [
      { id: "procedures", label: "Procedures completed", type: "text", autofillSource: "Router", defaultValue: "Child prophylaxis, fluoride" },
      { id: "behavior", label: "Behavior / cooperation", type: "select", options: ["Cooperative", "Fair", "Required extra time"], defaultValue: "Cooperative" },
      { id: "fluoride", label: "Fluoride applied", type: "select", options: ["Yes", "No", "Declined by guardian"], defaultValue: "Yes" },
      { id: "findings", label: "Findings / concerns", type: "textarea", autofillSource: "Findings" },
      { id: "nextVisit", label: "Next visit plan", type: "text", autofillSource: "Router" },
    ],
    narrativePattern:
      "Patient presented for {{procedures}}. Behavior: {{behavior}}. Fluoride: {{fluoride}}. Findings: {{findings}}. Next visit: {{nextVisit}}.",
  },
  {
    id: "tpl-srp",
    name: "SRP",
    fields: [
      { id: "quads", label: "Quadrants treated", type: "text", autofillSource: "Router", defaultValue: "UR, UL" },
      { id: "anesthesia", label: "Anesthesia", type: "select", options: ["None", "Topical", "Local — 2% lidocaine 1:100k"], defaultValue: "Local — 2% lidocaine 1:100k" },
      { id: "perioSummary", label: "Perio summary", type: "textarea", autofillSource: "Perio" },
      { id: "tolerance", label: "Patient tolerance", type: "select", options: ["Tolerated well", "Mild sensitivity", "Required breaks"], defaultValue: "Tolerated well" },
      { id: "nextVisit", label: "Next visit plan", type: "text", autofillSource: "Router" },
    ],
    narrativePattern:
      "SRP performed on {{quads}}. Anesthesia: {{anesthesia}}. Perio summary: {{perioSummary}}. Tolerance: {{tolerance}}. Next visit: {{nextVisit}}.",
  },
  {
    id: "tpl-perio-maint",
    name: "Perio Maintenance",
    fields: [
      { id: "perioSummary", label: "Perio summary", type: "textarea", autofillSource: "Perio" },
      { id: "irrigation", label: "Irrigation / adjuncts", type: "text", defaultValue: "Chlorhexidine irrigation, all quads" },
      { id: "homecare", label: "Home care reinforcement", type: "textarea", defaultValue: "Reinforced interdental cleaning and rinse compliance." },
      { id: "nextVisit", label: "Next visit plan", type: "text", autofillSource: "Router" },
    ],
    narrativePattern:
      "Perio maintenance completed. {{perioSummary}} Adjuncts: {{irrigation}}. {{homecare}} Next visit: {{nextVisit}}.",
  },
  {
    id: "tpl-ortho-adj",
    name: "Ortho Adjustment",
    fields: [
      { id: "appliance", label: "Appliance", type: "text", autofillSource: "Ortho", defaultValue: "Aligners" },
      { id: "compliance", label: "Compliance noted", type: "text", autofillSource: "Ortho" },
      { id: "issues", label: "Issues addressed", type: "textarea", autofillSource: "Ortho" },
      { id: "nextVisit", label: "Next visit plan", type: "text", autofillSource: "Ortho" },
    ],
    narrativePattern:
      "Ortho adjustment visit. Appliance: {{appliance}}. Compliance: {{compliance}}. Issues addressed: {{issues}}. Next visit: {{nextVisit}}.",
  },
  {
    id: "tpl-limited-hygiene",
    name: "Limited Hygiene",
    fields: [
      { id: "reason", label: "Reason for limited visit", type: "text", defaultValue: "Localized scaling, one quadrant" },
      { id: "procedures", label: "Procedures completed", type: "textarea", autofillSource: "Router" },
      { id: "nextVisit", label: "Next visit plan", type: "text", autofillSource: "Router" },
    ],
    narrativePattern: "Limited hygiene visit: {{reason}}. Procedures: {{procedures}}. Next visit: {{nextVisit}}.",
  },
  {
    id: "tpl-custom",
    name: "Custom",
    fields: [{ id: "freeText", label: "Note text", type: "textarea" }],
    narrativePattern: "{{freeText}}",
  },
]

export function getTemplate(id: string): NoteTemplate | undefined {
  return noteTemplates.find((t) => t.id === id)
}
