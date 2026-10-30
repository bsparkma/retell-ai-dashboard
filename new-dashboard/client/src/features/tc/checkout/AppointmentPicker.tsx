/**
 * CO-4a — the "Scheduled" appointment picker, and the anchor line it leaves.
 *
 * Tapping Scheduled opens this picker: the patient's UPCOMING Open Dental
 * appointments (read by the server for the stored checkout's office and
 * patient), plus "Not in Open Dental yet", which is always there. Picking one
 * answers Scheduled with that appointment as its anchor, in one action. When
 * the read fails the picker SAYS so — "Couldn't load appointments from Open
 * Dental", with Retry — and "Not in Open Dental yet" is still a way through.
 * It is never a silent empty list.
 *
 * The same picker, in "link" mode, links an appointment later to a Scheduled
 * checkout that has none (or changes / clears the one it has).
 *
 * The anchor line renders what the SERVER stored: "Scheduled → Tue, Nov 4,
 * 9:00 AM", or "No appointment linked" with "Link appointment".
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CalendarPlus, Link2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { tcErrorMessage } from "@/features/tc/api";
import { linkCheckoutAppointment, listCheckoutAppointments } from "@/features/tc/checkout/checkoutApi";
import {
  appointmentWhenLabel,
  type TcCheckoutHandoff,
  type TcCheckoutUpcomingAppointment,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

/** "Dr. DOC1 · Crown prep · Op 4". Pure. */
export function appointmentDetail(a: Pick<TcCheckoutUpcomingAppointment, "provider" | "appointmentType" | "operatory">): string {
  return [a.provider, a.appointmentType, a.operatory].filter(Boolean).join(" · ");
}

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; appointments: TcCheckoutUpcomingAppointment[] };

export interface AppointmentPickerProps {
  open: boolean;
  office: OfficeId;
  handoffId: string;
  /** "outcome": answering Scheduled now. "link": a Scheduled checkout, later. */
  mode: "outcome" | "link";
  /** The appointment already linked, in link mode (to mark it, and to offer Unlink). */
  currentAptNum?: number | null;
  busy?: boolean;
  onClose: () => void;
  /** The choice: an AptNum, or null ("Not in Open Dental yet" / "Unlink"). */
  onPick: (aptNum: number | null) => void;
}

export function AppointmentPicker({ open, office, handoffId, mode, currentAptNum = null, busy = false, onClose, onPick }: AppointmentPickerProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const fetchList = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      setLoad({ state: "ready", appointments: await listCheckoutAppointments(office, handoffId) });
    } catch {
      setLoad({ state: "failed", message: "Couldn't load appointments from Open Dental" });
    }
  }, [office, handoffId]);

  useEffect(() => {
    if (open) void fetchList();
  }, [open, fetchList]);

  return (
    <Dialog open={open} onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogContent className="max-w-lg" data-testid="appointment-picker">
        <DialogHeader>
          <DialogTitle>{mode === "outcome" ? "Which appointment was booked?" : "Link the appointment"}</DialogTitle>
          <DialogDescription>
            The patient&apos;s upcoming appointments in this office&apos;s Open Dental. Pick the one that was just booked.
          </DialogDescription>
        </DialogHeader>

        {load.state === "loading" && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground" data-testid="appointment-picker-loading">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading appointments from Open Dental…
          </p>
        )}

        {load.state === "failed" && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300"
            data-testid="appointment-picker-error"
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {load.message}
            </span>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void fetchList()} data-testid="appointment-picker-retry">
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </Button>
          </div>
        )}

        {load.state === "ready" && (
          load.appointments.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground" data-testid="appointment-picker-none">
              Open Dental has no upcoming appointment for this patient.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border" data-testid="appointment-picker-list">
              {load.appointments.map((a) => (
                <li key={a.aptNum}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPick(a.aptNum)}
                    className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/60 disabled:opacity-60"
                    data-testid="appointment-picker-option"
                    data-apt-num={a.aptNum}
                  >
                    <CalendarClock className="mt-0.5 w-4 h-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        {appointmentWhenLabel(a.dateTime)}
                        {a.aptNum === currentAptNum ? <span className="ml-2 text-xs font-normal text-muted-foreground">(linked now)</span> : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">{appointmentDetail(a) || "No details in Open Dental"}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          {mode === "outcome" ? (
            <Button variant="outline" disabled={busy} onClick={() => onPick(null)} data-testid="appointment-picker-not-in-od">
              Not in Open Dental yet
            </Button>
          ) : currentAptNum !== null ? (
            <Button variant="outline" disabled={busy} onClick={() => onPick(null)} data-testid="appointment-picker-unlink">
              Unlink this appointment
            </Button>
          ) : (
            <span />
          )}
          {busy ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Saving…
            </span>
          ) : (
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A Scheduled checkout's appointment, as stored: "Scheduled → <when>" or "No
 * appointment linked", with "Link appointment" (or "Change") when allowed.
 * `canLink` is UX only; the server re-checks that the case is still taking a
 * link.
 */
export function AppointmentAnchorLine({
  office,
  handoff,
  canLink,
  onLinked,
}: {
  office: OfficeId;
  handoff: TcCheckoutHandoff;
  canLink: boolean;
  onLinked: (next: TcCheckoutHandoff) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (handoff.status !== "scheduled") return null;
  const a = handoff.appointment;

  const pick = async (aptNum: number | null) => {
    setBusy(true);
    try {
      const next = await linkCheckoutAppointment(office, handoff.handoffId, aptNum);
      onLinked(next);
      toast.success(aptNum === null ? "Appointment unlinked" : "Appointment linked");
      setPicking(false);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="appointment-anchor">
      {a ? (
        <span data-testid="appointment-anchor-when">
          <span className="font-medium text-foreground">Scheduled → {appointmentWhenLabel(a.dateTime)}</span>
          {appointmentDetail(a) ? <span className="text-muted-foreground"> · {appointmentDetail(a)}</span> : null}
        </span>
      ) : (
        <span className="text-amber-700 dark:text-amber-300" data-testid="appointment-anchor-none">No appointment linked</span>
      )}
      {canLink && (
        <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => setPicking(true)} data-testid="appointment-anchor-link">
          {a ? <Link2 className="w-3.5 h-3.5" /> : <CalendarPlus className="w-3.5 h-3.5" />}
          {a ? "Change" : "Link appointment"}
        </Button>
      )}
      <AppointmentPicker
        open={picking}
        office={office}
        handoffId={handoff.handoffId}
        mode="link"
        currentAptNum={a ? a.aptNum : null}
        busy={busy}
        onClose={() => setPicking(false)}
        onPick={(n) => void pick(n)}
      />
    </div>
  );
}
