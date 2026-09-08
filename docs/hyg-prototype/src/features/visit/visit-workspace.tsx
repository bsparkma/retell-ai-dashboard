import { useState } from "react"
import { useParams } from "wouter"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { getAppointment } from "@/mock/appointments"
import { getPatient } from "@/mock/patients"
import { VisitHeader } from "./visit-header"
import { RouterTab } from "./router/router-tab"
import { PerioTab } from "./perio/perio-tab"
import { FindingsTab } from "./findings/findings-tab"
import { OrthoTab } from "./ortho/ortho-tab"
import { NotesTab } from "./notes/notes-tab"
import { FinishTab } from "./finish/finish-tab"
import { StagedWritesDrawer } from "@/components/staged-writes-drawer"

const tabTriggerClass =
  "h-12 rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"

export function VisitWorkspace() {
  const { apptId } = useParams<{ apptId: string }>()
  const [tab, setTab] = useState("router")

  const appt = apptId ? getAppointment(apptId) : undefined
  const patient = appt ? getPatient(appt.patientId) : undefined

  if (!appt || !patient) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Appointment not found.</div>
  }

  const showOrtho = appt.type === "Ortho Adj" || patient.orthoPatient

  return (
    <div className="flex h-full flex-col">
      <VisitHeader appt={appt} patient={patient} />

      <div className="flex flex-1 overflow-hidden">
        <Tabs value={tab} onValueChange={setTab} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border bg-card px-6">
            <TabsList className="h-12 bg-transparent p-0">
              <TabsTrigger value="router" className={tabTriggerClass}>
                Router
              </TabsTrigger>
              <TabsTrigger value="perio" className={tabTriggerClass}>
                Perio
              </TabsTrigger>
              <TabsTrigger value="findings" className={tabTriggerClass}>
                Findings
              </TabsTrigger>
              {showOrtho && (
                <TabsTrigger value="ortho" className={tabTriggerClass}>
                  Ortho
                </TabsTrigger>
              )}
              <TabsTrigger value="notes" className={tabTriggerClass}>
                Notes
              </TabsTrigger>
              <TabsTrigger value="finish" className={tabTriggerClass}>
                Finish
              </TabsTrigger>
            </TabsList>
            <StagedWritesDrawer apptId={appt.id} />
          </div>

          <TabsContent value="router" className="mt-0 flex-1 overflow-y-auto">
            <RouterTab appt={appt} patient={patient} />
          </TabsContent>
          <TabsContent value="perio" className="mt-0 flex-1 overflow-hidden">
            <PerioTab appt={appt} patientId={patient.id} />
          </TabsContent>
          <TabsContent value="findings" className="mt-0 flex-1 overflow-y-auto">
            <FindingsTab
              appt={appt}
              patient={patient}
              onEditOnRouter={() => setTab("router")}
              onOpenOrtho={showOrtho ? () => setTab("ortho") : undefined}
            />
          </TabsContent>
          {showOrtho && (
            <TabsContent value="ortho" className="mt-0 flex-1 overflow-y-auto">
              <OrthoTab appt={appt} patient={patient} />
            </TabsContent>
          )}
          <TabsContent value="notes" className="mt-0 flex-1 overflow-y-auto">
            <NotesTab appt={appt} patient={patient} />
          </TabsContent>
          <TabsContent value="finish" className="mt-0 flex-1 overflow-y-auto">
            <FinishTab appt={appt} patient={patient} onJumpToRouter={() => setTab("router")} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
