import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import {
  ADULT_LOWER,
  ADULT_UPPER,
  PRIMARY_LOWER,
  PRIMARY_UPPER,
  QUADRANT_SHORTCUTS,
} from "@/mock/treatment-options"

export type Dentition = "adult" | "primary"

/** Orients hygienists at a glance: patient's right is the viewer's left. */
function ArchOrientationLabel({ side }: { side: "R" | "L" }) {
  return (
    <div
      className="flex w-5 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-muted text-xs font-semibold text-muted-foreground"
      aria-hidden="true"
    >
      <span>{side}</span>
    </div>
  )
}

interface OdontogramProps {
  dentition: Dentition
  onDentitionChange?: (d: Dentition) => void
  selected: string[]
  onToggleTooth: (tooth: string) => void
  onClear?: () => void
  onSelectMany?: (teeth: string[]) => void
  /** Adult universal tooth numbers (as numbers) marked missing, from the perio chart. */
  missingTeeth?: number[]
  /** Count of treatment items already recorded per tooth, for the small badge. */
  itemCounts?: Record<string, number>
  /** Read-only: no tap targets, just highlights teeth that have items. */
  readOnly?: boolean
  allowDentitionToggle?: boolean
  className?: string
}

export function Odontogram({
  dentition,
  onDentitionChange,
  selected,
  onToggleTooth,
  onClear,
  onSelectMany,
  missingTeeth = [],
  itemCounts = {},
  readOnly = false,
  allowDentitionToggle = true,
  className,
}: OdontogramProps) {
  const upper = dentition === "adult" ? ADULT_UPPER : PRIMARY_UPPER
  const lower = dentition === "adult" ? ADULT_LOWER : PRIMARY_LOWER
  const missingSet = new Set(missingTeeth.map(String))

  function isMissing(tooth: string) {
    return dentition === "adult" && missingSet.has(tooth)
  }

  function ToothButton({ tooth }: { tooth: string }) {
    const active = selected.includes(tooth)
    const missing = isMissing(tooth)
    const count = itemCounts[tooth]
    return (
      <button
        type="button"
        disabled={readOnly || missing}
        aria-pressed={active}
        aria-label={`Tooth ${tooth}${missing ? ", missing" : ""}`}
        onClick={() => !readOnly && !missing && onToggleTooth(tooth)}
        className={cn(
          "tap-target relative flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border text-sm font-medium transition-colors",
          missing
            ? "border-dashed border-border bg-muted text-muted-foreground/50"
            : active
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-foreground hover:bg-secondary",
          !readOnly && !missing && "cursor-pointer",
        )}
      >
        <span>{tooth}</span>
        {missing && <span className="text-[10px] leading-none">missing</span>}
        {!!count && (
          <Badge className="absolute -right-1.5 -top-1.5 h-5 min-w-5 justify-center rounded-full bg-accent px-1 text-[11px] text-accent-foreground">
            {count}
          </Badge>
        )}
      </button>
    )
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {QUADRANT_SHORTCUTS.map((q) => (
            <Button
              key={q.id}
              type="button"
              variant="outline"
              size="sm"
              className="h-9 rounded-full"
              disabled={readOnly}
              onClick={() => onSelectMany?.(dentition === "adult" ? q.adultTeeth : q.primaryTeeth)}
            >
              {q.label}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-full"
            disabled={readOnly}
            onClick={() => onSelectMany?.([...upper, ...lower].filter((t) => !isMissing(t)))}
          >
            Full mouth
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-full"
            disabled={readOnly}
            onClick={() => onSelectMany?.(upper.filter((t) => !isMissing(t)))}
          >
            Upper
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-full"
            disabled={readOnly}
            onClick={() => onSelectMany?.(lower.filter((t) => !isMissing(t)))}
          >
            Lower
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {allowDentitionToggle && onDentitionChange && (
            <ToggleGroup
              type="single"
              variant="outline"
              value={dentition}
              onValueChange={(v) => v && onDentitionChange(v as Dentition)}
            >
              <ToggleGroupItem value="adult" className="h-9 px-3 text-xs">
                Adult (1–32)
              </ToggleGroupItem>
              <ToggleGroupItem value="primary" className="h-9 px-3 text-xs">
                Primary (A–T)
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          {selected.length > 0 && !readOnly && (
            <>
              <span className="text-sm font-medium text-muted-foreground">{selected.length} selected</span>
              <Button type="button" variant="ghost" size="sm" className="h-9" onClick={onClear}>
                Clear
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-stretch gap-2 overflow-x-auto rounded-xl border border-border bg-secondary/30 p-4">
        <ArchOrientationLabel side="R" />
        <div className="flex min-w-max flex-1 flex-col gap-2">
          <div className="flex min-w-max justify-center gap-1.5">
            {upper.map((tooth) => (
              <ToothButton key={tooth} tooth={tooth} />
            ))}
          </div>
          <div className="mx-1 h-px bg-border" />
          <div className="flex min-w-max justify-center gap-1.5">
            {lower.map((tooth) => (
              <ToothButton key={tooth} tooth={tooth} />
            ))}
          </div>
        </div>
        <ArchOrientationLabel side="L" />
      </div>
    </div>
  )
}
