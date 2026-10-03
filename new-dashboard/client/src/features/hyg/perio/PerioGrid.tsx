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
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE QUADRANT MIDLINE, AND WHY IT IS DRAWN AND NOT COUNTED (item 18)
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental's chart breaks each arch at the midline, and a hygienist calling
 * "upper right" means #1–#8. Sixteen identical columns with nothing between #8
 * and #9 makes her count along the row to find a quadrant. So the boundary is a
 * RULE on the screen plus a caption naming the quadrant and its tooth range —
 * `UR #1–8 | UL #9–16` above, `LR #32–25 | LL #24–17` below.
 *
 * The halves come from `quadrantOf`, the app's one dentition function, rather
 * than from a hardcoded 8: a grid that drew its own midline could disagree with
 * the quadrant every other screen names.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SKIPPED TOOTH IS DRAWN AS ABSENT, NOT AS EMPTY
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental blanks a missing tooth. An un-charted site here is already a faint
 * `·` on a muted cell, so a skipped tooth drawn the same way would read as "not
 * done yet" — the one thing it must not read as on a chart that understates
 * disease when it is incomplete. So a skipped tooth gets a FILLED blank cell and
 * its number goes grey and struck through, which is legible at a glance from
 * across an operatory, and its readings are suppressed entirely.
 */
import { type KeyboardEvent, type Ref } from "react";

import { type ToothSurface } from "@shared/hyg/contract";
import {
  PERIO_LOWER_TEETH,
  PERIO_UPPER_TEETH,
  perioCal,
  perioGmIsRecession,
  perioSite,
  perioTooth,
  sameCursor,
  screenSites,
  type PerioChart,
  type PerioCursor,
  type PerioSide,
} from "@shared/hyg/perio";
import { quadrantOf, type Quadrant } from "@/lib/hyg/dentition";
import { cn } from "@/lib/utils";

/** Row label column, then sixteen equal tooth columns. */
const ROW = "grid grid-cols-[3.75rem_repeat(16,minmax(0,1fr))] gap-1";

/**
 * The quadrant rule, as a left border on the first tooth of the second half.
 * Applied to every row AND to the numbers row, so it reads as one line down the
 * grid rather than four unrelated ticks.
 */
const MIDLINE = "border-l-2 border-foreground/25 pl-1";

/**
 * Open Dental's own site names for each row. The facial row holds the three
 * buccal sites and the lingual row the three lingual ones; which of the three
 * sits leftmost depends on the side of the mouth (`screenSites`), so this is the
 * row's SITE SET in OD's naming, not a left-to-right promise.
 */
const SIDE_SITES: Record<PerioSide, string> = { facial: "DB·B·MB", lingual: "ML·L·DL" };

/** `UR #1–8` — the quadrant a half of an arch is, named the way she says it. */
const QUADRANT_LABEL: Record<Quadrant, string> = {
  UR: "UR #1–8",
  UL: "UL #9–16",
  LR: "LR #32–25",
  LL: "LL #24–17",
};

/** Is this tooth the first of the arch's second half, i.e. just past the midline? */
function startsSecondHalf(teeth: readonly number[], index: number): boolean {
  return index > 0 && quadrantOf(teeth[index]) !== quadrantOf(teeth[index - 1]);
}

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

/** What an out-of-family gingival margin is called, in one place. */
const UNRECOGNISED_MARGIN = "unrecognized margin";

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
  // ITEM 26. CAL is DERIVED — never stored, never staged, never sent.
  const cal = perioCal(site);
  const recognisedGm = site.gm === null || perioGmIsRecession(site.gm);

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => onSelect(here)}
      data-testid={`hyg-perio-site-${tooth}-${surface}`}
      data-active={active ? "true" : undefined}
      aria-label={
        `#${tooth} ${surface}: ${site.depth === null ? "not charted" : `${site.depth} mm`}` +
        (priorDepth !== null ? `, last exam ${priorDepth} mm` : "") +
        // ITEM 26: a screen reader hears the same values the cell shows.
        (site.gm === null
          ? ""
          : recognisedGm
            ? `, recession ${site.gm} mm`
            : `, margin ${site.gm} ${UNRECOGNISED_MARGIN}`) +
        (cal === null ? "" : `, CAL ${cal} mm`) +
        (site.furcation === null ? "" : `, furcation class ${site.furcation}`)
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
      {/*
        ITEM 26. THE DEPTH STAYS THE BIG NUMBER IN EVERY MODE — swapping it for the
        active mode's value would hide the depths while she charts a recession, and
        the depths are what she reads the chart against.

        Recession sits ABOVE the depth, which is where the margin is. CAL sits
        below, because it is derived from both. An unrecognised margin (the 101-119
        family, only ever from a writer that is not us) shows RAW with a marker and
        gets no CAL: guessing its sign would print a clinical number nobody measured.
      */}
      {site.gm !== null ? (
        <span
          className={cn(
            "absolute left-0.5 top-0.5 text-[10px] font-semibold leading-none",
            recognisedGm ? "text-violet-700 dark:text-violet-300" : "text-amber-700 dark:text-amber-400",
          )}
          data-testid={`hyg-perio-gm-${tooth}-${surface}`}
          title={recognisedGm ? undefined : UNRECOGNISED_MARGIN}
        >
          {site.gm}
          {recognisedGm ? null : <span data-testid={`hyg-perio-gm-unknown-${tooth}-${surface}`}>?</span>}
        </span>
      ) : null}
      {site.furcation !== null ? (
        <span
          className="absolute bottom-0.5 left-0.5 text-[10px] font-semibold leading-none text-teal-700 dark:text-teal-300"
          data-testid={`hyg-perio-furcation-${tooth}-${surface}`}
        >
          {"f" + site.furcation}
        </span>
      ) : null}
      {cal !== null ? (
        <span
          className="absolute bottom-0.5 right-0.5 text-[10px] font-normal leading-none text-violet-700 dark:text-violet-300"
          data-testid={`hyg-perio-cal-${tooth}-${surface}`}
        >
          {cal}
        </span>
      ) : null}
    </button>
  );
}

