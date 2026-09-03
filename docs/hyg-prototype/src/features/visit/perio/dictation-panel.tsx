import { useState } from "react"
import { MicIcon, PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { demoDictationScript } from "@/mock/perio"

interface DictationPanelProps {
  stepIndex: number
  log: string[]
  isPlaying: boolean
  onStart: () => void
  onStop: () => void
  onReset: () => void
}

export function DictationPanel({ stepIndex, log, isPlaying, onStart, onStop, onReset }: DictationPanelProps) {
  const totalSteps = demoDictationScript.length
  const currentStep = demoDictationScript[Math.min(stepIndex, totalSteps - 1)]

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Voice charting</h3>
        <span className="text-xs text-muted-foreground">
          Step {Math.min(stepIndex, totalSteps)} / {totalSteps}
        </span>
      </div>

      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border border-border bg-secondary/60 p-4",
          isPlaying && "border-primary bg-primary/5",
        )}
      >
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground",
            isPlaying && "animate-pulse",
          )}
        >
          <MicIcon data-icon="inline-start" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {isPlaying ? `"${currentStep?.transcript ?? ""}"` : "Ready to dictate"}
          </p>
          <p className="truncate text-xs text-muted-foreground">{currentStep?.interpretation ?? "Start the demo to see live parsing."}</p>
        </div>
      </div>

      <div className="flex gap-2">
        {!isPlaying ? (
          <Button className="h-11 flex-1" onClick={onStart}>
            <PlayIcon data-icon="inline-start" />
            {stepIndex > 0 ? "Resume demo dictation" : "Start demo dictation"}
          </Button>
        ) : (
          <Button className="h-11 flex-1" variant="secondary" onClick={onStop}>
            <SquareIcon data-icon="inline-start" />
            Pause
          </Button>
        )}
        <Button className="h-11" variant="outline" size="icon" onClick={onReset} aria-label="Reset dictation">
          <RotateCcwIcon />
        </Button>
      </div>

      <div className="flex-1 rounded-lg border border-border">
        <ScrollArea className="h-64">
          <div className="flex flex-col gap-2 p-3">
            {log.length === 0 && <p className="p-2 text-sm text-muted-foreground">Transcript will appear here as you dictate.</p>}
            {log.map((entry, i) => (
              <div key={i} className="rounded-md bg-secondary/50 px-3 py-2 text-sm text-foreground">
                {entry}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
