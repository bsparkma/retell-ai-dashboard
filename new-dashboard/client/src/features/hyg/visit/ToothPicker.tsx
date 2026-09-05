/**
 * The tooth chart, as something you tap with a gloved finger.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT THE PROTOTYPE'S ODONTOGRAM
 * ═════════════════════════════════════════════════════════════════════════════
 * `docs/hyg-prototype/src/components/Odontogram.tsx` draws tooth SHAPES with
 * per-surface hit areas. That is the right end state and it is not what slice 2
 * needs: nothing here records a surface-level finding on the chart itself —
 * surfaces are chosen on the treatment item, from a five-value list, because
 * that is what a restoration is written as.
 *
 * So this is the same information as two rows of numbered buttons. It costs a
 * tenth of the code, every target is a real 44px square instead of a polygon,
 * and it is legible at arm's length. When perio charting arrives (H4) and
 * per-tooth surface state becomes a real requirement, the shapes come with it.
 *
 * `lib/hyg/dentition.ts` is the source of the numbering — ported verbatim from
 * the prototype and pinned by its own test. Nothing here re-derives a quadrant
 * or an opposing tooth.
 */
import {
  LOWER_PERMANENT,
  LOWER_PRIMARY,
  UPPER_PERMANENT,
  UPPER_PRIMARY,
} from "@/lib/hyg/dentition";
import { cn } from "@/lib/utils";

export type Dentition = "adult" | "primary";

/**
 * Primary teeth are LETTERS in this codebase's dentition module and the
 * contract stores `teeth` as numbers. A primary tooth is stored as its letter's
 * position offset by 100 — A → 101, T → 120 — so the two dentitions cannot
 * collide in one array and a stored value is always self-describing.
 *
 * This is the only place that mapping exists. If it ever needs to be somewhere
 * else, it moves to dentition.ts rather than being written twice.
 */
export const PRIMARY_OFFSET = 100;

const PRIMARY_LETTERS = [...UPPER_PRIMARY, ...LOWER_PRIMARY];

export function toothLabel(tooth: number): string {
  if (tooth > PRIMARY_OFFSET) {
    return PRIMARY_LETTERS[tooth - PRIMARY_OFFSET - 1] ?? String(tooth);
  }
  return String(tooth);
}

export function primaryToNumber(letter: string): number {
  return PRIMARY_OFFSET + PRIMARY_LETTERS.indexOf(letter) + 1;
}

function ToothButton({
  tooth,
  selected,
  count,
  onToggle,
}: {
  tooth: number;
  selected: boolean;
  count: number;
  onToggle: (tooth: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(tooth)}
      aria-pressed={selected}
      aria-label={`Tooth ${toothLabel(tooth)}${count > 0 ? `, ${count} planned` : ""}`}
      data-testid={`hyg-tooth-${toothLabel(tooth)}`}
      className={cn(
        // 44px minimum, both axes. The finger doing the tapping has just come
        // off an instrument tray.
        "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border text-sm font-medium tabular-nums transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-foreground hover:bg-accent/50",
      )}
    >
      {toothLabel(tooth)}
      {count > 0 ? (
        // A tooth that already carries planned work. Not a colour alone — a
        // number, because a colour is a thing you have to have been told about.
        <span
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white"
          data-testid={`hyg-tooth-count-${toothLabel(tooth)}`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function ToothPicker({
  dentition,
  selected,
  counts,
  onToggle,
  onDentitionChange,
}: {
  dentition: Dentition;
  selected: number[];
  /** Tooth number → how many treatment items already name it. */
  counts: Record<number, number>;
  onToggle: (tooth: number) => void;
  onDentitionChange: (d: Dentition) => void;
}) {
  const upper =
    dentition === "adult" ? UPPER_PERMANENT : UPPER_PRIMARY.map(primaryToNumber);
  const lower =
    dentition === "adult" ? LOWER_PERMANENT : LOWER_PRIMARY.map(primaryToNumber);

  return (
    <div data-testid="hyg-tooth-picker">
      <div className="mb-2 flex items-center gap-2">
        {(["adult", "primary"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onDentitionChange(d)}
            aria-pressed={dentition === d}
            data-testid={`hyg-dentition-${d}`}
            className={cn(
              "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors",
              dentition === d
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent/40",
            )}
          >
            {d === "adult" ? "Adult" : "Primary"}
          </button>
        ))}
      </div>

      {/*
        ONE COLUMN PER TOOTH POSITION, upper row above lower row. A wrapping
        flex row is what this was first, and it put #17 under #3 — the arches
        stopped lining up, which on a tooth chart is not a cosmetic problem. The
        row scrolls sideways rather than wrapping when the screen is narrower
        than sixteen 44px targets.
      */}
      <div className="space-y-1.5 overflow-x-auto pb-1">
        {[upper, lower].map((arch, i) => (
          <div
            key={i}
            className="grid w-max gap-1"
            style={{ gridTemplateColumns: `repeat(${arch.length}, minmax(2.75rem, 1fr))` }}
          >
            {arch.map((tooth) => (
              <ToothButton
                key={tooth}
                tooth={tooth}
                selected={selected.includes(tooth)}
                count={counts[tooth] ?? 0}
                onToggle={onToggle}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
