import { useLocation } from "wouter"
import { ArrowRight, Clock } from "lucide-react"
import type { Appointment } from "@/mock/types"
import { getPatient } from "@/mock/patients"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

function formatTime(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const period = h >= 12 ? "PM" : "AM"
  const displayHour = h % 12 === 0 ? 12 : h % 12
  return `${displayHour}:${m.toString().padStart(2, "0")} ${period}`
}

export function UpNextPanel({ appointments }: { appointments: Appointment[] }) {
  const [, navigate] = useLocation()
  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()

  const upNext = appointments
    .filter((a) => a.startMinutes >= nowMinutes && a.status !== "Done")
    .sort((a, b) => a.startMinutes - b.startMinutes)
    .slice(0, 3)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Up next</CardTitle>
      </CardHeader>
      <CardContent>
        {upNext.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock />
              </EmptyMedia>
              <EmptyTitle>All caught up</EmptyTitle>
              <EmptyDescription>No more hygiene visits scheduled for the rest of the day.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {upNext.map((appt) => {
              const patient = getPatient(appt.patientId)
              if (!patient) return null
              return (
                <li key={appt.id}>
                  <Button
                    variant="outline"
                    className="tap-target h-auto w-full justify-between gap-3 py-2.5"
                    onClick={() => navigate(`/visit/${appt.id}`)}
                  >
                    <span className="flex flex-col items-start gap-0.5 text-left">
                      <span className="font-medium">{patient.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatTime(appt.startMinutes)} · {appt.type}
                      </span>
                    </span>
                    <ArrowRight data-icon="inline-end" className="text-muted-foreground" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
