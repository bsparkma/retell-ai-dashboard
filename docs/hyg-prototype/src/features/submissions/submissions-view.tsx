import { useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InboxIcon } from "lucide-react"
import { useAppStore } from "@/store/app-store"
import { submissionsForOffice } from "@/mock/submissions"
import { getPatient } from "@/mock/patients"
import { hygienists } from "@/mock/offices"
import type { Submission, SubmissionStatus } from "@/mock/types"

const COLUMNS: { status: SubmissionStatus; label: string }[] = [
  { status: "Pending TC", label: "Pending TC" },
  { status: "Presented", label: "Presented" },
  { status: "Accepted", label: "Accepted" },
  { status: "Lost", label: "Lost" },
]

const urgencyStyles: Record<Submission["urgency"], string> = {
  Routine: "bg-secondary text-secondary-foreground",
  Soon: "bg-warning/20 text-warning-foreground border border-warning/40",
  Urgent: "bg-destructive/15 text-destructive border border-destructive/30",
}

function SubmissionCard({ submission }: { submission: Submission }) {
  const patient = getPatient(submission.patientId)
  const hygienist = hygienists.find((h) => h.id === submission.hygienistId)
  return (
    <Card className="shadow-none">
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">{patient?.name ?? "Unknown patient"}</p>
          <Badge className={urgencyStyles[submission.urgency]}>{submission.urgency}</Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{submission.category}</span>
          <span aria-hidden="true">·</span>
          <span>{submission.date}</span>
        </div>
        <p className="text-xs text-muted-foreground">Flagged by {hygienist?.name ?? "—"}</p>
      </CardContent>
    </Card>
  )
}

export function SubmissionsView() {
  const officeId = useAppStore((s) => s.officeId)
  const submissions = useMemo(() => submissionsForOffice(officeId), [officeId])

  if (submissions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty className="max-w-md border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>No submissions yet</EmptyTitle>
            <EmptyDescription>TC handoffs staged from the Findings tab will show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Treatment coordinator submissions</h1>
        <p className="text-sm text-muted-foreground">Cases flagged by hygiene, tracked through to acceptance.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {COLUMNS.map((col) => {
          const items = submissions.filter((s) => s.status === col.status)
          return (
            <div key={col.status} className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">{col.label}</h2>
                <Badge variant="secondary">{items.length}</Badge>
              </div>
              <div className="flex flex-col gap-3">
                {items.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">Empty</p>
                ) : (
                  items.map((s) => <SubmissionCard key={s.id} submission={s} />)
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
