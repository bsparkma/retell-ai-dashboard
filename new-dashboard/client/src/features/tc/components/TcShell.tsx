/**
 * Shared TC chrome: page header, office gate, status badges, and the
 * disabled-feature affordance used for everything that ships dark in Slice 4
 * (email send, smile-sim generate, OD pulls, dictation).
 */
import type { ReactNode } from "react";
import { OfficeId } from "@shared/tc/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Building2, Loader2 } from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { CASE_STATUSES, PREAUTH_STATUSES, URGENCY_BADGE, URGENCY_LABELS } from "../status";
import type { CaseStatusId, PreauthStatusId, UrgencyId } from "../status";

// ── Office narrowing ────────────────────────────────────────────────────────

/**
 * Single-office narrowing for surfaces that WRITE (case detail, prep/post
 * consult, template editor, pre-auth, gallery upload, library): a write needs
 * an unambiguous office, so "All Offices" resolves to null and the page shows
 * <TcOfficeGate /> asking the user to pick one.
 *
 * List/queue surfaces do NOT use this — they use useTcOfficeScope() and fan
 * out across every office in scope (see features/tc/officeScope.ts).
 */
export function useTcOffice(): OfficeId | null {
  const { office } = useOffice();
  const parsed = OfficeId.safeParse(office);
  return parsed.success ? parsed.data : null;
}

/**
 * Inline prompt, not an error. Four states:
 *  - loading: the office roster hasn't arrived yet
 *  - the roster FETCH FAILED: an error, with a retry
 *  - the roster loaded and is genuinely empty: honest dead end
 *  - otherwise: pick one of this tenant's offices (also the escape hatch on
 *    routes where the sidebar picker is hidden — see TC_SHARED_ROUTES)
 *
 * The failed/empty split is load-bearing, not tidiness. When the roster
 * endpoint 403'd for the hygiene role, this gate reported "No offices
 * configured" on every hygiene page — a sentence about SETUP describing an
 * AUTHORIZATION bug, which is why it survived unnoticed. A fetch that failed
 * must say so and offer a retry; only a roster that actually came back empty
 * may claim the practice has no offices.
 */
export function TcOfficeGate({ loading = false }: { loading?: boolean }) {
  const { offices, setOffice, loading: rosterLoading, error, reload } = useOffice();
  const tcOffices = offices.filter((o) => OfficeId.safeParse(o.officeId).success);

  if ((loading || rosterLoading) && tcOffices.length === 0 && !error) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (error && tcOffices.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 py-24 text-center"
        data-testid="tc-office-roster-error"
      >
        <AlertTriangle size={32} className="text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            Couldn&apos;t load your offices
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            {error} — this is a problem loading the office list, not a sign that your practice has
            none set up.
          </p>
        </div>
        <Button variant="outline" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  }

  if (tcOffices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <Building2 size={32} className="text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            No offices configured
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Your practice has no offices set up for Treatment Coordinator yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <Building2 size={32} className="text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
          Pick an office
        </h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          This screen saves changes to one office at a time. Choose which office
          you&apos;re working in.
        </p>
      </div>
      <div className="flex gap-2">
        {tcOffices.map((o) => (
          <Button key={o.officeId} variant="outline" onClick={() => setOffice(o.officeId)}>
            {o.officeName}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Warning banner for a partially-loaded fan-out (one office failed). */
export function TcPartialDataNotice({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-3 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2"
    >
      <Building2 className="w-4 h-4 shrink-0" /> {message}
    </div>
  );
}

// ── Page header ─────────────────────────────────────────────────────────────

export function TcPageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
          {title}
        </h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────────

export function CaseStatusBadge({ status }: { status: CaseStatusId }) {
  const meta = CASE_STATUSES[status];
  return <Badge variant="outline" className={`border-transparent ${meta.badgeClass}`}>{meta.label}</Badge>;
}

export function PreauthStatusBadge({ status }: { status: PreauthStatusId }) {
  const meta = PREAUTH_STATUSES[status];
  return <Badge variant="outline" className={`border-transparent ${meta.badgeClass}`}>{meta.label}</Badge>;
}

export function UrgencyBadge({ urgency }: { urgency: UrgencyId }) {
  return (
    <Badge variant="outline" className={`border-transparent ${URGENCY_BADGE[urgency]}`}>
      {URGENCY_LABELS[urgency]}
    </Badge>
  );
}

// ── Disabled features (honest "not yet" affordances) ────────────────────────

// `slice5_od` is GONE as of Slice 5: Open Dental reads are live, so a disabled
// "coming later" affordance would now be a lie. An office without an OD
// connection gets the honest OdNotConnected state (features/tc/od/OdShell)
// instead — a real answer about that office, not a promise about the roadmap.
export type DisabledReason = "platform_email" | "slice7_ai";

const DISABLED_COPY: Record<DisabledReason, string> = {
  platform_email: "Coming with platform email",
  slice7_ai: "AI generation coming in Slice 7",
};

/**
 * A visibly-disabled action with an honest tooltip. Used for Send (email),
 * Generate (smile sim), and dictation.
 */
export function DisabledFeatureButton({
  reason,
  children,
  variant = "outline",
  size,
  className,
}: {
  reason: DisabledReason;
  children: ReactNode;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span wrapper so the tooltip fires on a disabled button */}
        <span className={className} tabIndex={0}>
          <Button variant={variant} size={size} disabled aria-disabled className="pointer-events-none w-full">
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{DISABLED_COPY[reason]}</TooltipContent>
    </Tooltip>
  );
}

/** Inline note version for panels/sections that are dark in this slice. */
export function DisabledFeatureNote({ reason }: { reason: DisabledReason }) {
  return <p className="text-xs text-muted-foreground italic">{DISABLED_COPY[reason]}</p>;
}
