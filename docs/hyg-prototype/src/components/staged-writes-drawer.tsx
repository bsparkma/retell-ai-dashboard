import { useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { ListChecks, RotateCcw } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { WriteStatePill } from "@/components/state-pill"
import { useStagedWritesStore } from "@/store/staged-writes-store"

const kindLabels: Record<string, string> = {
  router: "Router",
  perio: "Perio exam",
  note: "Clinical note",
  "tc-handoff": "TC handoff",
}

export function StagedWritesDrawer({ apptId }: { apptId: string }) {
  const [open, setOpen] = useState(false)
  const writes = useStagedWritesStore(useShallow((s) => s.writes.filter((w) => w.apptId === apptId)))
  const retry = useStagedWritesStore((s) => s.retry)

  const pendingCount = writes.filter((w) => w.state === "Staged" || w.state === "Failed").length

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="relative gap-2">
          <ListChecks data-icon="inline-start" />
          Staged writes
          {pendingCount > 0 && (
            <span className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {pendingCount}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Staged writes for this visit</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 px-4">
          {writes.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListChecks />
                </EmptyMedia>
                <EmptyTitle>Nothing staged yet</EmptyTitle>
                <EmptyDescription>
                  Router, Perio, Notes, and Findings each add an item here when you stage them. Nothing leaves the
                  device until Finish → Review → Send.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-3 py-4">
              {writes.map((w) => (
                <li key={w.id} className="rounded-lg border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">{kindLabels[w.kind]}</p>
                      <p className="text-sm font-semibold text-card-foreground">{w.title}</p>
                    </div>
                    <WriteStatePill state={w.state} />
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">{w.summary}</p>
                  {w.state === "Failed" && (
                    <>
                      <p className="mt-2 text-xs text-destructive">{w.errorMessage}</p>
                      <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => retry(w.id)}>
                        <RotateCcw data-icon="inline-start" />
                        Retry
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