function ToothSide(
  props: Omit<GridProps, "onKeyDown" | "gridRef"> & { tooth: number; side: PerioSide; midline: boolean },
) {
  const { chart, tooth, side, cursor, onSelect, midline } = props;
  const sites = screenSites(tooth, side);
  if (perioTooth(chart, tooth).skipped) {
    const active = cursor.tooth === tooth && sites.includes(cursor.surface);
    return (
      <button
        type="button"
        tabIndex={-1}
        onClick={() => onSelect({ tooth, surface: sites[0] })}
        data-testid={`hyg-perio-skipped-${tooth}-${side}`}
        // It stays reachable: a pre-skip is a default, and an implant gets probed.
        aria-label={`#${tooth} skipped — no readings. Select it to un-skip and chart it.`}
        className={cn(
          // FILLED, not dashed: absent, not un-done. See the header.
          "h-11 rounded-sm bg-muted/80 text-muted-foreground/70",
          midline && MIDLINE,
          active && "ring-2 ring-primary ring-offset-1 ring-offset-background",
        )}
      >
        <span aria-hidden>—</span>
      </button>
    );
  }
  return (
    <div className={cn("flex min-w-0 gap-px", midline && MIDLINE)}>
      {sites.map((surface) => (
        <SiteCell key={surface} {...props} surface={surface} />
      ))}
    </div>
  );
}

function Arch(props: Omit<GridProps, "onKeyDown" | "gridRef"> & { arch: "upper" | "lower" }) {
  const teeth = props.arch === "upper" ? PERIO_UPPER_TEETH : PERIO_LOWER_TEETH;
  const sides: PerioSide[] = props.arch === "upper" ? ["facial", "lingual"] : ["lingual", "facial"];

  /** `UR #1–8 | UL #9–16` — the two quadrants of this arch, in screen order. */
  const quadrants = (
    <div className={ROW} aria-hidden data-testid={`hyg-perio-quadrants-${props.arch}`}>
      <span />
      {[0, 8].map((start) => (
        <span
          key={start}
          className={cn(
            "col-span-8 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground",
            start === 8 && MIDLINE,
          )}
        >
          {QUADRANT_LABEL[quadrantOf(teeth[start])]}
        </span>
      ))}
    </div>
  );

  const numbers = (
    <div className={ROW} aria-hidden data-testid={`hyg-perio-numbers-${props.arch}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {props.arch === "upper" ? "Upper" : "Lower"}
      </span>
      {teeth.map((tooth, i) => {
        const failed = (props.failedTeeth ?? []).includes(tooth);
        // A skipped tooth's NUMBER says so too: the row below it is blank, and a
        // blank with a black number over it reads as un-charted.
        const skipped = perioTooth(props.chart, tooth).skipped;
        // A skipped tooth sends no mobility, so it shows none.
        const mobility = skipped ? null : perioTooth(props.chart, tooth).mobility;
        return (
          <span
            key={tooth}
            data-testid={
              failed
                ? `hyg-perio-failed-tooth-${tooth}`
                : skipped
                  ? `hyg-perio-skipped-number-${tooth}`
                  : undefined
            }
            className={cn(
              "text-center text-xs font-semibold tabular-nums",
              startsSecondHalf(teeth, i) && MIDLINE,
              failed
                ? "rounded bg-destructive text-destructive-foreground"
                : props.cursor.tooth === tooth
                  ? "text-primary"
                  : skipped
                    ? "text-muted-foreground/50 line-through"
                    : "text-muted-foreground",
            )}
          >
            {failed ? `${tooth}!` : tooth}
            {/*
              ITEM 26: mobility is a TOOTH value, so it is shown with the tooth
              number rather than in a site cell — there is no site it belongs to.
              Grade 0 is a real reading ("tested, firm") and prints as m0.
            */}
            {mobility !== null ? (
              <span
                className="ml-0.5 font-normal text-rose-700 dark:text-rose-300"
                data-testid={`hyg-perio-mobility-${tooth}`}
              >
                m{mobility}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-1">
      {props.arch === "upper" ? quadrants : null}
      {props.arch === "upper" ? numbers : null}
      {sides.map((side) => (
        <div key={side} role="row" className={ROW} data-testid={`hyg-perio-row-${props.arch}-${side}`}>
          <span className="self-center text-xs font-medium leading-tight text-muted-foreground">
            {SIDE_LABEL[side]}
            {/* Open Dental's own names for the three sites in this row. */}
            <span className="block font-mono text-[10px] text-muted-foreground/70">{SIDE_SITES[side]}</span>
          </span>
          {teeth.map((tooth, i) => (
            <ToothSide
              key={tooth}
              {...props}
              tooth={tooth}
              side={side}
              midline={startsSecondHalf(teeth, i)}
            />
          ))}
        </div>
      ))}
      {props.arch === "lower" ? numbers : null}
      {props.arch === "lower" ? quadrants : null}
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
      aria-label="Perio chart. Type a number to enter it in the active mode and move on. D, G, M and F switch between depth, gingival margin, mobility and furcation. B, S, P and C toggle flags in depth mode; X skips a tooth."
      data-testid="hyg-perio-grid"
      className="rounded-2xl border border-border bg-card p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Arch {...props} arch="upper" />
      <div className="my-2 border-t border-dashed border-border" />
      <Arch {...props} arch="lower" />
    </div>
  );
}
