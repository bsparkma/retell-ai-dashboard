/**
 * The perio grid: 32 teeth × 6 sites, today's readings with the last exam's
 * underneath (H4 slice 10).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LAID OUT THE WAY THE MOUTH IS
 * ═════════════════════════════════════════════════════════════════════════════
 * Upper arch #1 → #16 left to right, facial row above lingual; lower arch
 * #32 → #17 left to right, lingual row above facial — so the two lingual rows
 * meet in the middle of the grid, the way the prototype's perio tab and Open
 * Dental's own chart both draw it. Tooth order comes from shared/hyg/perio.ts,
 * which a test holds equal to lib/hyg/dentition.ts.
 *
 * Within a tooth the three sites are in SCREEN order, which is anatomical: the
 * distal site is on the left for a patient-right tooth and on the right for a
 * patient-left one (`screenSites`). That is what makes the cursor move smoothly
 * along the arch instead of jumping to the far side of each tooth.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE FOCUS STOP, NOT 192
 * ═════════════════════════════════════════════════════════════════════════════
 * The grid itself holds focus and owns the keyboard. The site buttons are
 * `tabIndex={-1}`: they are for TAPPING a site to move the cursor there, and a
 * Tab key that walked 192 buttons would be a trap. A key pressed while a tapped
 * button has focus still bubbles to the grid.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE LAST EXAM IS UNDER EACH SITE, OR NOT AT ALL
 * ═════════════════════════════════════════════════════════════════════════════
 * A small grey number under today's reading — "last charted 3-2-3" beside
 * today's entry is half the clinical value of the screen. When there is no
 * prior exam the line is BLANK. It is never a zero: a zero is a reading.
 */
import { type KeyboardEvent, type Ref } from "react";

import { type ToothSurface } from "@shared/hyg/contract";
import {
  PERIO_LOWER_TEETH,
  PERIO_UPPER_TEETH,
  perioSite,
  perioTooth,
  sameCursor,
  screenSites,
  type PerioChart,
  type PerioCursor,
  type PerioSide,
} from "@shared/hyg/perio";
import { cn } from "@/lib/utils";

/** Row label column, then sixteen equal tooth columns. */
const ROW = "grid grid-cols-[3.75rem_repeat(16,minmax(0,1fr))] gap-1";

function depthTone(depth: number | null): string {
  if (depth === null) return "bg-muted/60 text-muted-foreground";
  if (depth >= 5) return "bg-red-100 text-red-900 dark:bg-red-950/70 dark:text-red-200";
  if (depth === 4) return "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200";
  return "bg-secondary text-secondary-foreground";
}

const SIDE_LABEL: Record<PerioSide, string> = { facial: "Facial", lingual: "Lingual" };

interface GridProps {
  chart: PerioChart;
  /** The last exam's chart, or null when there is none (or it is not read yet). */
  prior: PerioChart | null;
  cursor: PerioCursor;
  lastEntered: PerioCursor | null;
  onSelect: (cursor: PerioCursor) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  gridRef?: Ref<HTMLDivElement>;
  /** Teeth an incomplete send could not match in Open Dental (item 12) — marked beside the error. */
  failedTeeth?: number[];
}

function SiteCell({
  chart,
  prior,
  tooth,
  surface,
  cursor,
  lastEntered,
  onSelect,
}: Omit<GridProps, "onKeyDown" | "gridRef"> & { tooth: number; surface: ToothSurface }) {
  const site = perioSite(chart, tooth, surface);
  const priorSite = prior && !perioTooth(prior, tooth).skipped ? perioSite(prior, tooth, surface) : null;
  const priorDepth = priorSite ? priorSite.depth : null;
  const here = { tooth, surface };
  const active = sameCursor(cursor, here);
  const justEntered = !active && sameCursor(lastEntered, here);

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => onSelect(here)}
      data-testid={`hyg-perio-site-${tooth}-${surface}`}
      data-active={active ? "true" : undefined}
      aria-label={
        `#${tooth} ${surface}: ${site.depth === null ? "not charted" : `${site.depth} mm`}` +
        (priorDepth !== null ? `, last exam ${priorDepth} mm` : "")
      }
      className={cn(
        "relative flex h-11 min-w-0 flex-1 flex-col items-center justify-center rounded-sm text-sm font-semibold leading-none tabular-nums",
        depthTone(site.depth),
        active && "z-10 ring-2 ring-primary ring-offset-1 ring-offset-background",
        justEntered && "outline outline-1 outline-primary/60",
      )}
    >
      <span>{site.depth ?? "·"}</span>
      <span
        className="mt-1 text-[10px] font-normal text-muted-foreground"
        data-testid={priorDepth !== null ? `hyg-perio-prior-${tooth}-${surface}` : undefined}
      >
        {priorDepth !== null ? priorDepth : " "}
      </span>
      <span className="absolute right-0.5 top-0.5 flex gap-px" aria-hidden>
        {site.bleeding ? <span className="size-1.5 rounded-full bg-red-600" /> : null}
        {site.suppuration ? <span className="size-1.5 rounded-full bg-yellow-500" /> : null}
        {site.plaque ? <span className="size-1.5 rounded-full bg-sky-500" /> : null}
        {site.calculus ? <span className="size-1.5 rounded-full bg-stone-500" /> : null}
      </span>
    </button>
  );
}

