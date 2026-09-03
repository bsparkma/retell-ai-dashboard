import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SiteReading, ToothSurface } from "@/mock/types"

interface ManualKeypadProps {
  toothNumber: number | null
  surface: ToothSurface | null
  reading: SiteReading | null
  onDepth: (depth: number) => void
  onToggleFlag: (flag: keyof Omit<SiteReading, "depth">) => void
}

const FLAGS: { key: keyof Omit<SiteReading, "depth">; label: string; dotClass: string }[] = [
  { key: "bleeding", label: "Bleeding", dotClass: "bg-destructive" },
  { key: "suppuration", label: "Suppuration", dotClass: "bg-warning" },
  { key: "plaque", label: "Plaque", dotClass: "bg-primary" },
  { key: "calculus", label: "Calculus", dotClass: "bg-muted-foreground" },
]

export function ManualKeypad({ toothNumber, surface, reading, onDepth, onToggleFlag }: ManualKeypadProps) {
  if (!toothNumber || !surface || !reading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">Tap a site on the chart to enter a reading manually.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div>
        <p className="text-sm font-semibold text-foreground">
          Tooth #{toothNumber} · {surface}
        </p>
        <p className="text-xs text-muted-foreground">Tap a depth, then flag any findings.</p>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {Array.from({ length: 9 }, (_, i) => i + 1).map((depth) => (
          <Button
            key={depth}
            type="button"
            variant={reading.depth === depth ? "default" : "outline"}
            className="h-11 w-full"
            onClick={() => onDepth(depth)}
          >
            {depth}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {FLAGS.map((flag) => {
          const active = reading[flag.key]
          return (
            <Button
              key={flag.key}
              type="button"
              variant={active ? "default" : "outline"}
              size="sm"
              className="h-9 rounded-full"
              onClick={() => onToggleFlag(flag.key)}
            >
              <span className={cn("mr-1.5 size-2 rounded-full", flag.dotClass)} />
              {flag.label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
