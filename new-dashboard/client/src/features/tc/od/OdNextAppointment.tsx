/**
 * "Next appt:" — the next scheduled Open Dental visit for a linked patient.
 *
 * Ported from the legacy case command bar (TC-app client/src/components/case/
 * CaseCommandBar.tsx), which showed the same line whenever the case carried an
 * odPatientId. Inline and quiet by design: it is context for the coordinator
 * mid-conversation, not a place to act.
 *
 * Renders nothing at all when there is no linked patient — an unlinked case has
 * no appointment to be wrong about. When the office has no OD connection it says
 * so in one line rather than sitting blank, so an empty spot is never mistaken
 * for "no appointment scheduled".
 */
import { useEffect, useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import { CalendarCheck } from "lucide-react";
import { isOdNotConnected, odNextAppointment, type OdNextAppointment as OdNextAppointmentResult } from "../api";
import { cn } from "@/lib/utils";

/** OD sends "yyyy-MM-dd HH:mm:ss" local time — parse it without a UTC shift. */
function formatOdDateTime(value: string): string {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return value;
  const [, y, mo, d, hh, mm] = m;
  const local = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
  if (Number.isNaN(local.getTime())) return value;
  return local.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function OdNextAppointment({
  office,
  patNum,
  className,
}: {
  office: OfficeId;
  patNum: number | null;
  className?: string;
}) {
  const [result, setResult] = useState<OdNextAppointmentResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "not_connected" | "error">("idle");

  useEffect(() => {
    if (!patNum) {
      setState("idle");
      setResult(null);
      return;
    }
    let live = true;
    setState("loading");
    odNextAppointment(office, patNum)
      .then((r) => {
        if (!live) return;
        setResult(r);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setState(isOdNotConnected(e) ? "not_connected" : "error");
      });
    return () => {
      live = false;
    };
  }, [office, patNum]);

  if (!patNum || state === "idle" || state === "loading") return null;

  const base = cn("inline-flex items-center gap-1 text-sm text-muted-foreground", className);

  if (state === "not_connected") {
    return (
      <span className={cn(base, "italic text-muted-foreground/70")}>
        <CalendarCheck size={14} aria-hidden /> OD not connected for this office yet
      </span>
    );
  }
  if (state === "error") {
    // Explicitly "couldn't check", never a silent blank that reads as "none".
    return (
      <span className={base}>
        <CalendarCheck size={14} aria-hidden /> Next appt: couldn’t reach Open Dental
      </span>
    );
  }

  const appt = result?.appointment ?? null;
  return (
    <span className={base} data-testid="od-next-appointment">
      <CalendarCheck size={14} aria-hidden />
      {appt ? (
        <>
          Next appt: {formatOdDateTime(appt.dateTime)}
          {appt.description ? ` · ${appt.description}` : ""}
          {appt.providerName ? ` · ${appt.providerName}` : ""}
        </>
      ) : (
        <>No upcoming appointment in Open Dental</>
      )}
    </span>
  );
}