function ToothSide(props: Omit<GridProps, "onKeyDown" | "gridRef"> & { tooth: number; side: PerioSide }) {
  const { chart, tooth, side, cursor, onSelect } = props;
  const sites = screenSites(tooth, side);
  if (perioTooth(chart, tooth).skipped) {
    const active = cursor.tooth === tooth && sites.includes(cursor.surface);
    return (
      <button
        type="button"
        tabIndex={-1}
        onClick={() => onSelect({ tooth, surface: sites[0] })}
        data-testid={`hyg-perio-skipped-${tooth}-${side}`}
        aria-label={`#${tooth} skipped`}
        className={cn(
          "h-11 rounded-sm border border-dashed border-muted-foreground/40 text-[10px] uppercase tracking-wide text-muted-foreground",
          active && "ring-2 ring-primary ring-offset-1 ring-offset-background",
        )}
      >
        skip
      </button>
    );
  }
  return (
    <div className="flex min-w-0 gap-px">
      {sites.map((surface) => (
        <SiteCell key={surface} {...props} surface={surface} />
      ))}
    </div>
  );
}

function Arch(props: Omit<GridProps, "onKeyDown" | "gridRef"> & { arch: "upper" | "lower" }) {
  const teeth = props.arch === "upper" ? PERIO_UPPER_TEETH : PERIO_LOWER_TEETH;
  const sides: PerioSide[] = props.arch === "upper" ? ["facial", "lingual"] : ["lingual", "facial"];
  const numbers = (
    <div className={ROW} aria-hidden>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {props.arch === "upper" ? "Upper" : "Lower"}
      </span>
      {teeth.map((tooth) => {
        const failed = (props.failedTeeth ?? []).includes(tooth);
        return (
          <span
            key={tooth}
            data-testid={failed ? `hyg-perio-failed-tooth-${tooth}` : undefined}
            className={cn(
              "text-center text-xs font-semibold tabular-nums",
              failed
                ? "rounded bg-destructive text-destructive-foreground"
                : props.cursor.tooth === tooth
                  ? "text-primary"
                  : "text-muted-foreground",
            )}
          >
            {failed ? `${tooth}!` : tooth}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-1">
      {props.arch === "upper" ? numbers : null}
      {sides.map((side) => (
        <div key={side} role="row" className={ROW} data-testid={`hyg-perio-row-${props.arch}-${side}`}>
          <span className="self-center text-xs font-medium text-muted-foreground">{SIDE_LABEL[side]}</span>
          {teeth.map((tooth) => (
            <ToothSide key={tooth} {...props} tooth={tooth} side={side} />
          ))}
        </div>
      ))}
      {props.arch === "lower" ? numbers : null}
    </div>
  );
}

export function PerioGrid({ gridRef, onKeyDown, ...props }: GridProps) {
  return (
    <div
      ref={gridRef}
      role="grid"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Perio chart. Type a depth to enter it and move on. B, S, P and C toggle flags; X skips a tooth."
      data-testid="hyg-perio-grid"
      className="rounded-2xl border border-border bg-card p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Arch {...props} arch="upper" />
      <div className="my-2 border-t border-dashed border-border" />
      <Arch {...props} arch="lower" />
    </div>
  );
}
