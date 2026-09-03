import { create } from "zustand"
import type { ConfirmationStatus } from "@/mock/types"

interface AppointmentStatusState {
  overrides: Record<string, ConfirmationStatus>
  setStatus: (apptId: string, status: ConfirmationStatus) => void
  getStatus: (apptId: string, fallback: ConfirmationStatus) => ConfirmationStatus
}

export const useAppointmentStatusStore = create<AppointmentStatusState>((set, get) => ({
  overrides: {},
  setStatus: (apptId, status) => set((s) => ({ overrides: { ...s.overrides, [apptId]: status } })),
  getStatus: (apptId, fallback) => get().overrides[apptId] ?? fallback,
}))
