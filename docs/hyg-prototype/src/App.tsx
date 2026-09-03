import { Route, Switch, Redirect } from "wouter"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { AppShell } from "@/features/shell/app-shell"
import { DayView } from "@/features/day/day-view"
import { VisitWorkspace } from "@/features/visit/visit-workspace"
import { InboxView } from "@/features/inbox/inbox-view"
import { SubmissionsView } from "@/features/submissions/submissions-view"
import { TemplatesView } from "@/features/templates/templates-view"
import { SettingsView } from "@/features/settings/settings-view"

export default function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <AppShell>
        <Switch>
          <Route path="/" component={() => <Redirect to="/day" />} />
          <Route path="/day" component={DayView} />
          <Route path="/visit/:apptId" component={VisitWorkspace} />
          <Route path="/inbox" component={InboxView} />
          <Route path="/submissions" component={SubmissionsView} />
          <Route path="/templates" component={TemplatesView} />
          <Route path="/settings" component={SettingsView} />
          <Route>
            <div className="flex h-full items-center justify-center text-muted-foreground">Page not found.</div>
          </Route>
        </Switch>
      </AppShell>
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}
