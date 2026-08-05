/**
 * Presentational chrome for the /tc/settings sections that are read-only or
 * explanatory. Everything here is inert on purpose: no section built from
 * these pieces may render an enabled control, because none of them have a
 * write path on the platform today.
 *
 * Semantic theme tokens only — the teal/coral DentaFlow palette comes from
 * --primary / --accent-coral, so light and dark both work without overrides.
 */
import type { ReactNode } from "react";
import { CheckCircle2, CircleDashed, HelpCircle, type LucideIcon } from "lucide-react";

export function SettingsCard({
  title,
  icon: Icon,
  description,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 shadow-sm space-y-3">
      <div>
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-primary shrink-0" aria-hidden />}
          <h2
            className="text-sm font-semibold text-foreground"
            style={{ fontFamily: "Sora, sans-serif" }}
          >
            {title}
          </h2>
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/** A label/value pair for values the platform owns and TC only displays. */
export function ReadOnlyRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground break-words">{value}</span>
      {hint && <span className="w-full text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Integration availability. Deliberately three-valued: we never render
 * "connected" for something we have not actually read.
 *  - available   → the platform read/proxy works for this office today
 *  - unavailable → the capability is real but switched off / not yet built
 *  - unknown     → we have no entitled read, so we say so
 */
export type IntegrationState = "available" | "unavailable" | "unknown";

const STATE_BADGE: Record<IntegrationState, { label: string; className: string; icon: LucideIcon }> =
  {
    available: {
      label: "Available",
      className: "bg-primary/10 text-primary",
      icon: CheckCircle2,
    },
    unavailable: {
      label: "Not available",
      className: "bg-muted text-muted-foreground",
      icon: CircleDashed,
    },
    unknown: {
      label: "Unknown",
      className: "bg-muted text-muted-foreground",
      icon: HelpCircle,
    },
  };

export function IntegrationRow({
  label,
  state,
  badgeLabel,
  detail,
  children,
}: {
  label: string;
  state: IntegrationState;
  /** Overrides the default badge text (e.g. "Connected" for the OD connector). */
  badgeLabel?: string;
  detail: ReactNode;
  children?: ReactNode;
}) {
  const badge = STATE_BADGE[state];
  const Icon = badge.icon;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
      <Icon
        className={`w-4 h-4 mt-0.5 shrink-0 ${
          state === "available" ? "text-primary" : "text-muted-foreground"
        }`}
        aria-hidden
      />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground leading-relaxed">{detail}</div>
        {children}
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.className}`}
      >
        {badgeLabel ?? badge.label}
      </span>
    </div>
  );
}

/** Small muted note used to retire a legacy capability without a dead button. */
export function RetiredNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
      {children}
    </p>
  );
}
