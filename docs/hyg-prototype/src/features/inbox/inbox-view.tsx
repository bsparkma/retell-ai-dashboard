import { useMemo } from "react"
import { Link } from "wouter"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ClipboardListIcon, StethoscopeIcon, CalendarClockIcon } from "lucide-react"
import { useAppStore } from "@/store/app-store"
import { useVisitStore } from "@/store/visit-store"
import { appointmentsForOffice } from "@/mock/appointments"
import { getPatient } from "@/mock/patients"

interface InboxItem {
  apptId: string
  patientName: string
  kind: "doctor-exam" | "schedule" | "front-desk"
  detail: string
}

export function InboxView() {
  const officeId = useAppStore((s) => s.officeId)
  const visitData = useVisitStore((s) => s.data)

  const items = useMemo<InboxItem[]>(() => {
    const results: InboxItem[] = []
    const appts = appointmentsForOffice(officeId)
    for (const appt of appts) {
      const visit = visitData[appt.id]
      const patient = getPatient(appt.patientId)
      if (!patient) continue

      if (appt.doctorExamNeeded && visit?.router.examStatus !== "Completed") {
        results.push({
          apptId: appt.id,
          patientName: patient.name,
          kind: "doctor-exam",
          detail: "Doctor exam needed before checkout",
        })
      }
      if (visit?.router.treatmentToSchedule) {
        results.push({
          apptId: appt.id,
          patientName: patient.name,
          kind: "schedule",
          detail: visit.router.treatmentToSchedule,
        })
      }
      if (visit?.router.frontDeskNotes) {
        results.push({
          apptId: appt.id,
          patientName: patient.name,
          kind: "front-desk",
          detail: visit.router.frontDeskNotes,
        })
      }
    }
    return results
  }, [officeId, visitData])

  const iconFor: Record<InboxItem["kind"], typeof StethoscopeIcon> = {
    "doctor-exam": StethoscopeIcon,
    schedule: CalendarClockIcon,
    "front-desk": ClipboardListIcon,
  }

  const labelFor: Record<InboxItem["kind"], string> = {
    "doctor-exam": "Doctor exam",
    schedule: "To schedule",
    "front-desk": "Front desk",
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty className="max-w-md border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardListIcon />
            </EmptyMedia>
            <EmptyTitle>Inbox is clear</EmptyTitle>
            <EmptyDescription>
              Items needing doctor exams, scheduling, or front-desk attention will appear here as visits are worked.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Inbox</h1>
        <p className="text-sm text-muted-foreground">Items surfaced from today&apos;s visits that need follow-up.</p>
      </div>
      <div className="flex flex-col gap-3">
        {items.map((item, i) => {
          const Icon = iconFor[item.kind]
          return (
            <Card key={i} className="shadow-none">
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{item.patientName}</p>
                      <Badge variant="secondary">{labelFor[item.kind]}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.detail}</p>
                  </div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/visit/${item.apptId}`}>Open visit</Link>
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
