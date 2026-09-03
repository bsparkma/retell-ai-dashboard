import type { Hygienist, Office, Operatory } from "./types"

export const offices: Office[] = [
  { id: "roland", name: "Roland", shortName: "Roland" },
  { id: "valley", name: "Valley Fort Smith", shortName: "Valley" },
]

export const operatories: Operatory[] = [
  { id: "rol-op1", officeId: "roland", name: "Op 1", isHygiene: false },
  { id: "rol-op2", officeId: "roland", name: "Op 2", isHygiene: true },
  { id: "rol-op3", officeId: "roland", name: "Op 3", isHygiene: true },
  { id: "rol-op4", officeId: "roland", name: "Op 4", isHygiene: false },

  { id: "val-op1", officeId: "valley", name: "Op 1", isHygiene: false },
  { id: "val-op2", officeId: "valley", name: "Op 2", isHygiene: true },
  { id: "val-op3", officeId: "valley", name: "Op 3", isHygiene: true },
  { id: "val-op4", officeId: "valley", name: "Op 4", isHygiene: false },
]

export const hygienists: Hygienist[] = [
  { id: "rol-hyg-a", officeId: "roland", name: "Hygienist A", credential: "RDH", license: "SYNTHETIC-A" },
  { id: "rol-hyg-b", officeId: "roland", name: "Hygienist B", credential: "RDH", license: "SYNTHETIC-B" },

  { id: "val-hyg-a", officeId: "valley", name: "Hygienist C", credential: "RDH", license: "SYNTHETIC-C" },
  { id: "val-hyg-b", officeId: "valley", name: "Hygienist D", credential: "RDH", license: "SYNTHETIC-D" },
]

export function hygienistsForOffice(officeId: string): Hygienist[] {
  return hygienists.filter((h) => h.officeId === officeId)
}

export function operatoriesForOffice(officeId: string): Operatory[] {
  return operatories.filter((o) => o.officeId === officeId)
}
