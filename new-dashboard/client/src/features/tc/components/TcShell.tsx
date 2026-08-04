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
import { Building2 } from "lucide-react";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { CASE_STATUSES, PREAUTH_STATUSES, URGENCY_BADGE, URGENCY_LABELS } from "../status";
import type { CaseStatusId, PreauthStatusId, UrgencyId } from "../status";

// ── Office narrowing ────────────────────────────────────────────────────────

/**
 * The global office picker allows "all" (and future offices); every /api/tc
 * call requires a concrete 'roland' | 'valley'. Returns null when the current
 * selection can't be used — pages render <TcOfficeGate /> in that state.
 */
export function useTcOffice(): OfficeId | null {
  const { office } = useOffice();
  const parsed = OfficeId.safeParse(office);
  return parsed.success ? parsed.data : null;
}

export function TcOfficeGate() {
  const { offices, setOffice } = useOffice();
  const tcOffices = offices.filter((o) => OfficeId.safeParse(o.officeId).success);
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <Building2 size={32} className="text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
          Pick an office
        </h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          Treatment Coordinator works one office at a time. Choose an office to
          see its cases.
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

export type DisabledReason = "platform_email" | "slice5_od" | "slice7_ai";

const DISABLED_COPY: Record<DisabledReason, string> = {
  platform_email: "Coming with platform email",
  slice5_od: "Open Dental linking coming in Slice 5",
  slice7_ai: "AI generation coming in Slice 7",
};

/**
 * A visibly-disabled action with an honest tooltip. Used for Send (email),
 * Generate (smile sim), Pull from Open Dental, and dictation.
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
