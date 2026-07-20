import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider } from "./contexts/AuthContext";
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

function Router() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/calls" component={Calls} />
        <Route path="/calls/:id" component={CallDetail} />
        <Route path="/carein-calls/:id" component={CareInCallDetail} />
        <Route path="/callbacks" component={Callbacks} />
        <Route path="/agents" component={AgentBuilder} />
        <Route path="/scheduling" component={Scheduling} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/admin" component={Admin} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
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
              <OfficeProvider>
                <SlotMarkersProvider>
                  <Toaster position="top-right" />
                  <Router />
                </SlotMarkersProvider>
              </OfficeProvider>
            </RequireAuth>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
