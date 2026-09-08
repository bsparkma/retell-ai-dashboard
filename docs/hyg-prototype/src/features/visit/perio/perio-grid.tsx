import { cn } from "@/lib/utils"
import type { ToothChart, ToothSurface } from "@/mock/types"
import { FACIAL_SURFACES, LINGUAL_SURFACES, LOWER_TEETH, UPPER_TEETH, depthClass, findTooth } from "./perio-utils"

interface PerioGridProps {
  teeth: ToothChart[]
  compareTeeth?: ToothChart[]
  activeTooth: number | null
  activeSurfaceGroup: "facial" | "lingual"
  onSelectSite: (toothNumber: number, surface: ToothSurface) => void
}

function SiteCell({
  depth,
  compareDepth,
  bleeding,
  suppuration,
  plaque,
  calculus,
  missing,
  active,
  onClick,
}: {
  depth: number | null
  compareDepth?: number | null
  bleeding: boolean
  suppuration: boolean
  plaque: boolean
  calculus: boolean
  missing: boolean
  active: boolean
  onClick: () => void
}) {
  if (missing) {
    return <div className="flex h-11 w-9 items-center justify-center rounded-sm bg-muted/40 text-muted-foreground">—</div>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-11 w-9 flex-col items-center justify-center rounded-sm text-sm font-semibold transition-colors",
        depthClass(depth),
        active && "ring-2 ring-ring ring-offset-1 ring-offset-background",
      )}
    >
      <span>{depth ?? "·"}</span>
      {compareDepth !== undefined && compareDepth !== null && depth !== null && (
        <span
          className={cn(
            "absolute -bottom-4 text-[10px] font-normal",
            depth > compareDepth ? "text-destructive" : depth < compareDepth ? "text-success" : "text-muted-foreground",
          )}
        >
          {depth === compareDepth ? "=" : depth > compareDepth ? `+${depth - compareDepth}` : `${depth - compareDepth}`}
        </span>
      )}
      <div className="absolute -top-1 right-0 flex gap-0.5">
        {bleeding && <span className="size-1.5 rounded-full bg-destructive" aria-label="Bleeding" />}
        {suppuration && <span className="size-1.5 rounded-full bg-warning" aria-label="Suppuration" />}
      </div>
      <div className="absolute -bottom-1 right-0 flex gap-0.5">
        {plaque && <span className="size-1.5 rounded-full bg-primary" aria-label="Plaque" />}
        {calculus && <span className="size-1.5 rounded-full bg-muted-foreground" aria-label="Calculus" />}
      </div>
    </button>
  )
}

function ArchRows({
  teethOrder,
  teeth,
  compareTeeth,
  activeTooth,
  activeSurfaceGroup,
  onSelectSite,
  surfaceOrderTop,
  surfaceOrderBottom,
}: {
  teethOrder: number[]
  teeth: ToothChart[]
  compareTeeth?: ToothChart[]
  activeTooth: number | null
  activeSurfaceGroup: "facial" | "lingual"
  onSelectSite: (toothNumber: number, surface: ToothSurface) => void
  surfaceOrderTop: ToothSurface[]
  surfaceOrderBottom: ToothSurface[]
}) {
  return (
    <div className="flex gap-0.5 overflow-x-auto pb-6">
      {teethOrder.map((toothNumber) => {
        const tooth = findTooth(teeth, toothNumber)
        const compareTooth = compareTeeth ? findTooth(compareTeeth, toothNumber) : undefined
        if (!tooth) return null
        return (
          <div key={toothNumber} className="flex flex-col items-center gap-1">
            <span className="text-xs font-medium text-muted-foreground">{toothNumber}</span>
            <div className="flex gap-0.5">
              {surfaceOrderTop.map((surface) => (
                <SiteCell
                  key={surface}
                  depth={tooth.sites[surface].depth}
                  compareDepth={compareTooth?.sites[surface].depth}
                  bleeding={tooth.sites[surface].bleeding}
                  suppuration={tooth.sites[surface].suppuration}
                  plaque={tooth.sites[surface].plaque}
                  calculus={tooth.sites[surface].calculus}
                  missing={tooth.missing}
                  active={activeTooth === toothNumber && activeSurfaceGroup === (surfaceOrderTop === FACIAL_SURFACES ? "facial" : "lingual")}
                  onClick={() => onSelectSite(toothNumber, surface)}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Orients hygienists at a glance: patient's right is the viewer's left. */
function ArchSideLabel({ side }: { side: "R" | "L" }) {
  return (
    <div
      className="flex w-5 shrink-0 items-center justify-center self-stretch rounded-md bg-muted text-xs font-semibold text-muted-foreground"
      aria-hidden="true"
    >
      {side}
    </div>
  )
}

export function PerioGrid({ teeth, compareTeeth, activeTooth, activeSurfaceGroup, onSelectSite }: PerioGridProps) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-stretch gap-2">
        <ArchSideLabel side="R" />
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Upper — facial</p>
          <ArchRows
            teethOrder={UPPER_TEETH}
            teeth={teeth}
            compareTeeth={compareTeeth}
            activeTooth={activeTooth}
            activeSurfaceGroup={activeSurfaceGroup}
            onSelectSite={onSelectSite}
            surfaceOrderTop={FACIAL_SURFACES}
            surfaceOrderBottom={LINGUAL_SURFACES}
          />
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Upper — lingual</p>
          <ArchRows
            teethOrder={UPPER_TEETH}
            teeth={teeth}
            compareTeeth={compareTeeth}
            activeTooth={activeTooth}
            activeSurfaceGroup={activeSurfaceGroup}
            onSelectSite={onSelectSite}
            surfaceOrderTop={LINGUAL_SURFACES}
            surfaceOrderBottom={FACIAL_SURFACES}
          />
        </div>
        <ArchSideLabel side="L" />
      </div>
      <div className="flex items-stretch gap-2">
        <ArchSideLabel side="R" />
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Lower — lingual</p>
          <ArchRows
            teethOrder={LOWER_TEETH}
            teeth={teeth}
            compareTeeth={compareTeeth}
            activeTooth={activeTooth}
            activeSurfaceGroup={activeSurfaceGroup}
            onSelectSite={onSelectSite}
            surfaceOrderTop={LINGUAL_SURFACES}
            surfaceOrderBottom={FACIAL_SURFACES}
          />
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Lower — facial</p>
          <ArchRows
            teethOrder={LOWER_TEETH}
            teeth={teeth}
            compareTeeth={compareTeeth}
            activeTooth={activeTooth}
            activeSurfaceGroup={activeSurfaceGroup}
            onSelectSite={onSelectSite}
            surfaceOrderTop={FACIAL_SURFACES}
            surfaceOrderBottom={LINGUAL_SURFACES}
          />
        </div>
        <ArchSideLabel side="L" />
      </div>
    </div>
  )
}
