import type { Submission } from "./types"

export const submissions: Submission[] = [
  {
    id: "sub-1",
    officeId: "roland",
    patientId: "pt-roland-3",
    date: "2026-08-18",
    category: "Perio",
    urgency: "Soon",
    status: "Pending TC",
    hygienistId: "rol-hyg-a",
  },
  {
    id: "sub-2",
    officeId: "roland",
    patientId: "pt-roland-5",
    date: "2026-08-15",
    category: "Restorative",
    urgency: "Routine",
    status: "Presented",
    hygienistId: "rol-hyg-a",
  },
  {
    id: "sub-3",
    officeId: "roland",
    patientId: "pt-roland-6",
    date: "2026-08-10",
    category: "Ortho",
    urgency: "Routine",
    status: "Accepted",
    hygienistId: "rol-hyg-b",
  },
  {
    id: "sub-4",
    officeId: "valley",
    patientId: "pt-valley-1",
    date: "2026-08-19",
    category: "Perio",
    urgency: "Urgent",
    status: "Pending TC",
    hygienistId: "val-hyg-a",
  },
  {
    id: "sub-5",
    officeId: "valley",
    patientId: "pt-valley-5",
    date: "2026-08-08",
    category: "Cosmetic",
    urgency: "Routine",
    status: "Lost",
    hygienistId: "val-hyg-b",
  },
]

export function submissionsForOffice(officeId: string): Submission[] {
  return submissions.filter((s) => s.officeId === officeId)
}
