/**
 * What every key does on the perio chart (item 17) — the keyboard, and the
 * Bluetooth number pad a hygienist holds in the hand that is not probing.
 *
 * ONE TRUTH FOR TOUCH AND KEYS. The pad's keys are drawn from the same constants
 * `entry.ts` maps them with, so the legend cannot promise a key the reducer does
 * not honour. It is dismissible because it is a reminder, not a control — and it
 * comes back from the same place, because the person who needs it most is the one
 * who closed it on Monday.
 */
import { Keyboard, X } from "lucide-react";

import { PERIO_FLAG_KEYS, PERIO_FLAG_LABELS } from "@shared/hyg/perio";
import {
  NUMPAD_FLAG_KEYS,
  NUMPAD_NEXT_TOOTH_KEY,
  NUMPAD_PREVIOUS_TOOTH_KEY,
  NUMPAD_RESERVED_KEYS,
  NUMPAD_SKIP_KEY,
} from "./entry";
import { cn } from "@/lib/utils";

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="min-w-6 rounded border border-border bg-muted/50 px-1.5 text-center font-mono text-[11px] text-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

const PAD_FLAGS = Object.entries(NUMPAD_FLAG_KEYS);

export function PerioKeyLegend({ onHide }: { onHide: () => void }) {
  const rows: { keys: string[]; does: string }[] = [
    // ONE cap, not "0", "–", "9": a lone dash here would read as the plaque key.
    { keys: ["0–9"], does: "Depth on this site, then the next site" },
    { keys: ["Shift", "0–9"], does: "10–19 mm (main keyboard)" },
    { keys: ["Enter", "Space", "→"], does: "Next site, no reading" },
    { keys: ["←"], does: "Previous site" },
    ...PAD_FLAGS.map(([key, flag]) => ({
      keys: [key, PERIO_FLAG_KEYS[flag]],
      does: `${PERIO_FLAG_LABELS[flag]} on the reading just entered`,
    })),
    { keys: [NUMPAD_SKIP_KEY, "X"], does: "Skip or un-skip this tooth" },
    { keys: ["Backspace"], does: "Step back one site and erase it" },
    { keys: ["Delete", "Esc"], does: "Erase this site; stay here" },
    { keys: [NUMPAD_PREVIOUS_TOOTH_KEY, NUMPAD_NEXT_TOOTH_KEY], does: "Previous / next tooth (number pad)" },
  ];

  return (
    <section className="rounded-xl border border-border p-3" data-testid="hyg-perio-legend" aria-label="Perio keys">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Keyboard size={14} /> Keys — keyboard and number pad
        </p>
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide the key legend"
          data-testid="hyg-perio-legend-hide"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/50"
        >
          <X size={16} />
        </button>
      </div>
      <dl className="mt-1 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.keys.join(" ")} className="flex items-baseline gap-2">
            <dt className="shrink-0">
              <Keys keys={row.keys} />
            </dt>
            <dd className="text-muted-foreground">{row.does}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="hyg-perio-legend-notes">
        {NUMPAD_RESERVED_KEYS.join(" and ")} do nothing here yet. The pad&apos;s <strong>Fn</strong> key
        sends nothing to the browser, so it cannot be given a job. Num Lock must be ON — with it off,
        the pad&apos;s numbers arrive as Home, End and arrows, and the page says so instead of charting them.
      </p>
    </section>
  );
}

/** The way back, once it is hidden. */
export function PerioKeyLegendShow({ onShow }: { onShow: () => void }) {
  return (
    <button
      type="button"
      onClick={onShow}
      data-testid="hyg-perio-legend-show"
      className={cn(
        "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-accent/50",
      )}
    >
      <Keyboard size={14} /> Show keys
    </button>
  );
}
