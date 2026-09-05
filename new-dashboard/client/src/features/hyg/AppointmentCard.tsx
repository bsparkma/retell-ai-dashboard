/**
 * One appointment, as a card a hygienist taps.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DESIGNED FOR AN iPAD IN LANDSCAPE, HELD AT ARM'S LENGTH, STANDING UP
 * ═════════════════════════════════════════════════════════════════════════════
 * 1180 × 820. That constrains three things and they are not negotiable:
 *
 *   - THE WHOLE CARD IS THE TAP TARGET, and it is at least 88px tall — two
 *     Apple minimums stacked, because the finger doing the tapping has just
 *     come off an instrument tray and the person is not looking at a mouse.
 *   - NOTHING HOVER-ONLY. A tooltip that reveals what a chip means is a chip
 *     that means nothing on a touch screen, so every flag carries its word.
 *   - NO NESTED INTERACTIVE ELEMENTS. A <button> inside a <button> is invalid
 *     HTML and React 19 renders it in a way that guts the outer card's hit
 *     area — a lesson this repo already paid for once in the RCM UX pass.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE THREE-STATE FLAG, WHICH IS THE POINT OF THE CARD
 * ═════════════════════════════════════════════════════════════════════════════
 * "Premed: no" and "we could not find out about premed" are different
 * sentences, and this is the last screen before somebody puts instruments in a
 * mouth. So an unknown flag is drawn in its own tone, with the word "unknown"
 * on it, and it is never drawn the way a clear flag is. A clear flag is not
 * drawn at all — see features/hyg/day.ts `visibleFlags` for why.
 */
import { Link } from "wouter";
import { AlertTriangle, HelpCircle, Clock } from "lucide-react";

import type { HygAppointment, OfficeId } from "@shared/hyg/contract";
import { formatClock, formatLength, visibleFlags } from "@/features/hyg/day";
import { cn } from "@/lib/utils";

/** Where a null field is rendered. One string, so no screen invents a second. */
const UNKNOWN = "Not recorded";

function FlagChip({
  label,
  tone,
}: {
  label: string;
  tone: "alert" | "unknown";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
        tone === "alert"
          ? "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
          : // Deliberately NOT green, and deliberately not the same as any
            // "everything is fine" styling anywhere in this app. Unknown is a
            // question, not a pass.
            "border border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground",
      )}
      data-testid={`hyg-flag-${tone}`}
    >
      {tone === "alert" ? <AlertTriangle size={12} /> : <HelpCircle size={12} />}
      {label}
      {tone === "unknown" ? <span className="sr-only"> — unknown</span> : null}
    </span>
  );
}

export function AppointmentCard({
  appointment,
  office,
  date,
}: {
  appointment: HygAppointment;
  office: OfficeId;
  date: string;
}) {
  const clock = formatClock(appointment.start);
  const length = formatLength(appointment.lengthMin);
  const flags = visibleFlags(appointment.flags);
  const alerts = flags.filter((f) => f.tone === "alert");
  const unknowns = flags.filter((f) => f.tone === "unknown");

  // An appointment with no AptNum cannot be opened — there is nothing to open.
  // It still RENDERS, because a patient who is coming in is more important than
  // a link, and it says why it is not a link rather than looking broken.
  //
  // The office and the date travel WITH the link. An AptNum means a different
  // appointment in each practice's Open Dental database, so a visit URL without
  // an office beside it names nothing — and the visit page refuses one that
  // arrives without it rather than guessing.
  const href =
    appointment.aptNum !== null
      ? `/hyg/visit/${appointment.aptNum}?office=${office}&date=${date}`
      : null;

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-base font-semibold tabular-nums text-foreground">
          {clock ?? UNKNOWN}
        </span>
        {length ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock size={12} />
            {length}
          </span>
        ) : (
          // No Pattern on the appointment. Saying nothing would look like a
          // zero-length visit; saying "30 min" would be a lie the size of the
          // block on screen.
          <span className="text-xs italic text-muted-foreground">Length not recorded</span>
        )}
      </div>

      <div className="mt-1 truncate text-lg font-semibold leading-tight text-foreground">
        {appointment.patientName ?? (
          <span className="italic font-normal text-muted-foreground">Name unavailable</span>
        )}
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
        <span>{appointment.apptTypeLabel ?? "Visit type not recorded"}</span>
        {appointment.providerName ? <span aria-hidden>·</span> : null}
        {appointment.providerName ? <span>{appointment.providerName}</span> : null}
        {appointment.confirmedStatus ? <span aria-hidden>·</span> : null}
        {appointment.confirmedStatus ? <span>{appointment.confirmedStatus}</span> : null}
      </div>

      {flags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {alerts.map((f) => (
            <FlagChip key={f.key} label={f.label} tone="alert" />
          ))}
          {unknowns.length > 0 ? (
            // The unknowns are collapsed into ONE chip rather than five. Five
            // dashed chips on every card in slice 1 (where five flags are not
            // read at all) would train everyone to ignore the row, and the row
            // is the one thing on this card that has to keep being read.
            <FlagChip
              label={
                unknowns.length === 1
                  ? `${unknowns[0].label} unknown`
                  : `${unknowns.length} unknown`
              }
              tone="unknown"
            />
          ) : null}
        </div>
      ) : null}
    </>
  );

  const shell = cn(
    "block min-h-[88px] w-full rounded-xl border bg-card p-3 text-left shadow-sm transition-colors",
    "border-border",
  );

  if (href === null) {
    return (
      <div className={cn(shell, "opacity-80")} data-testid="hyg-appointment-card">
        {body}
        <div className="mt-2 text-xs italic text-muted-foreground">
          No appointment number — this visit cannot be opened.
        </div>
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={cn(shell, "hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-2")}
      data-testid="hyg-appointment-card"
    >
      {body}
    </Link>
  );
}
