import { create } from "zustand"
import { blankChart } from "@/mock/perio"
import type { ToothChart, ToothSurface, TreatmentItem } from "@/mock/types"
import { seedTreatmentItems } from "@/mock/treatment-items"

export type YesNoBlank = "" | "Y" | "N"

export interface RouterPreVisitState {
  nameContactUpdated: boolean
  insuranceVerified: boolean
  balanceToCollect: string
  premedTaken: "" | "Y" | "N" | "N/A"
  medicalClearanceDoctor: string
  healthChangesNote: string
}

export interface RouterRecordsTodayState {
  photosCount: number
  paTeeth: number[]
  bw: boolean
  pano: boolean
  ceph: boolean
  scan: boolean
  perioChartScope: "full" | "partial" | "none"
  fluoride: boolean
}

export interface RouterPerioClassificationState {
  stage: "" | "Health" | "Gingivitis" | "Stage I" | "Stage II" | "Stage III" | "Stage IV"
  grade: "" | "A" | "B" | "C"
}

export interface RouterAdminState {
  preAuthItems: string
  referral: string
  rx: string
  familyRecare: string
  roomSetup: string
  assistant: string
}

export type RecordStatus = "taken today" | "on file" | "needed"

export interface RouterState {
  doneToday: string[] // chip ids, e.g. "prophy", "srp-ur"
  xrayTypes: string[]
  sealantTeeth: number[]
  freeTextDoneToday: string
  examStatus: "Needed today" | "Completed" | "Not due"
  examFindingsReceived: boolean
  doctorPicker: string
  nextInterval: "3" | "4" | "6" | "12"
  nextType: string
  nextLength: "30" | "45" | "60" | "90"
  scheduleWithDoctor: boolean
  frontDeskNotes: string
  treatmentToSchedule: string
  financialNotes: string
  productsDispensed: string[]
  signatureName: string
  // (a) From Open Dental is read-only, pulled live from od-snapshot.ts — nothing stored here.
  // (b) Pre-visit checks
  preVisit: RouterPreVisitState
  // (c) Visit type + last check-up
  visitType: "RA" | "NP" | "Limited" | "Emergency"
  lastCheckup: "" | "On time" | "Overdue" | "Unknown"
  // (d) Records today
  recordsToday: RouterRecordsTodayState
  // (f) Perio classification
  perioClassification: RouterPerioClassificationState
  // (h) Patient concerns / hygiene findings
  patientConcerns: string
  hygieneFindings: string
  // (i) Next hygiene visit — hard check
  recareScheduled: YesNoBlank
  // (j) Next restorative visit — hard check
  txEnteredInOD: YesNoBlank
  // (k) Admin
  admin: RouterAdminState
  // (l) Records needed for planned treatment
  recordsNeededStatus: Record<string, RecordStatus>
}

export interface OrthoHandoffState {
  apptSequence: "1st" | "2nd" | "3rd" | ""
  visitTypes: string[]
  consultLocation: "" | "Phone" | "In-office"
  presenter: "" | "TC" | "Doctor"
  feeBand: string
  notesForTc: string
}

