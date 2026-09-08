import { create } from "zustand"
import type { OfficeId } from "@/mock/types"
import { today } from "@/mock/appointments"

interface AppState {
  officeId: OfficeId
  date: string
  hygienistId: string // "all" or a hygienist id
  theme: "light" | "dark"
  navCollapsed: boolean
  micListening: boolean
  setOfficeId: (id: OfficeId) => void
  setDate: (date: string) => void
  setHygienistId: (id: string) => void
  toggleTheme: () => void
  setNavCollapsed: (collapsed: boolean) => void
  setMicListening: (listening: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  officeId: "roland",
  date: today,
  hygienistId: "all",
  theme: "light",
  navCollapsed: false,
  micListening: false,
  setOfficeId: (id) => set({ officeId: id, hygienistId: "all" }),
  setDate: (date) => set({ date }),
  setHygienistId: (id) => set({ hygienistId: id }),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "light" ? "dark" : "light"
      if (typeof document !== "undefined") {
        document.documentElement.classList.toggle("dark", next === "dark")
      }
      return { theme: next }
    }),
  setNavCollapsed: (collapsed) => set({ navCollapsed: collapsed }),
  setMicListening: (listening) => set({ micListening: listening }),
}))
