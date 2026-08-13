/**
 * Disposition: the badge, and the one-tap picker that sets it.
 *
 * Two components, one file, because they are two views of the same value and
 * always change together:
 *
 *   DispositionBadge   — the passive fact. Sits with the other row signals.
 *   DispositionPicker  — the action. An icon button in the Actions column that
 *                        opens the seven chips; picking one is a single tap, and
 *                        the current one is offered back as "Clear".
 *
 * Failure is honest: the badge only appears after the server has taken the value.
 * The optimistic patch is reverted (and the row reloaded) by the caller's error
 * path, so a call never looks handled because a request failed quietly.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tag, Loader2, X } from "lucide-react";
import { ActionTooltip, ICON_ACTION_CLASS } from "./IconAction";
import { DISPOSITIONS, dispositionMeta } from "@/lib/dispositions";
import type { CallDisposition } from "@/lib/api";

/**
 * The chip a dispositioned call wears. Same 11px/rounded-full shape as every
 * other row signal, so "handled" reads as a fact about the call rather than a
 * new kind of thing.
 */
export function DispositionBadge({
  disposition, title, className = "",
}: {
  disposition: CallDisposition;
  /** Optional richer tooltip (the caller adds "· Sarah, 9:14a"). */
  title?: string;
  className?: string;
}) {
  const meta = dispositionMeta(disposition);
  // A value this build doesn't know (a record written by a newer version) still
  // renders — as itself, in neutral colors — rather than vanishing.
  const Icon = meta?.icon ?? Tag;
  return (
    <span
      data-testid="disposition-badge"
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full ${className}`}
      style={{
        color: meta?.color ?? "var(--muted-foreground)",
        backgroundColor: meta?.bg ?? "var(--muted)",
      }}
      title={title ?? meta?.label ?? disposition}
    >
      <Icon size={10} /> {meta?.label ?? disposition}
    </span>
  );
}

interface DispositionPickerProps {
  current: CallDisposition | null;
  /** Persist the choice; `null` clears it. Rejects on failure so we can stop spinning. */
  onPick: (disposition: CallDisposition | null) => Promise<void>;
  /** `icon` for the worklist row; `button` for the roomier call-detail page. */
  variant?: "icon" | "button";
}

export function DispositionPicker({ current, onPick, variant = "icon" }: DispositionPickerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const meta = dispositionMeta(current);

  const label = current
    ? `Disposition: ${meta?.label ?? current} — click to change or clear`
    : "Mark what kind of call this was";

  const choose = async (value: CallDisposition | null) => {
    setSaving(true);
    try {
      await onPick(value);
      setOpen(false);
    } catch {
      // The caller toasts and reconciles; keep the popover open so the click has
      // somewhere to land again.
    } finally {
      setSaving(false);
    }
  };

  const icon = saving ? <Loader2 size={13} className="animate-spin" /> : <Tag size={13} />;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {variant === "icon" ? (
        <ActionTooltip label={label}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant={current ? "secondary" : "outline"}
              className={ICON_ACTION_CLASS}
              aria-label={label}
              disabled={saving}
            >
              {icon}
            </Button>
          </PopoverTrigger>
        </ActionTooltip>
      ) : (
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            aria-label={label}
            title={label}
            disabled={saving}
          >
            {icon}
            {current ? (meta?.label ?? current) : "Set disposition"}
          </Button>
        </PopoverTrigger>
      )}

      <PopoverContent align="end" className="w-56 p-2">
        <div className="text-xs font-semibold text-muted-foreground px-1 pb-1.5">
          What kind of call was this?
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DISPOSITIONS.map((d) => {
            const Icon = d.icon;
            const active = current === d.value;
            return (
              <button
                key={d.value}
                onClick={() => choose(active ? null : d.value)}
                aria-pressed={active}
                disabled={saving}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full border transition-all disabled:opacity-60"
                style={{
                  color: d.color,
                  backgroundColor: active ? d.bg : "transparent",
                  borderColor: active ? d.color : "var(--border)",
                }}
              >
                <Icon size={11} /> {d.label}
              </button>
            );
          })}
        </div>
        {current && (
          <button
            onClick={() => choose(null)}
            disabled={saving}
            className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline disabled:opacity-60"
          >
            <X size={11} /> Clear disposition
          </button>
        )}
        {/* Says what this does NOT do. The two existing ways to finish a call both
            write somewhere, so "handled" has meant "written" until now. */}
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
          Marks the call handled. Nothing is written to the chart or sent to TC.
        </p>
      </PopoverContent>
    </Popover>
  );
}
