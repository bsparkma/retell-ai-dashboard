import { cn } from "@/lib/utils"
import type { StagedWriteState, ConfirmationStatus } from "@/mock/types"
import { Loader2, Check, X, FileEdit, Send } from "lucide-react"

const writeStateStyles: Record<StagedWriteState, string> = {
  Draft: "bg-muted text-muted-foreground",
  Staged: "bg-accent text-accent-foreground",
  Sending: "bg-warning/20 text-warning-foreground border border-warning/40",
  Written: "bg-success/15 text-success border border-success/30",
  Failed: "bg-destructive/15 text-destructive border border-destructive/30",
}

const writeStateIcons: Record<StagedWriteState, typeof Check> = {
  Draft: FileEdit,
  Staged: Send,
  Sending: Loader2,
  Written: Check,
  Failed: X,
}

export function WriteStatePill({ state, className }: { state: StagedWriteState; className?: string }) {
  const Icon = writeStateIcons[state]
  const label = state === "Failed" ? "Failed — retry" : state === "Sending" ? "Sending…" : state
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        writeStateStyles[state],
        className,
      )}
    >
      <Icon className={cn("size-3.5", state === "Sending" && "animate-spin")} />
      {label}
    </span>
  )
}

const apptStatusStyles: Record<ConfirmationStatus, string> = {
  Unconfirmed: "bg-muted text-muted-foreground",
  Confirmed: "bg-accent text-accent-foreground",
  Arrived: "bg-warning/20 text-warning-foreground border border-warning/40",
  "In Chair": "bg-primary/15 text-primary border border-primary/30",
  Done: "bg-success/15 text-success border border-success/30",
}

export function ApptStatusPill({ status, className }: { status: ConfirmationStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        apptStatusStyles[status],
        className,
      )}
    >
      {status}
    </span>
  )
}
