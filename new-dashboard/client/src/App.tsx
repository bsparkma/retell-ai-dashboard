import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SocketProvider } from "./contexts/SocketContext";
import DashboardLayout from "./components/DashboardLayout";
import Dashboard from "./pages/Dashboard";
import LiveMonitor from "./pages/LiveMonitor";
import Calls from "./pages/Calls";
import CallDetail from "./pages/CallDetail";
import AgentBuilder from "./pages/AgentBuilder";
import Calendar from "./pages/Calendar";
import Callbacks from "./pages/Callbacks";
import Analytics from "./pages/Analytics";
import Admin from "./pages/Admin";

function Router() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/live" component={LiveMonitor} />
        <Route path="/calls" component={Calls} />
        <Route path="/calls/:id" component={CallDetail} />
        <Route path="/agents" component={AgentBuilder} />
        <Route path="/calendar" component={Calendar} />
        <Route path="/callbacks" component={Callbacks} />
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
        <SocketProvider>
          <TooltipProvider>
            <Toaster position="top-right" />
            <Router />
          </TooltipProvider>
        </SocketProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
