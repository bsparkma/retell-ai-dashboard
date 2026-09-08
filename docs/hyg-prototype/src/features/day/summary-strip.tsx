import { Users, Ruler, Stethoscope, FileWarning } from "lucide-react"
import type { Appointment } from "@/mock/types"
import { useStagedWritesStore } from "@/store/staged-writes-store"

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Users
  label: string
  value: number
  tone: "default" | "warning"
}) {
  return (
    <div className="flex flex-1 items-center gap-3 rounded-lg border bg-card p-3">
      <div
        className={
          tone === "warning"
            ? "flex size-10 shrink-0 items-center justify-center rounded-full bg-warning/20 text-warning-foreground"
            : "flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground"
        }
      >
        <Icon className="size-5" />
      </div>
      <div>
        <p className="text-2xl font-semibold leading-none tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export function SummaryStrip({ appointments }: { appointments: Appointment[] }) {
  const writes = useStagedWritesStore((s) => s.writes)

  const patientsToday = appointments.length
  const perioChartsDue = appointments.filter((a) => a.perioChartDue).length
  const examsNeeded = appointments.filter((a) => a.doctorExamNeeded).length
  const apptIds = new Set(appointments.map((a) => a.id))
  const unsentNotes = writes.filter((w) => apptIds.has(w.apptId) && w.state === "Staged").length

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <SummaryCard icon={Users} label="Patients today" value={patientsToday} tone="default" />
      <SummaryCard icon={Ruler} label="Perio charts due" value={perioChartsDue} tone="default" />
      <SummaryCard icon={Stethoscope} label="Exams needed" value={examsNeeded} tone="default" />
      <SummaryCard icon={FileWarning} label="Unsent staged work" value={unsentNotes} tone="warning" />
    </div>
  )
}