export interface OrthoWorkupState {
  // A. Clinical findings
  chiefComplaint: string
  goals: string
  growing: "" | "Growing" | "Non-growing"
  mixedDentition: boolean
  dentition: "adult" | "primary"
  molarClassLeft: string
  molarClassRight: string
  canineClassLeft: string
  canineClassRight: string
  overjet: string
  overbite: string
  openBite: boolean
  crossbite: string[]
  crowdingUpper: string
  crowdingLower: string
  spacingUpper: string
  spacingLower: string
  midlineUpperLeft: string
  midlineUpperRight: string
  midlineLowerLeft: string
  midlineLowerRight: string
  missingTeeth: number[]
  impactedTeeth: number[]
  ectopicTeeth: number[]
  pegLaterals: boolean
  supernumerary: boolean
  habits: string[]
  airwayConcerns: string[]
  airwayNote: string
  tmjSymptoms: string[]
  asymmetryFacial: string[]
  asymmetryDental: string[]
  profile: "" | "Straight" | "Convex" | "Concave"
  lipCompetence: boolean
  // B. Records
  recordsStatus: Record<string, RecordStatus>
  // C. Proposed treatment
  track: string
  complexity: "" | "Mild" | "Moderate" | "Complex"
  treatmentReasons: string[]
  bracesMaterial: string
  bracesArch: string
  alignerBrand: string
  alignerArch: string
  alignerEstTrays: string
  expansionUpper: "" | "Y" | "N"
  expansionUpperAppliance: string
  expansionLower: "" | "Y" | "N"
  expansionLowerAppliance: string
  myoTiming: string
  myoTargets: string[]
  myobrace: boolean
  anticipatedExtractions: number[]
  ipr: boolean
  spaceMaintenance: boolean
  treatmentTimeBand: string
  treatmentMonths: string
  retentionType: string
  retentionPonticTeeth: number[]
  additionalWorkAfterOrtho: string[]
  referral: "" | "In-house" | "Refer out" | "Joint"
  referralName: string
  // D. Handoff
  handoff: OrthoHandoffState
  // Section-level "not assessed" flags
  notAssessed: { clinical: boolean; records: boolean; treatment: boolean; handoff: boolean }
  recommendation: string
  notes: string
}

export interface OrthoAdjState {
  applianceType: string
  trayNumber: string
  trayTotal: string
  complianceHours: number
  issues: string[]
  elastics: boolean
  elasticsPattern: string
  wireChange: string
  ohGrade: "" | "Good" | "Fair" | "Poor"
  whiteSpotTeeth: number[]
  monthsRemaining: string
  debondMonth: string
  nextTrayCount: string
  nextInterval: string
  notes: string
}

export interface FindingsState {
  patientName: string
  age: string
  phone: string
  email: string
  diagnosingProvider: string
  hygienist: string
  category: string
  urgency: string
  caseType: string
  operatory: string
  visitDate: string
  providerSeen: string
  chiefConcern: string
  perioStatus: string
  recallType: string
  radiographsTaken: string[]
  teethOfConcern: number[]
  suspectedTreatment: string
  hygienistRecommendation: string
  insuranceNoted: string
  patientInterest: string
}

export interface NotesState {
  templateId: string
  fieldValues: Record<string, string>
  providerForNote: string
  signatureName: string
  signatureCredential: string
  signatureLicense: string
}

interface VisitData {
  router: RouterState
  perioTeeth: ToothChart[]
  perioMissing: number[]
  ortho: OrthoWorkupState
  orthoAdj: OrthoAdjState
  findings: FindingsState
  notes: NotesState
  treatmentItems: TreatmentItem[]
}

function defaultRouter(): RouterState {
  return {
    doneToday: [],
    xrayTypes: [],
    sealantTeeth: [],
    freeTextDoneToday: "",
    examStatus: "Not due",
    examFindingsReceived: false,
    doctorPicker: "",
    nextInterval: "6",
    nextType: "Prophy",
    nextLength: "60",
    scheduleWithDoctor: false,
    frontDeskNotes: "",
    treatmentToSchedule: "",
    financialNotes: "",
    productsDispensed: [],
    signatureName: "",
    preVisit: {
      nameContactUpdated: false,
      insuranceVerified: false,
      balanceToCollect: "",
      premedTaken: "",
      medicalClearanceDoctor: "",
      healthChangesNote: "",
    },
    visitType: "RA",
    lastCheckup: "",
    recordsToday: {
      photosCount: 0,
      paTeeth: [],
      bw: false,
      pano: false,
      ceph: false,
      scan: false,
      perioChartScope: "none",
      fluoride: false,
    },
    perioClassification: { stage: "", grade: "" },
    patientConcerns: "",
    hygieneFindings: "",
    recareScheduled: "",
    txEnteredInOD: "",
    admin: {
      preAuthItems: "",
      referral: "",
      rx: "",
      familyRecare: "",
      roomSetup: "",
      assistant: "",
    },
    recordsNeededStatus: {},
  }
}

