import { useEffect, useRef, useState } from "react"
import { GitCompareIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useVisitStore } from "@/store/visit-store"
import { useStagedWritesStore } from "@/store/staged-writes-store"
import { getPriorExam, demoDictationScript } from "@/mock/perio"
import type { Appointment, ToothSurface } from "@/mock/types"
import { PerioGrid } from "./perio-grid"
import { DictationPanel } from "./dictation-panel"
import { ManualKeypad } from "./manual-keypad"
import { chartSummary, findTooth } from "./perio-utils"

interface PerioTabProps {
  appt: Appointment
  patientId: string
}

export function PerioTab({ appt, patientId }: PerioTabProps) {
  const teeth = useVisitStore((s) => s.getVisit(appt.id).perioTeeth)
  const updateSite = useVisitStore((s) => s.updateSite)
  const stage = useStagedWritesStore((s) => s.stage)

  const [activeTooth, setActiveTooth] = useState<number | null>(null)
  const [activeSurface, setActiveSurface] = useState<ToothSurface | null>(null)
  const [activeSurfaceGroup, setActiveSurfaceGroup] = useState<"facial" | "lingual">("facial")
  const [compareMode, setCompareMode] = useState(false)
  const [staged, setStaged] = useState(false)

  const [stepIndex, setStepIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const priorExam = getPriorExam(patientId)
  const summary = chartSummary(teeth)

  function handleSelectSite(toothNumber: number, surface: ToothSurface) {
    setActiveTooth(toothNumber)
    setActiveSurface(surface)
    setActiveSurfaceGroup(["DB", "B", "MB"].includes(surface) ? "facial" : "lingual")
  }

  function applyDictationStep(index: number) {
    const step = demoDictationScript[index]
    if (!step) return
    setActiveTooth(step.toothNumber)
    setActiveSurfaceGroup(step.surfaceGroup)
    for (const [surface, patch] of Object.entries(step.readings)) {
      updateSite(appt.id, step.toothNumber, surface as ToothSurface, patch)
    }
    setLog((prev) => [...prev, step.interpretation])
  }

  useEffect(() => {
    if (!isPlaying) return
    if (stepIndex >= demoDictationScript.length) {
      setIsPlaying(false)
      return
    }
    timerRef.current = setTimeout(() => {
      applyDictationStep(stepIndex)
      setStepIndex((i) => i + 1)
    }, 1400)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, stepIndex])

  function handleDepth(depth: number) {
    if (!activeTooth || !activeSurface) return
    const tooth = findTooth(teeth, activeTooth)
    const current = tooth?.sites[activeSurface]?.depth
    updateSite(appt.id, activeTooth, activeSurface, { depth: current === depth ? null : depth })
  }

  function handleToggleFlag(flag: "bleeding" | "suppuration" | "plaque" | "calculus") {
    if (!activeTooth || !activeSurface) return
    const tooth = findTooth(teeth, activeTooth)
    const reading = tooth?.sites[activeSurface]
    if (!reading) return
    updateSite(appt.id, activeTooth, activeSurface, { [flag]: !reading[flag] })
  }

  const activeReading = activeTooth && activeSurface ? findTooth(teeth, activeTooth)?.sites[activeSurface] ?? null : null

  function handleStage() {
    stage({
      apptId: appt.id,
      kind: "perio",
      title: "Full mouth perio chart",
      summary: `${summary.totalSites} sites charted · ${summary.bopPercent}% BOP · ${summary.deepSites} sites ≥5mm`,
      preview: [
        `Sites charted: ${summary.totalSites}`,
        `Bleeding on probing: ${summary.bopPercent}% (${summary.bleedingSites} sites)`,
        `Sites ≥5mm: ${summary.deepSites}`,
        `Plaque sites: ${summary.plaqueSites}`,
      ],
    })
    setStaged(true)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{summary.totalSites} sites charted</Badge>
          <Badge className={cn(summary.bopPercent > 15 ? "bg-destructive text-destructive-foreground" : "bg-secondary text-secondary-foreground")}>
            {summary.bopPercent}% BOP
          </Badge>
          {summary.deepSites > 0 && <Badge className="bg-warning text-warning-foreground">{summary.deepSites} sites ≥5mm</Badge>}
        </div>
        {priorExam && (
          <Button
            variant={compareMode ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => setCompareMode((v) => !v)}
          >
            <GitCompareIcon data-icon="inline-start" />
            Compare to {priorExam.date}
          </Button>
        )}
      </div>

      <div className="grid flex-1 grid-cols-1 gap-6 overflow-y-auto p-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 overflow-x-auto">
          <PerioGrid
            teeth={teeth}
            compareTeeth={compareMode ? priorExam?.teeth : undefined}
            activeTooth={activeTooth}
            activeSurfaceGroup={activeSurfaceGroup}
            onSelectSite={handleSelectSite}
          />
        </div>
        <div className="flex flex-col gap-6">
          <DictationPanel
            stepIndex={stepIndex}
            log={log}
            isPlaying={isPlaying}
            onStart={() => setIsPlaying(true)}
            onStop={() => setIsPlaying(false)}
            onReset={() => {
              setIsPlaying(false)
              setStepIndex(0)
              setLog([])
            }}
          />
          <ManualKeypad
            toothNumber={activeTooth}
            surface={activeSurface}
            reading={activeReading}
            onDepth={handleDepth}
            onToggleFlag={handleToggleFlag}
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border bg-card px-6 py-4">
        <p className="text-sm text-muted-foreground">
          {staged ? "Perio chart staged — review before sending in Finish." : "Stage the chart once charting is complete."}
        </p>
        <Button size="lg" className="h-11" onClick={handleStage}>
          {staged ? "Update staged chart" : "Stage perio chart"}
        </Button>
      </div>
    </div>
  )
}
