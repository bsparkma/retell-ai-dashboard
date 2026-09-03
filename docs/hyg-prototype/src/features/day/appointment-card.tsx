import { useLocation } from "wouter"
import { ScanLine, Ruler, Stethoscope, Send } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Appointment } from "@/mock/types"
import { getPatient } from "@/mock/patients"
import { ApptStatusPill } from "@/components/state-pill"
import { useAppointmentStatusStore } from "@/store/appointment-status-store"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const PX_PER_MINUTE = 1.6

export function AppointmentCard({ appt, top }: { appt: Appointment; top: number }) {
  const [, navigate] = useLocation()
  const patient = getPatient(appt.patientId)
  const status = useAppointmentStatusStore((s) => s.getStatus(appt.id, appt.status))
  const height = Math.max(appt.lengthMinutes * PX_PER_MINUTE, 56)

  if (!patient) return null

  const icons = [
    appt.xraysDue && { Icon: ScanLine, label: "X-rays due" },
    appt.perioChartDue && { Icon: Ruler, label: "Perio chart due" },
    appt.doctorExamNeeded && { Icon: Stethoscope, label: "Doctor exam needed" },
    appt.hasOpenTcCase && { Icon: Send, label: "Open TC case" },
  ].filter(Boolean) as { Icon: typeof ScanLine; label: string }[]

  return (
    <button
      type="button"
      onClick={() => navigate(`/visit/${appt.id}`)}
      style={{ top, height }}
      className={cn(
        "tap-target absolute left-1 right-1 flex flex-col gap-1 overflow-hidden rounded-lg border bg-card p-2 text-left shadow-sm transition-all hover:shadow-md",
        status === "Done" && "opacity-60",
        status === "In Chair" && "border-primary/50 ring-1 ring-primary/30",
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="truncate text-sm font-semibold text-card-foreground">
          {patient.name} <span className="font-normal text-muted-foreground">({patient.age})</span>
        </p>
      </div>
      <p className="truncate text-xs text-muted-foreground">{appt.type}</p>
      <div className="mt-auto flex items-center justify-between gap-1">
        <ApptStatusPill status={status} />
        {icons.length > 0 && (
          <div className="flex items-center gap-1">
            {icons.map(({ Icon, label }) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <span className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
    </button>
  )
}

export { PX_PER_MINUTE }