function defaultOrthoWorkup(): OrthoWorkupState {
  return {
    chiefComplaint: "",
    goals: "",
    growing: "",
    mixedDentition: false,
    dentition: "adult",
    molarClassLeft: "I",
    molarClassRight: "I",
    canineClassLeft: "I",
    canineClassRight: "I",
    overjet: "",
    overbite: "",
    openBite: false,
    crossbite: [],
    crowdingUpper: "None",
    crowdingLower: "None",
    spacingUpper: "None",
    spacingLower: "None",
    midlineUpperLeft: "",
    midlineUpperRight: "",
    midlineLowerLeft: "",
    midlineLowerRight: "",
    missingTeeth: [],
    impactedTeeth: [],
    ectopicTeeth: [],
    pegLaterals: false,
    supernumerary: false,
    habits: [],
    airwayConcerns: [],
    airwayNote: "",
    tmjSymptoms: [],
    asymmetryFacial: [],
    asymmetryDental: [],
    profile: "",
    lipCompetence: true,
    recordsStatus: {},
    track: "",
    complexity: "",
    treatmentReasons: [],
    bracesMaterial: "",
    bracesArch: "",
    alignerBrand: "",
    alignerArch: "",
    alignerEstTrays: "",
    expansionUpper: "",
    expansionUpperAppliance: "",
    expansionLower: "",
    expansionLowerAppliance: "",
    myoTiming: "",
    myoTargets: [],
    myobrace: false,
    anticipatedExtractions: [],
    ipr: false,
    spaceMaintenance: false,
    treatmentTimeBand: "",
    treatmentMonths: "",
    retentionType: "",
    retentionPonticTeeth: [],
    additionalWorkAfterOrtho: [],
    referral: "",
    referralName: "",
    handoff: {
      apptSequence: "",
      visitTypes: [],
      consultLocation: "",
      presenter: "",
      feeBand: "",
      notesForTc: "",
    },
    notAssessed: { clinical: false, records: false, treatment: false, handoff: false },
    recommendation: "",
    notes: "",
  }
}

function defaultOrthoAdj(): OrthoAdjState {
  return {
    applianceType: "Aligners",
    trayNumber: "",
    trayTotal: "",
    complianceHours: 18,
    issues: [],
    elastics: false,
    elasticsPattern: "",
    wireChange: "",
    ohGrade: "",
    whiteSpotTeeth: [],
    monthsRemaining: "",
    debondMonth: "",
    nextTrayCount: "",
    nextInterval: "4 wk",
    notes: "",
  }
}

function defaultFindings(): FindingsState {
  return {
    patientName: "",
    age: "",
    phone: "",
    email: "",
    diagnosingProvider: "",
    hygienist: "",
    category: "Restorative",
    urgency: "Routine",
    caseType: "",
    operatory: "",
    visitDate: "",
    providerSeen: "",
    chiefConcern: "",
    perioStatus: "Healthy",
    recallType: "",
    radiographsTaken: [],
    teethOfConcern: [],
    suspectedTreatment: "",
    hygienistRecommendation: "",
    insuranceNoted: "",
    patientInterest: "Curious",
  }
}

function defaultNotes(): NotesState {
  return {
    templateId: "",
    fieldValues: {},
    providerForNote: "",
    signatureName: "",
    signatureCredential: "RDH",
    signatureLicense: "",
  }
}

function defaultVisitData(apptId?: string): VisitData {
  return {
    router: defaultRouter(),
    perioTeeth: blankChart(),
    perioMissing: [],
    ortho: defaultOrthoWorkup(),
    orthoAdj: defaultOrthoAdj(),
    findings: defaultFindings(),
    notes: defaultNotes(),
    treatmentItems: apptId ? (seedTreatmentItems[apptId] ?? []) : [],
  }
}

