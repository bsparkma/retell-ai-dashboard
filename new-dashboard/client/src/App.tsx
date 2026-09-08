import { useEffect } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import { setUnauthorizedHandler } from "@/lib/api";
import { login } from "@/lib/auth";
import Home from "@/pages/Home";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { canVisit, homeForRole } from "@/lib/permissions";
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
import AdminUsers from "./pages/AdminUsers";
import Platform from "./pages/Platform";
import Callbacks from "./pages/Callbacks";
import RcmToday from "./pages/rcm/RcmToday";
import BringIn from "./pages/rcm/BringIn";
import RemittanceList from "./pages/rcm/RemittanceList";
import RemittanceDetail from "./pages/rcm/RemittanceDetail";
import ApproveCheck from "./pages/rcm/ApproveCheck";
import ClaimMatch from "./pages/rcm/ClaimMatch";
import PostingQueue from "./pages/rcm/PostingQueue";
import TakebackSop from "./pages/rcm/TakebackSop";
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
import HygDay from "./pages/hyg/HygDay";
import HygVisit from "./pages/hyg/HygVisit";
import TcReports from "./pages/tc/TcReports";
import TcFloatingCalc from "./features/tc/cob/FloatingCalc";
import { WinCelebrationProvider } from "./features/tc/wins/WinCelebrationProvider";

// Exported for the routing tests (tests/module-home.test.tsx).
export function Router() {
  const [location] = useLocation();
  const auth = useAuth();
  const permissions = auth.status === "authenticated" ? auth.user.permissions : undefined;
  const role = auth.status === "authenticated" ? auth.user.role : null;
  const home = homeForRole(role);
  // The COB scratchpad floats over every TC page except the patient-facing deck.
  const showFloatingCalc =
    (location === "/tc" || location.startsWith("/tc/")) && !location.startsWith("/tc/present");

  // Roles PR B — CLIENT-SIDE COURTESY, not a gate. A hygienist who types
  // /analytics gets their own home instead of a page whose every request 403s.
  // The API refusal is the real boundary; this only avoids a broken screen.
  //
  // Deliberately requires a NON-EMPTY permission list. An empty or absent one
  // means we don't know what this user may do — auth still settling, or a
  // frontend deployed ahead of a backend that doesn't send `permissions` yet —
  // and bouncing someone off every page on a guess would turn a deploy skew
  // into an outage. A courtesy that can lock people out is not a courtesy.
  // (A user who genuinely holds nothing never reaches here: RequireAuth shows
  // them the access-request screen above this.)
  const knowPermissions = Array.isArray(permissions) && permissions.length > 0;
  if (
    auth.status === "authenticated" &&
    knowPermissions &&
    !canVisit(permissions, location) &&
    location !== home
  ) {
    return <Redirect to={home} replace />;
  }

  return (
    <DashboardLayout>
      <Switch>
        {/* Hub-first: login lands on the SPA origin, so "/" always redirects
            to the user's home — the module hub for office/admin, and the one
            page they can actually use for tc/hygiene. */}
        <Route path="/">
          <Redirect to={home} replace />
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
        <Route path="/admin/users" component={AdminUsers} />
        {/* Platform console. Deliberately absent from ROUTE_PERMISSIONS: the
            platform tier is not a permission action, and leaving it unlisted
            means the courtesy redirect above lets a non-super_admin ARRIVE, so
            the page can explain itself instead of bouncing them silently. Every
            endpoint behind it is requireSuperAdmin()-gated regardless. */}
        <Route path="/platform" component={Platform} />
        {/* RCM module — entitlement-gated server-side (requireModule('rcm')).
            Slice 6a added the review workbench: the list a biller opens a check
            from, the remittance itself, and the per-claim Open Dental match
            panel. All three inherit rcm.read from the /rcm prefix in
            ROUTE_PERMISSIONS; the mutations behind them demand rcm.write
            server-side, which no page needs to know to render. */}
        {/* `/rcm` IS TODAY, and it is the module's default landing route — the
            first item in the nav and the first screen of a biller's morning.
            Everything else in this module is reachable from it. */}
        <Route path="/rcm" component={RcmToday} />
        {/* BRING IN — the module's ONE upload surface (ruling D-16). Today's
            card, the Checks page's button and every empty state navigate here,
            and `tests/rcm-shell.test.tsx` fails if a second page grows one. */}
        <Route path="/rcm/bring-in" component={BringIn} />
        <Route path="/rcm/remittances" component={RemittanceList} />
        {/* APPROVING IS A PAGE (§6). More specific route FIRST — wouter
            matches in order, and `/rcm/remittances/:id` would otherwise swallow
            `/rcm/remittances/:id/approve` and render the check instead. */}
        <Route path="/rcm/remittances/:id/approve" component={ApproveCheck} />
        <Route path="/rcm/remittances/:id" component={RemittanceDetail} />
        <Route path="/rcm/claims/:id" component={ClaimMatch} />
        {/* Slice 6c — the posting queue and the one button in this product that
            writes to a patient's chart. It inherits rcm.read from the /rcm
            prefix in ROUTE_PERMISSIONS like every other page here, so a
            `reviewer` can WATCH plans post; the Drain button itself demands
            rcm.write server-side and the page renders the server's own
            `canDrain` answer rather than inspecting a role name. */}
        <Route path="/rcm/posting" component={PostingQueue} />
        {/* The manual route out of the one thing CareIN will not do. It is a
            real page rather than prose because Slice 6a promised "the practice's
            takeback procedure" and pointed nowhere. */}
        <Route path="/rcm/sop/takeback" component={TakebackSop} />
        {/* HYG module - entitlement-gated server-side (requireModule('hyg')).
            Slice 1 is the day view and an honest dead end behind it.

            `/hyg` redirects rather than rendering: the module's front door is
            the day, and a bare prefix that 404s is a link somebody will paste.

            /hyg/visit/:aptNum is a PLACEHOLDER on purpose. Every card on the day
            view is a link, and a link that 404s teaches a hygienist the app is
            broken; one that says "this ships in Slice 2" teaches her it is
            unfinished, which is true and cheaper to believe. */}
        <Route path="/hyg">
          <Redirect to="/hyg/day" replace />
        </Route>
        <Route path="/hyg/day" component={HygDay} />
        <Route path="/hyg/visit/:aptNum" component={HygVisit} />
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

/**
 * Wire the api client's 401 reaction once, at the root (Roles PR B).
 *
 * Registered here rather than inside lib/api so that module stays importable
 * from the node-environment tests without dragging in a toast library or a
 * `window`. The redirect is a full page navigation on purpose: the SSO flow
 * ends in a server redirect, and a client-side route change would leave stale
 * React state (and a stale AuthContext) behind it.
 */
function useUnauthorizedRedirect(): void {
  useEffect(() => {
    setUnauthorizedHandler(() => {
      toast.error("Signed out — sign in again");
      login();
    });
    return () => setUnauthorizedHandler(null);
  }, []);
}

function App() {
  useUnauthorizedRedirect();
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <AuthProvider>
            <RequireAuth>
              <ModuleProvider>
                <OfficeProvider>
                  <SlotMarkersProvider>
                    {/* Renders nothing until a confirmed accepted transition
                        fires it (TC only). */}
                    <WinCelebrationProvider>
                      <Toaster position="top-right" duration={4000} closeButton />
                      <Router />
                    </WinCelebrationProvider>
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
