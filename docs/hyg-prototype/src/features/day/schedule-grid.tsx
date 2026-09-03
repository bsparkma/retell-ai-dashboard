import { useEffect, useState } from "react"
import { AppointmentCard, PX_PER_MINUTE } from "@/features/day/appointment-card"
import type { Appointment, Operatory } from "@/mock/types"

const START_MINUTES = 7 * 60 // 7:00
const END_MINUTES = 17 * 60 // 5:00 pm
const GRID_STEP = 10

function minutesNow() {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function formatHourLabel(minutes: number) {
  const h = Math.floor(minutes / 60)
  const period = h >= 12 ? "PM" : "AM"
  const displayHour = h % 12 === 0 ? 12 : h % 12
  return `${displayHour}:00 ${period}`
}

export function ScheduleGrid({ operatories, appointments }: { operatories: Operatory[]; appointments: Appointment[] }) {
  const [now, setNow] = useState(minutesNow())
  const today = new Date().toISOString().slice(0, 10)
  const isToday = appointments[0]?.date === today || appointments.length === 0

  useEffect(() => {
    const interval = setInterval(() => setNow(minutesNow()), 60_000)
    return () => clearInterval(interval)
  }, [])

  const totalHeight = (END_MINUTES - START_MINUTES) * PX_PER_MINUTE
  const hourMarks: number[] = []
  for (let m = START_MINUTES; m <= END_MINUTES; m += 60) hourMarks.push(m)

  const nowTop = (now - START_MINUTES) * PX_PER_MINUTE

  return (
    <div className="flex overflow-x-auto rounded-lg border bg-card">
      <div className="sticky left-0 z-10 w-16 shrink-0 border-r bg-card">
        <div className="h-10 border-b" />
        <div className="relative" style={{ height: totalHeight }}>
          {hourMarks.map((m) => (
            <div
              key={m}
              className="absolute left-0 right-0 border-t px-1.5 text-[11px] text-muted-foreground"
              style={{ top: (m - START_MINUTES) * PX_PER_MINUTE }}
            >
              {formatHourLabel(m)}
            </div>
          ))}
        </div>
      </div>

      {operatories.map((op) => {
        const opAppts = appointments.filter((a) => a.operatoryId === op.id)
        return (
          <div key={op.id} className="w-[220px] shrink-0 border-r last:border-r-0">
            <div className="flex h-10 items-center justify-center border-b bg-secondary/50 text-sm font-medium">
              {op.name}
            </div>
            <div className="relative" style={{ height: totalHeight }}>
              {hourMarks.map((m) => (
                <div
                  key={m}
                  className="absolute left-0 right-0 border-t border-border/60"
                  style={{ top: (m - START_MINUTES) * PX_PER_MINUTE }}
                />
              ))}
              {Array.from({ length: Math.ceil((END_MINUTES - START_MINUTES) / GRID_STEP) }).map((_, i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 border-t border-border/25"
                  style={{ top: i * GRID_STEP * PX_PER_MINUTE }}
                />
              ))}
              {isToday && nowTop >= 0 && nowTop <= totalHeight && (
                <div className="absolute left-0 right-0 z-20 border-t-2 border-destructive" style={{ top: nowTop }}>
                  <span className="absolute -left-1 -top-1.5 size-3 rounded-full bg-destructive" />
                </div>
              )}
              {opAppts.map((appt) => (
                <AppointmentCard key={appt.id} appt={appt} top={(appt.startMinutes - START_MINUTES) * PX_PER_MINUTE} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