interface VisitStoreState {
  data: Record<string, VisitData>
  getVisit: (apptId: string) => VisitData
  updateRouter: (apptId: string, patch: Partial<RouterState>) => void
  updatePerioTeeth: (apptId: string, teeth: ToothChart[]) => void
  updateSite: (apptId: string, toothNumber: number, surface: ToothSurface, patch: Partial<ToothChart["sites"][ToothSurface]>) => void
  setToothMissing: (apptId: string, toothNumber: number, missing: boolean) => void
  updateOrtho: (apptId: string, patch: Partial<OrthoWorkupState>) => void
  updateOrthoAdj: (apptId: string, patch: Partial<OrthoAdjState>) => void
  updateFindings: (apptId: string, patch: Partial<FindingsState>) => void
  updateNotes: (apptId: string, patch: Partial<NotesState>) => void
  addTreatmentItem: (apptId: string, item: Omit<TreatmentItem, "id" | "createdAt" | "createdBy"> & { createdBy?: string }) => void
  updateTreatmentItem: (apptId: string, itemId: string, patch: Partial<TreatmentItem>) => void
  removeTreatmentItem: (apptId: string, itemId: string) => void
}

export const useVisitStore = create<VisitStoreState>((set, get) => ({
  data: {},

  getVisit: (apptId) => {
    const existing = get().data[apptId]
    if (existing) return existing
    const fresh = defaultVisitData(apptId)
    set((s) => ({ data: { ...s.data, [apptId]: fresh } }))
    return fresh
  },

  updateRouter: (apptId, patch) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      return { data: { ...s.data, [apptId]: { ...visit, router: { ...visit.router, ...patch } } } }
    }),

  updatePerioTeeth: (apptId, teeth) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      return { data: { ...s.data, [apptId]: { ...visit, perioTeeth: teeth } } }
    }),

  updateSite: (apptId, toothNumber, surface, patch) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      const teeth = visit.perioTeeth.map((tooth) => {
        if (tooth.toothNumber !== toothNumber) return tooth
        return {
          ...tooth,
          sites: {
            ...tooth.sites,
            [surface]: { ...tooth.sites[surface], ...patch },
          },
        }
      })
      return { data: { ...s.data, [apptId]: { ...visit, perioTeeth: teeth } } }
    }),

  setToothMissing: (apptId, toothNumber, missing) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      const teeth = visit.perioTeeth.map((tooth) => (tooth.toothNumber === toothNumber ? { ...tooth, missing } : tooth))
      return { data: { ...s.data, [apptId]: { ...visit, perioTeeth: teeth } } }
    }),

  updateOrtho: (apptId, patch) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      return { data: { ...s.data, [apptId]: { ...visit, ortho: { ...visit.ortho, ...patch } } } }
    }),

  updateOrthoAdj: (apptId, patch) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      return { data: { ...s.data, [apptId]: { ...visit, orthoAdj: { ...visit.orthoAdj, ...patch } } } }
    }),

  updateFindings: (apptId, patch) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      return { data: { ...s.data, [apptId]: { ...visit, findings: { ...visit.findings, ...patch } } } }
    }),

  updateNotes: (apptId, patch) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData()
      return { data: { ...s.data, [apptId]: { ...visit, notes: { ...visit.notes, ...patch } } } }
    }),

  addTreatmentItem: (apptId, item) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData(apptId)
      const newItem: TreatmentItem = {
        id: `ti-${apptId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        createdAt: new Date().toISOString(),
        createdBy: item.createdBy ?? "Hygienist",
        ...item,
      }
      return { data: { ...s.data, [apptId]: { ...visit, treatmentItems: [...visit.treatmentItems, newItem] } } }
    }),

  updateTreatmentItem: (apptId, itemId, patch) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData(apptId)
      const treatmentItems = visit.treatmentItems.map((t) => (t.id === itemId ? { ...t, ...patch } : t))
      return { data: { ...s.data, [apptId]: { ...visit, treatmentItems } } }
    }),

  removeTreatmentItem: (apptId, itemId) =>
    set((s) => {
      const visit = s.data[apptId] ?? defaultVisitData(apptId)
      return { data: { ...s.data, [apptId]: { ...visit, treatmentItems: visit.treatmentItems.filter((t) => t.id !== itemId) } } }
    }),
}))
