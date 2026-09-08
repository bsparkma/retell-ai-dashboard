// Read-only fields the front desk / practice management system ("Open Dental")
// would already have on file before the hygienist ever opens the visit.
// The hygiene workflow never writes to these fields — they're for context only.

export interface OdSnapshot {
  apptId: string
  /** Procedures the front office already scheduled for today (pre-checks "Done today"). */
  scheduledProcedures: string[]
  recallDue: string
  medicalAlerts: string[]
  insuranceRemaining: string
  pendingTx: string[]
  familyMembersDue: string[]
  /** Read-only, shown in the Ortho Handoff section. */
  orthoBenefit?: string
}

export const odSnapshots: Record<string, OdSnapshot> = {
  "apt-rol-1": {
    apptId: "apt-rol-1",
    scheduledProcedures: ["Prophy", "BW x4", "Exam"],
    recallDue: "Recall due this month",
    medicalAlerts: [],
    insuranceRemaining: "$620 remaining (Delta PPO)",
    pendingTx: ["#30 watch \u2013 small occlusal lesion"],
    familyMembersDue: ["Spouse due next month"],
  },
  "apt-rol-2": {
    apptId: "apt-rol-2",
    scheduledProcedures: ["Prophy", "Fluoride"],
    recallDue: "On 6-month recall",
    medicalAlerts: [],
    insuranceRemaining: "$1,000 remaining (Cigna)",
    pendingTx: [],
    familyMembersDue: [],
  },
  "apt-rol-3": {
    apptId: "apt-rol-3",
    scheduledProcedures: ["SRP UR/UL", "Perio chart"],
    recallDue: "3-month perio recall",
    medicalAlerts: ["Type 2 diabetes"],
    insuranceRemaining: "$140 remaining (MetLife)",
    pendingTx: ["#3 crown pending \u2013 patient deferred", "#19 watch \u2013 recurrent decay"],
    familyMembersDue: [],
  },
  "apt-rol-4": {
    apptId: "apt-rol-4",
    scheduledProcedures: ["Perio maintenance"],
    recallDue: "3-month perio recall",
    medicalAlerts: [],
    insuranceRemaining: "$300 remaining (Guardian)",
    pendingTx: [],
    familyMembersDue: ["Child due for exam"],
  },
  "apt-rol-5": {
    apptId: "apt-rol-5",
    scheduledProcedures: ["New patient exam", "FMX", "Perio chart"],
    recallDue: "New patient \u2013 no history on file",
    medicalAlerts: ["Latex allergy"],
    insuranceRemaining: "Benefits not yet verified",
    pendingTx: [],
    familyMembersDue: [],
  },
  "apt-rol-6": {
    apptId: "apt-rol-6",
    scheduledProcedures: ["Ortho adjustment"],
    recallDue: "N/A \u2013 active ortho",
    medicalAlerts: [],
    insuranceRemaining: "Ortho lifetime max: $850 remaining",
    pendingTx: [],
    familyMembersDue: [],
    orthoBenefit: "$850 lifetime ortho benefit remaining, 24 months paid",
  },
  "apt-rol-7": {
    apptId: "apt-rol-7",
    scheduledProcedures: ["Prophy", "BW x2"],
    recallDue: "On 6-month recall",
    medicalAlerts: [],
    insuranceRemaining: "$450 remaining (Aetna)",
    pendingTx: ["#8 watch \u2013 esthetic concern, patient declined"],
    familyMembersDue: [],
  },
  "apt-rol-8": {
    apptId: "apt-rol-8",
    scheduledProcedures: ["Prophy", "Fluoride", "BW x2"],
    recallDue: "On 6-month recall",
    medicalAlerts: [],
    insuranceRemaining: "$1,000 remaining (Delta PPO)",
    pendingTx: [],
    familyMembersDue: ["Sibling due next week"],
  },
  "apt-val-1": {
    apptId: "apt-val-1",
    scheduledProcedures: ["SRP LR/LL", "Perio chart"],
    recallDue: "3-month perio recall",
    medicalAlerts: ["Anticoagulant \u2013 Eliquis"],
    insuranceRemaining: "$210 remaining (Cigna)",
    pendingTx: ["#14 crown pending \u2013 scheduling"],
    familyMembersDue: [],
  },
  "apt-val-2": {
    apptId: "apt-val-2",
    scheduledProcedures: ["Perio maintenance"],
    recallDue: "3-month perio recall",
    medicalAlerts: [],
    insuranceRemaining: "$500 remaining (Humana)",
    pendingTx: [],
    familyMembersDue: [],
  },
  "apt-val-3": {
    apptId: "apt-val-3",
    scheduledProcedures: ["Ortho adjustment"],
    recallDue: "N/A \u2013 active ortho",
    medicalAlerts: [],
    insuranceRemaining: "Ortho lifetime max: $1,400 remaining",
    pendingTx: [],
    familyMembersDue: [],
    orthoBenefit: "$1,400 lifetime ortho benefit remaining, 4 months paid",
  },
  "apt-val-4": {
    apptId: "apt-val-4",
    scheduledProcedures: ["Prophy", "BW x4", "Exam"],
    recallDue: "On 6-month recall",
    medicalAlerts: [],
    insuranceRemaining: "$680 remaining (MetLife)",
    pendingTx: [],
    familyMembersDue: ["Spouse overdue for recall"],
  },
  "apt-val-5": {
    apptId: "apt-val-5",
    scheduledProcedures: ["New patient exam", "FMX", "Perio chart"],
    recallDue: "New patient \u2013 no history on file",
    medicalAlerts: [],
    insuranceRemaining: "Benefits not yet verified",
    pendingTx: [],
    familyMembersDue: [],
  },
  "apt-val-6": {
    apptId: "apt-val-6",
    scheduledProcedures: ["Ortho adjustment"],
    recallDue: "N/A \u2013 active ortho",
    medicalAlerts: [],
    insuranceRemaining: "Ortho lifetime max: $0 remaining \u2013 maxed out",
    pendingTx: [],
    familyMembersDue: [],
    orthoBenefit: "$0 remaining \u2013 lifetime max used, patient self-pay for remainder",
  },
  "apt-val-7": {
    apptId: "apt-val-7",
    scheduledProcedures: ["Perio maintenance"],
    recallDue: "3-month perio recall",
    medicalAlerts: ["Penicillin allergy"],
    insuranceRemaining: "$390 remaining (Guardian)",
    pendingTx: ["#31 watch \u2013 sensitivity, monitor"],
    familyMembersDue: [],
  },
  "apt-val-8": {
    apptId: "apt-val-8",
    scheduledProcedures: ["Prophy", "Fluoride"],
    recallDue: "On 6-month recall",
    medicalAlerts: [],
    insuranceRemaining: "$1,000 remaining (Delta PPO)",
    pendingTx: [],
    familyMembersDue: [],
  },
}

export function getOdSnapshot(apptId: string): OdSnapshot | undefined {
  return odSnapshots[apptId]
}
