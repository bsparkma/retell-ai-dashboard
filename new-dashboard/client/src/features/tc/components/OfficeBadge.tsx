/**
 * Location badge for TC list rows — DentaFlow's "both" mode badge.
 *
 * Rendered ONLY when the global picker is on All Offices and more than one
 * office is in scope (callers pass `showOfficeBadges` from useTcOfficeScope).
 * In single-office mode every row is that office, so the badge is noise.
 *
 * Purely presentational on purpose: it reads no context, so list components
 * stay testable without an OfficeProvider.
 */
import type { OfficeId } from "@shared/tc/contract";
import { Badge } from "@/components/ui/badge";
import { MapPin } from "lucide-react";
import { tcOfficeLabel } from "../officeScope";

const OFFICE_CLASS: Record<OfficeId, string> = {
  roland: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  valley: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
};

export function OfficeBadge({
  officeId,
  className = "",
}: {
  officeId: OfficeId;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-testid="office-badge"
      className={`border-transparent gap-1 ${OFFICE_CLASS[officeId]} ${className}`}
    >
      <MapPin className="w-3 h-3" />
      {tcOfficeLabel(officeId)}
    </Badge>
  );
}

/** Convenience: render the badge only when the current scope wants badges. */
export function OfficeBadgeWhen({
  show,
  officeId,
  className,
}: {
  show: boolean;
  officeId: OfficeId;
  className?: string;
}) {
  if (!show) return null;
  return <OfficeBadge officeId={officeId} className={className} />;
}
