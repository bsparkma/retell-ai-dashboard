import { useLocation } from "wouter"
import { ArrowLeftIcon, PhoneIcon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { Appointment, Patient } from "@/mock/types"

interface VisitHeaderProps {
  appt: Appointment
  patient: Patient
}

export function VisitHeader({ appt, patient }: VisitHeaderProps) {
  const [, navigate] = useLocation()

  return (
    <div className="flex flex-col gap-3 border-b border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/day")} aria-label="Back to day view">
          <ArrowLeftIcon />
        </Button>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground">{patient.name}</h1>
            <span className="text-sm text-muted-foreground">{patient.age}y</span>
            {patient.premedRequired && (
              <Badge variant="destructive" className="gap-1">
                <ShieldAlertIcon data-icon="inline-start" />
                Premed required
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{appt.type}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <PhoneIcon data-icon="inline-start" className="size-3.5" />
              {patient.phone}
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {appt.xraysDue && <Badge variant="secondary">X-rays due</Badge>}
        {appt.perioChartDue && <Badge variant="secondary">Perio due</Badge>}
        {appt.doctorExamNeeded && <Badge variant="secondary">Exam needed</Badge>}
        {appt.hasOpenTcCase && <Badge className="bg-accent text-accent-foreground">Open TC case</Badge>}
      </div>
    </div>
  )
}
