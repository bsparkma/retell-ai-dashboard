import { create } from "zustand"
import type { StagedWrite, StagedWriteKind, StagedWriteState } from "@/mock/types"

interface StagedWritesState {
  writes: StagedWrite[]
  /** Adds or replaces (by apptId+kind) a staged write. */
  stage: (write: Omit<StagedWrite, "id" | "createdAt" | "state"> & { state?: StagedWriteState }) => void
  remove: (id: string) => void
  setState: (id: string, state: StagedWriteState, errorMessage?: string) => void
  writesForAppt: (apptId: string) => StagedWrite[]
  /** Simulates sequential sends. One item can be forced to fail for the demo retry path. */
  sendAll: (apptId: string, onProgress?: () => void) => Promise<void>
  retry: (id: string) => Promise<void>
}

let idCounter = 0
function nextId(kind: StagedWriteKind) {
  idCounter += 1
  return `write-${kind}-${idCounter}-${Date.now()}`
}

export const useStagedWritesStore = create<StagedWritesState>((set, get) => ({
  writes: [],

  stage: (write) => {
    set((s) => {
      const existingIndex = s.writes.findIndex((w) => w.apptId === write.apptId && w.kind === write.kind)
      const newWrite: StagedWrite = {
        id: existingIndex >= 0 ? s.writes[existingIndex].id : nextId(write.kind),
        createdAt: Date.now(),
        state: write.state ?? "Staged",
        ...write,
      }
      if (existingIndex >= 0) {
        const copy = [...s.writes]
        copy[existingIndex] = newWrite
        return { writes: copy }
      }
      return { writes: [...s.writes, newWrite] }
    })
  },

  remove: (id) => set((s) => ({ writes: s.writes.filter((w) => w.id !== id) })),

  setState: (id, state, errorMessage) =>
    set((s) => ({
      writes: s.writes.map((w) => (w.id === id ? { ...w, state, errorMessage } : w)),
    })),

  writesForAppt: (apptId) => get().writes.filter((w) => w.apptId === apptId),

  sendAll: async (apptId, onProgress) => {
    const items = get().writes.filter((w) => w.apptId === apptId && w.state === "Staged")
    // Force exactly one item to fail on the first pass, to demonstrate the retry path.
    const failIndex = items.length > 1 ? 1 : -1
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      get().setState(item.id, "Sending")
      onProgress?.()
      await new Promise((r) => setTimeout(r, 900))
      if (i === failIndex) {
        get().setState(item.id, "Failed", "Connection to Open Dental timed out.")
      } else {
        get().setState(item.id, "Written")
      }
      onProgress?.()
    }
  },

  retry: async (id) => {
    get().setState(id, "Sending")
    await new Promise((r) => setTimeout(r, 900))
    get().setState(id, "Written")
  },
}))
