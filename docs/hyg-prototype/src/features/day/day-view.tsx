import { useMemo } from "react"
import { useAppStore } from "@/store/app-store"
import { appointmentsForOffice } from "@/mock/appointments"
import { operatoriesForOffice } from "@/mock/offices"
import { SummaryStrip } from "@/features/day/summary-strip"
import { UpNextPanel } from "@/features/day/up-next-panel"
import { ScheduleGrid } from "@/features/day/schedule-grid"
import { useAppointmentStatusStore } from "@/store/appointment-status-store"

export function DayView() {
  const officeId = useAppStore((s) => s.officeId)
  const date = useAppStore((s) => s.date)
  const hygienistId = useAppStore((s) => s.hygienistId)
  const statusOverrides = useAppointmentStatusStore((s) => s.overrides)

  const hygieneAppointments = useMemo(() => {
    return appointmentsForOffice(officeId)
      .filter((a) => a.isHygiene && a.date === date)
      .filter((a) => hygienistId === "all" || a.hygienistId === hygienistId)
      .map((a) => ({ ...a, status: statusOverrides[a.id] ?? a.status }))
  }, [officeId, date, hygienistId, statusOverrides])

  const hygieneOperatories = useMemo(
    () => operatoriesForOffice(officeId).filter((o) => o.isHygiene),
    [officeId],
  )

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Hygiene Day View</h1>
        <p className="text-sm text-muted-foreground">
          {new Date(date + "T00:00:00").toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      <SummaryStrip appointments={hygieneAppointments} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <ScheduleGrid operatories={hygieneOperatories} appointments={hygieneAppointments} />
        <UpNextPanel appointments={hygieneAppointments} />
      </div>
    </div>
  )
}
