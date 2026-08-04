import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import Home from "@/pages/Home";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider } from "./contexts/AuthContext";
import { ModuleProvider } from "./contexts/ModuleContext";
import { OfficeProvider } from "./contexts/OfficeContext";
import RequireAuth from "./components/RequireAuth";
import DashboardLayout from "./components/DashboardLayout";
import Dashboard from "./pages/Dashboard";
import Calls from "./pages/Calls";
import CallDetail from "./pages/CallDetail";
import CareInCallDetail from "./pages/CareInCallDetail";
import AgentBuilder from "./pages/AgentBuilder";
import Scheduling from "./pages/Scheduling";
import Analytics from "./pages/Analytics";
import Admin from "./pages/Admin";
import Callbacks from "./pages/Callbacks";
import { SlotMarkersProvider } from "./features/slotMarkers";
import { useLocation } from "wouter";
import TcPipeline from "./pages/tc/TcPipeline";
import TcCaseView from "./pages/tc/TcCaseView";
import TcFollowups from "./pages/tc/TcFollowups";
import TcHygieneIntake from "./pages/tc/TcHygieneIntake";
import TcHygieneSubmissions from "./pages/tc/TcHygieneSubmissions";
import TcHygieneInbox from "./pages/tc/TcHygieneInbox";
import TcPreauth from "./pages/tc/TcPreauth";
import TcTemplates from "./pages/tc/TcTemplates";
import TcTemplateEditor from "./pages/tc/TcTemplateEditor";
import TcCommunications from "./pages/tc/TcCommunications";
import TcGallery from "./pages/tc/TcGallery";
import TcPresentation from "./pages/tc/TcPresentation";
import TcLibrary from "./pages/tc/TcLibrary";
import TcCobCalculator from "./pages/tc/TcCobCalculator";
import TcFinancing from "./pages/tc/TcFinancing";
import TcSettings from "./pages/tc/TcSettings";
import TcDashboard from "./pages/tc/TcDashboard";
import TcPrepConsult from "./pages/tc/TcPrepConsult";
import TcPostConsult from "./pages/tc/TcPostConsult";
import TcNurture from "./pages/tc/TcNurture";
import TcGuide from "./pages/tc/TcGuide";
import TcReports from "./pages/tc/TcReports";
import TcFloatingCalc from "./features/tc/cob/FloatingCalc";

// Exported for the routing tests (tests/module-home.test.tsx).
export function Router() {
  const [location] = useLocation();
  // The COB scratchpad floats over every TC page except the patient-facing deck.
  const showFloatingCalc =
    (location === "/tc" || location.startsWith("/tc/")) && !location.startsWith("/tc/present");
  return (
    <DashboardLayout>
      <Switch>
        {/* Hub-first: login lands on the SPA origin, so "/" always redirects
            to the module hub. Deep links to module pages are untouched. */}
        <Route path="/">
          <Redirect to="/home" replace />
        </Route>
        <Route path="/home" component={Home} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/calls" component={Calls} />
        <Route path="/calls/:id" component={CallDetail} />
        <Route path="/carein-calls/:id" component={CareInCallDetail} />
        <Route path="/callbacks" component={Callbacks} />
        <Route path="/agents" component={AgentBuilder} />
        <Route path="/scheduling" component={Scheduling} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/admin" component={Admin} />
        {/* TC module — entitlement-gated server-side (requireModule('tc')). */}
        <Route path="/tc" component={TcPipeline} />
        <Route path="/tc/dashboard" component={TcDashboard} />
        <Route path="/tc/nurture" component={TcNurture} />
        <Route path="/tc/guide" component={TcGuide} />
        <Route path="/tc/reports" component={TcReports} />
        {/* Bare /tc/cases (no id) belongs to the Pipeline — stale links land
            there instead of the 404 page. */}
        <Route path="/tc/cases">
          <Redirect to="/tc" replace />
        </Route>
        <Route path="/tc/cases/:id" component={TcCaseView} />
        <Route path="/tc/cases/:id/prep" component={TcPrepConsult} />
        <Route path="/tc/cases/:id/post-consult" component={TcPostConsult} />
        <Route path="/tc/followups" component={TcFollowups} />
        <Route path="/tc/hygiene" component={TcHygieneIntake} />
        <Route path="/tc/hygiene/submissions" component={TcHygieneSubmissions} />
        <Route path="/tc/hygiene/inbox" component={TcHygieneInbox} />
        <Route path="/tc/preauth" component={TcPreauth} />
        <Route path="/tc/templates" component={TcTemplates} />
        <Route path="/tc/templates/:id" component={TcTemplateEditor} />
        <Route path="/tc/communications" component={TcCommunications} />
        <Route path="/tc/gallery" component={TcGallery} />
        <Route path="/tc/present/:caseId" component={TcPresentation} />
        <Route path="/tc/library" component={TcLibrary} />
        <Route path="/tc/cob" component={TcCobCalculator} />
        <Route path="/tc/financing" component={TcFinancing} />
        <Route path="/tc/settings" component={TcSettings} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
      {showFloatingCalc && <TcFloatingCalc />}
    </DashboardLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <RequireAuth>
              <ModuleProvider>
                <OfficeProvider>
                  <SlotMarkersProvider>
                    <Toaster position="top-right" duration={4000} closeButton />
                    <Router />
                  </SlotMarkersProvider>
                </OfficeProvider>
              </ModuleProvider>
            </RequireAuth>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
