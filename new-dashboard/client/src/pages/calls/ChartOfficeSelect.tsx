/**
 * Which practice's chart (or patient list) a call action is aimed at.
 *
 * A call belongs to the office it rang at, permanently — that is its identity and
 * nothing here changes it. But the front desk at one practice regularly handles a
 * call about a patient of the other, and until now that was a dead end: the patient
 * search only ever looked in the call's own Open Dental, so the patient could not
 * be found and the call could not be charted anywhere at all.
 *
 * So this control names two different things and keeps them apart on screen:
 *
 *   ORIGIN — the office the call rang at. Fixed. Shown, never chosen.
 *   TARGET — the office whose records we are reading or writing. Defaults to the
 *            origin; a human may deliberately pick the other one.
 *
 * When they differ the mismatch is stated in words, every time, and stays on screen
 * for as long as it is true — a cross-office write should be something the person
 * read and meant, not something they discover afterwards in a chart.
 *
 * Offices that cannot reach Open Dental are not offered: picking one would only
 * produce a refusal at the moment of sending, which is the worst possible time.
 */
import { Building2, ArrowRightLeft } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { type OfficeConfig } from "@/lib/api";

interface ChartOfficeSelectProps {
  /** Every office this tenant has; only the OD-connected ones become options. */
  offices: OfficeConfig[];
  /** The office currently targeted, or null while the server's default is still loading. */
  value: string | null;
  onChange: (officeId: string) => void;
  /** The office the CALL rang at — the origin. Null when the call is unattributed. */
  callOfficeId: string | null;
  disabled?: boolean;
  /** "chart" (writing) or "patients" (searching) — only changes the label wording. */
  purpose?: "chart" | "patients";
  /** Test hook for the trigger. */
  testId?: string;
}

/** The offices worth offering: reachable Open Dental only. */
export function selectableOffices(offices: OfficeConfig[]): OfficeConfig[] {
  return offices.filter((o) => o.odConnected && o.officeId !== "unknown");
}

/** Display name for an office id, falling back to the raw key rather than to nothing. */
export function officeNameOf(offices: OfficeConfig[], officeId: string | null): string {
  if (!officeId) return "an unmapped line";
  return offices.find((o) => o.officeId === officeId)?.officeName ?? officeId;
}

export function ChartOfficeSelect({
  offices, value, onChange, callOfficeId, disabled, purpose = "chart", testId,
}: ChartOfficeSelectProps) {
  const options = selectableOffices(offices);
  // Nothing to choose between is not a choice. Disabled, never hidden — the office
  // still has to be named, because the patient's name alone does not say which
  // practice's database they live in.
  const noChoice = options.length < 2;

  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor="chart-office"
        className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap"
      >
        {purpose === "patients" ? "Search office" : "Chart office"}
      </label>
      <Select
        value={value ?? undefined}
        onValueChange={onChange}
        disabled={disabled || noChoice}
      >
        <SelectTrigger id="chart-office" className="h-8 text-xs flex-1" data-testid={testId ?? "chart-office-select"}>
          <SelectValue placeholder="Loading…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.officeId} value={o.officeId} className="text-xs">
              {o.officeName}
              {o.officeId === callOfficeId && (
                <span className="text-muted-foreground"> · this call</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The persistent cross-office warning.
 *
 * Renders ONLY when the target really differs from the origin, so its presence is
 * information rather than furniture. It is not dismissible and does not fade: it is
 * true for as long as the selection is, and the moment it stops being shown is the
 * moment it stops being true.
 */
export function CrossOfficeNotice({
  offices, callOfficeId, targetOfficeId, purpose = "chart",
}: {
  offices: OfficeConfig[];
  callOfficeId: string | null;
  targetOfficeId: string | null;
  purpose?: "chart" | "patients";
}) {
  if (!targetOfficeId || !callOfficeId || targetOfficeId === callOfficeId) return null;
  const origin = officeNameOf(offices, callOfficeId);
  const target = officeNameOf(offices, targetOfficeId);
  return (
    <div
      data-testid="cross-office-warning"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-900 dark:text-amber-200"
    >
      <ArrowRightLeft size={13} className="flex-shrink-0 mt-0.5" />
      <span>
        This call came in at <span className="font-medium">{origin}</span> — you&apos;re{" "}
        {purpose === "patients" ? (
          <>searching <span className="font-medium">{target}</span> patients.</>
        ) : (
          <>writing to a <span className="font-medium">{target}</span> chart.</>
        )}
      </span>
    </div>
  );
}

/** The plain "which chart" line shown when origin and target agree. */
export function SameOfficeLine({ officeName, patientId }: { officeName: string; patientId?: number | null }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground rounded-md border border-border/60 px-2.5 py-1.5">
      <Building2 size={12} className="flex-shrink-0" />
      <span>
        Writing to <span className="font-medium text-foreground">{officeName}</span>
        {patientId ? <> · PatNum {patientId}</> : null}
      </span>
    </div>
  );
}
