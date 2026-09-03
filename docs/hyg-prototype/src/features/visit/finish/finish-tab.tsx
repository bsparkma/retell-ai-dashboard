import { useState } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { AlertTriangleIcon, CheckCircle2Icon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { WriteStatePill } from "@/components/state-pill"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useStagedWritesStore } from "@/store/staged-writes-store"
import { useAppointmentStatusStore } from "@/store/appointment-status-store"
import { useVisitStore } from "@/store/visit-store"
import type { Appointment, Patient } from "@/mock/types"

interface FinishTabProps {
  appt: Appointment
  patient: Patient
  onJumpToRouter?: () => void
}

export function FinishTab({ appt, patient, onJumpToRouter }: FinishTabProps) {
  const [, navigate] = useLocation()
  const writes = useStagedWritesStore(useShallow((s) => s.writes.filter((w) => w.apptId === appt.id)))
  const sendAll = useStagedWritesStore((s) => s.sendAll)
  const retry = useStagedWritesStore((s) => s.retry)
  const setStatus = useAppointmentStatusStore((s) => s.setStatus)
  const router = useVisitStore((s) => s.getVisit(appt.id).router)
  const treatmentItems = useVisitStore((s) => s.getVisit(appt.id).treatmentItems)
  const [sending, setSending] = useState(false)

  const recareScheduled = router.recareScheduled
  const txEnteredInOD = router.txEnteredInOD
  const hardChecksAnswered = recareScheduled !== "" && txEnteredInOD !== ""
  const postOrthoCount = treatmentItems.filter((t) => t.tags?.includes("post-ortho")).length

  const allWritten = writes.length > 0 && writes.every((w) => w.state === "Written")
  const hasFailed = writes.some((w) => w.state === "Failed")

  async function handleSendAll() {
    setSending(true)
    await sendAll(appt.id)
    setSending(false)
  }

  function handleFinishVisit() {
    setStatus(appt.id, "Done")
    toast.success(`Visit complete for ${patient.name}`)
    navigate("/day")
  }

  if (writes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty className="max-w-md border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SendIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing staged yet</EmptyTitle>
            <EmptyDescription>Stage a router slip, perio chart, findings handoff, or note from the other tabs first.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">Review before sending</h2>
        <Button onClick={handleSendAll} disabled={sending || allWritten || !hardChecksAnswered} className="h-11">
          <SendIcon data-icon="inline-start" />
          {sending ? "Sending…" : allWritten ? "All sent" : "Send all to Open Dental"}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {[
          { label: "Recare scheduled", value: recareScheduled },
          { label: "TX entered in OD", value: txEnteredInOD },
        ].map(({ label, value }) => {
          const unanswered = value === ""
          return (
            <button
              key={label}
              type="button"
              onClick={onJumpToRouter}
              disabled={!unanswered || !onJumpToRouter}
              className={cn(
                "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm",
                unanswered
                  ? "border-destructive bg-destructive/10 text-destructive"
                  : "border-border bg-secondary/30 text-foreground",
                unanswered && onJumpToRouter && "cursor-pointer hover:bg-destructive/15",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                {unanswered && <AlertTriangleIcon className="size-4" />}
                {label}
              </span>
              <span>{unanswered ? "Not answered — tap to fix" : value}</span>
            </button>
          )
        })}
        {postOrthoCount > 0 && (
          <p className="text-sm text-muted-foreground">Post-ortho watch items created: {postOrthoCount}</p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {writes.map((write) => (
          <Card key={write.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-sm">{write.title}</CardTitle>
                <p className="text-sm text-muted-foreground">{write.summary}</p>
              </div>
              <WriteStatePill state={write.state} />
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                {write.preview.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {write.state === "Failed" && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2">
                  <p className="text-sm text-destructive">{write.errorMessage}</p>
                  <Button size="sm" variant="outline" onClick={() => retry(write.id)}>
                    Retry
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t border-border bg-card px-6 py-4">
        <p className="text-sm text-muted-foreground">
          {allWritten
            ? "Everything is written to Open Dental."
            : hasFailed
              ? "Retry failed items before finishing this visit."
              : "Send everything, then finish the visit."}
        </p>
        <Button size="lg" className="h-11" onClick={handleFinishVisit} disabled={!allWritten}>
          <CheckCircle2Icon data-icon="inline-start" />
          Finish visit
        </Button>
      </div>
    </div>
  )
}
