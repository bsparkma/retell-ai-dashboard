/**
 * DashboardLayout — CareIn "Warm Clinic" Design
 * Fixed deep-navy sidebar + top header bar + main content area
 * Sidebar: 240px fixed, navy background, teal active indicators
 */
import { useState, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  PhoneCall,
  PhoneIncoming,
  Bot,
  CalendarClock,
  BarChart3,
  Settings,
  Building2,
  ChevronDown,
  Moon,
  Sun,
  Menu,
  X,
  Wifi,
  WifiOff,
  PlugZap,
  KanbanSquare,
  BellRing,
  Inbox,
  ClipboardList,
  ClipboardCheck,
  ShieldCheck,
  Mail,
  MessagesSquare,
  Images,
  Calculator,
  BookOpen,
  LogOut,
  Heart,
  CreditCard,
  LibraryBig,
  Users,
  Loader2,
} from "lucide-react";
import { api, isRateLimited } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { logout } from "@/lib/auth";
import { useAuth } from "@/contexts/AuthContext";
import { useModule } from "@/contexts/ModuleContext";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { isTcSharedRoute } from "@/features/tc/officeScope";
import { TcGlobalSearch } from "@/features/tc/search/TcGlobalSearch";
import { canVisit } from "@/lib/permissions";
import type { ModuleId } from "@/lib/modules";

const LOGO_URL = "/carein-logo.webp";

interface NavItem {
  path: string;
  label: string;
  icon: typeof LayoutDashboard;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * Hide the nav items this user cannot open, and drop any group left empty
 * (Roles PR B).
 *
 * UX ONLY — the server 403 is the gate. This exists so a hygienist isn't shown
 * eleven links that all fail, not to keep anyone out of anything.
 *
 * The required action per route lives in ONE map (lib/permissions.ts), keyed by
 * route prefix, so a new nav item inherits its permission from its path instead
 * of needing a second declaration someone can forget to update.
 */
export function visibleNav(groups: NavGroup[], permissions: readonly string[] | undefined): NavGroup[] {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((i) => canVisit(permissions, i.path)) }))
    .filter((group) => group.items.length > 0);
}

/**
 * Per-module sidebar nav. The module switcher picks the active module; this
 * map is the only other module-aware piece of the shell (the registry entry
 * alone changes nothing but the switcher label).
 */
const NAV_BY_MODULE: Partial<Record<ModuleId, NavGroup[]>> = {
  voice: [
    {
      title: "Operations",
      items: [
        { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { path: "/calls", label: "Calls", icon: PhoneCall },
        { path: "/callbacks", label: "Callbacks", icon: PhoneIncoming },
        { path: "/agents", label: "Agent Builder", icon: Bot },
        { path: "/scheduling", label: "Scheduling", icon: CalendarClock },
      ],
    },
    {
      title: "Insights",
      items: [
        { path: "/analytics", label: "Analytics", icon: BarChart3 },
        { path: "/admin", label: "Admin", icon: Settings },
        // Tenant user management. Sits under /admin so it inherits admin.all
        // from ROUTE_PERMISSIONS' prefix match — one place decides.
        { path: "/admin/users", label: "Users", icon: Users },
      ],
    },
  ],
  /* Ordered to match DentaFlow's sidebar (Dashboard → Pipeline → Nurture →
     Tasks → Financing → Gallery → Pre-Auth → Email → Guide → Reports),
     adapted to the platform's grouped shell. */
  tc: [
    {
      title: "Casework",
      items: [
        { path: "/tc/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { path: "/tc", label: "Pipeline", icon: KanbanSquare },
        { path: "/tc/nurture", label: "Nurture", icon: Heart },
        { path: "/tc/followups", label: "Follow-Ups", icon: BellRing },
        { path: "/tc/preauth", label: "Pre-Auth", icon: ShieldCheck },
      ],
    },
    {
      title: "Hygiene",
      items: [
        { path: "/tc/hygiene/inbox", label: "TC Inbox", icon: Inbox },
        { path: "/tc/hygiene", label: "Intake", icon: ClipboardList },
        { path: "/tc/hygiene/submissions", label: "Submissions", icon: ClipboardCheck },
      ],
    },
    {
      title: "Tools",
      items: [
        { path: "/tc/financing", label: "Financing", icon: CreditCard },
        { path: "/tc/gallery", label: "Gallery", icon: Images },
        { path: "/tc/templates", label: "Email Templates", icon: Mail },
        { path: "/tc/communications", label: "Communications", icon: MessagesSquare },
        { path: "/tc/guide", label: "TC Guide", icon: BookOpen },
        { path: "/tc/reports", label: "Reports", icon: BarChart3 },
        { path: "/tc/cob", label: "COB Calculator", icon: Calculator },
        { path: "/tc/library", label: "Library", icon: LibraryBig },
        { path: "/tc/settings", label: "Settings", icon: Settings },
      ],
    },
  ],
};

/**
 * Longest-prefix active match so "/tc/hygiene" doesn't light up while the
 * user is on "/tc/hygiene/inbox". "/tc" only matches exactly, except it also
 * claims case-detail pages (they belong to Pipeline).
 */
function activeNavPath(location: string, groups: NavGroup[]): string | null {
  let best: string | null = null;
  for (const group of groups) {
    for (const { path } of group.items) {
      const matches =
        path === "/tc"
          ? location === path || location.startsWith("/tc/cases")
          : location === path || location.startsWith(`${path}/`);
      if (matches && (best === null || path.length > best.length)) best = path;
    }
  }
  return best;
}

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const [location, setLocation] = useLocation();
  const { theme, toggleTheme } = useTheme();
  const auth = useAuth();
  // Practice (tenant) name from /auth/me — single tenant today, so no selector.
  const practiceName = auth.status === "authenticated" ? auth.user.tenant?.displayName : undefined;
  // Global module selection (entitlement-driven; Voice-only today, so the
  // switcher stays hidden until a second module is entitled AND renderable).
  const { modules, module: activeModule, setModule } = useModule();
  const activeModuleLabel = modules.find((m) => m.id === activeModule)?.label ?? "Voice";
  const [moduleDropOpen, setModuleDropOpen] = useState(false);
  // Global office selection (shared across pages) — the real agent→office roster.
  const { offices, office, setOffice, selected } = useOffice();
  const selectedOfficeName = office === ALL_OFFICES ? "All Offices" : (selected?.officeName ?? "All Offices");
  const [officeDropOpen, setOfficeDropOpen] = useState(false);
  // DentaFlow SHARED_ROUTES port: routes whose content isn't scoped by the
  // office picker hide it entirely (pages that still need one office prompt
  // inline via <TcOfficeGate />).
  const hideOfficePicker = isTcSharedRoute(location);
  const isTcRoute = location === "/tc" || location.startsWith("/tc/");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // Starts true: we have no evidence of trouble yet, and opening every session with a
  // red banner that clears a second later trains people to ignore it.
  const [isConnected, setIsConnected] = useState(true);
  /** Reachable but throttling us — a passing condition, not an outage. */
  const [isBusy, setIsBusy] = useState(false);
  const userEmail = auth.status === "authenticated" ? auth.user.email : undefined;

  // Connectivity probe.
  //
  // Three things were wrong with the old version and all three showed the same false
  // "Backend is offline" banner:
  //   - it polled /api/admin/health, which is behind `admin.all`, so every non-admin got
  //     a 403 every 30s and the banner never went away for them;
  //   - it treated a 429 as "offline", so being throttled looked like an outage;
  //   - it ran at 30s in every background tab, which is what exhausted the rate limit in
  //     the first place.
  // Now: an unprivileged, rate-limit-exempt endpoint, at a calmer cadence, only while
  // the tab is visible, and throttling is reported as "busy" rather than "down".
  const check = useCallback(() => {
    api.getHealth()
      .then(() => { setIsConnected(true); setIsBusy(false); })
      .catch((err) => {
        if (isRateLimited(err)) {
          // Reachable and answering — just asking us to slow down. Never the offline
          // banner: nothing is at risk and the next poll clears it.
          setIsBusy(true);
          setIsConnected(true);
          return;
        }
        setIsBusy(false);
        setIsConnected(false);
      });
  }, []);

  usePolling(check, 60_000);

  const handleNavClick = () => {
    setSidebarOpen(false);
  };

  // Which module's nav to render. The ROUTE wins over the stored selection:
  // standing on /tc/hygiene/inbox and being shown the Voice sidebar is wrong
  // however you got there, and it became reachable in Roles PR B because a
  // hygienist lands on a TC route with 'voice' still remembered in
  // localStorage — which filtered to an empty sidebar.
  const routeModule: ModuleId | null = isTcRoute ? "tc" : null;
  // Role-scoped nav (Roles PR B). While /auth/me is still in flight the
  // permission list is undefined, which filters everything out — correct, and
  // invisible in practice because RequireAuth holds the app on a spinner until
  // the fetch settles.
  const permissions = auth.status === "authenticated" ? auth.user.permissions : undefined;
  const navModule = routeModule ?? activeModule;
  const navGroups = visibleNav(NAV_BY_MODULE[navModule] ?? NAV_BY_MODULE.voice ?? [], permissions);
  const activePath = activeNavPath(location, navGroups);

  // Only offer a module this user has at least one page in. The practice's
  // entitlement still decides what EXISTS (`modules` comes from /auth/me); this
  // narrows the switcher to what the person can actually open, so a hygienist
  // cannot switch to Voice and land on an empty sidebar with no way back.
  const switchableModules = modules.filter(
    (m) => visibleNav(NAV_BY_MODULE[m.id] ?? [], permissions).length > 0,
  );

  // Patient-facing presentation mode renders chrome-free (legacy /present).
  // The module hub is also chrome-free — the sidebar nav belongs to a module,
  // and on /home none is chosen yet (the page brings its own header).
  if (location.startsWith("/tc/present") || location === "/home") {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-60 flex flex-col transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ backgroundColor: "var(--sidebar)" }}
      >
        {/* Sidebar header — the logo is the way back to the module hub. */}
        <div className="flex items-center gap-3 px-4 py-5 border-b" style={{ borderColor: "var(--sidebar-border)" }}>
          <Link
            href="/home"
            onClick={handleNavClick}
            title="Back to module hub"
            className="flex items-center gap-3 min-w-0 rounded-md transition-opacity hover:opacity-80"
          >
            <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 bg-white/10 flex items-center justify-center">
              <img src={LOGO_URL} alt="CareIn" className="w-7 h-7 object-contain" />
            </div>
            <div className="min-w-0">
              <div className="text-white font-bold text-base leading-tight" style={{ fontFamily: "Sora, sans-serif" }}>
                CareIn
              </div>
              {/* DentaFlow showed the practice under the wordmark; the name
                  comes from the tenant record, never a hardcoded string. */}
              <div className="text-xs truncate" style={{ color: "oklch(0.65 0.1 186)" }}>
                {practiceName ?? "AI Operations Hub"}
              </div>
            </div>
          </Link>
          <button
            className="ml-auto lg:hidden text-white/60 hover:text-white"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        {/* Module switcher — only rendered when this USER has >1 module they
            can actually open. A Voice-only tenant sees an unchanged shell, and
            so does a hygienist (whose only module is TC). */}
        {switchableModules.length > 1 && (
          <div className="px-3 py-3 border-b" style={{ borderColor: "var(--sidebar-border)" }}>
            <button
              onClick={() => setModuleDropOpen(!moduleDropOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-white/5"
              style={{ color: "var(--sidebar-foreground)" }}
            >
              <LayoutDashboard size={14} className="flex-shrink-0" style={{ color: "oklch(0.65 0.1 186)" }} />
              <span className="truncate flex-1 text-left text-xs font-medium">{activeModuleLabel}</span>
              <ChevronDown size={12} className={`flex-shrink-0 transition-transform ${moduleDropOpen ? "rotate-180" : ""}`} />
            </button>
            {moduleDropOpen && (
              <div className="mt-1 rounded-md overflow-hidden" style={{ backgroundColor: "oklch(0.11 0.015 250)" }}>
                {switchableModules.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      const switching = m.id !== activeModule;
                      setModule(m.id);
                      setModuleDropOpen(false);
                      // Land on the module's home so the nav and page agree.
                      if (switching) setLocation(m.basePath);
                    }}
                    className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors"
                    style={{ color: m.id === activeModule ? "oklch(0.75 0.08 186)" : "oklch(0.65 0.01 250)" }}
                  >
                    <span className="flex-1 truncate">{m.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Office selector — hidden on shared (office-agnostic) routes */}
        {!hideOfficePicker && (
        <div className="px-3 py-3 border-b" style={{ borderColor: "var(--sidebar-border)" }}>
          <button
            onClick={() => setOfficeDropOpen(!officeDropOpen)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-white/5"
            style={{ color: "var(--sidebar-foreground)" }}
          >
            <Building2 size={14} className="flex-shrink-0" style={{ color: "oklch(0.65 0.1 186)" }} />
            <span className="truncate flex-1 text-left text-xs font-medium">{selectedOfficeName}</span>
            <ChevronDown size={12} className={`flex-shrink-0 transition-transform ${officeDropOpen ? "rotate-180" : ""}`} />
          </button>
          {officeDropOpen && (
            <div className="mt-1 rounded-md overflow-hidden" style={{ backgroundColor: "oklch(0.11 0.015 250)" }}>
              {[{ officeId: ALL_OFFICES, officeName: "All Offices", odConnected: true }, ...offices].map((o) => (
                <button
                  key={o.officeId}
                  onClick={() => { setOffice(o.officeId); setOfficeDropOpen(false); }}
                  title={o.odConnected ? undefined : "OD not connected for this office yet"}
                  className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors"
                  style={{ color: o.officeId === office ? "oklch(0.75 0.08 186)" : "oklch(0.65 0.01 250)" }}
                >
                  <span className="flex-1 truncate">{o.officeName}</span>
                  {!o.odConnected && <PlugZap size={11} className="opacity-60 flex-shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
        )}

        {/* Navigation (module-aware) */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {navGroups.map((group, groupIdx) => (
            <div key={group.title}>
              <div
                className={`text-xs font-semibold uppercase tracking-wider mb-2 px-3 ${groupIdx > 0 ? "mt-4" : ""}`}
                style={{ color: "oklch(0.5 0.02 250)" }}
              >
                {group.title}
              </div>
              {group.items.map(({ path, label, icon: Icon }) => {
                const isActive = path === activePath;
                return (
                  <Link key={path} href={path} onClick={handleNavClick}>
                    <div
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-150 ${
                        isActive ? "border-l-[3px]" : "border-l-[3px] border-transparent"
                      }`}
                      style={{
                        backgroundColor: isActive ? "oklch(0.52 0.12 186 / 0.2)" : "transparent",
                        borderLeftColor: isActive ? "oklch(0.65 0.1 186)" : "transparent",
                        color: isActive ? "oklch(0.75 0.08 186)" : "oklch(0.65 0.01 250)",
                      }}
                    >
                      <Icon size={16} className="flex-shrink-0" />
                      <span className="flex-1">{label}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Sidebar footer */}
        <div className="px-4 py-4 border-t" style={{ borderColor: "var(--sidebar-border)" }}>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1.5 text-xs"
              style={{ color: isConnected ? "oklch(0.65 0.18 155)" : "oklch(0.62 0.22 25)" }}
            >
              {isConnected ? <Wifi size={12} /> : <WifiOff size={12} />}
              <span>{isConnected ? "Connected" : "Offline"}</span>
            </div>
            <div className="ml-auto text-xs" style={{ color: "oklch(0.5 0.02 250)" }}>
              v2.0
            </div>
          </div>
          {/* User chip — opens upward into the account menu (email + sign out). */}
          {userMenuOpen && (
            <div
              className="mt-2 mb-1 rounded-md overflow-hidden"
              style={{ backgroundColor: "oklch(0.11 0.015 250)" }}
              data-testid="sidebar-user-menu"
            >
              {userEmail && (
                <div
                  className="px-3 py-2 text-xs truncate border-b"
                  style={{ color: "oklch(0.6 0.015 250)", borderColor: "var(--sidebar-accent)" }}
                  data-testid="sidebar-user-email"
                >
                  {userEmail}
                </div>
              )}
              <button
                onClick={() => void logout()}
                className="w-full flex items-center gap-2 text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors"
                style={{ color: "oklch(0.65 0.01 250)" }}
                data-testid="sidebar-signout"
              >
                <LogOut size={12} className="flex-shrink-0" />
                <span>Sign out</span>
              </button>
            </div>
          )}
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="mt-2 w-full flex items-center gap-2 rounded-md transition-colors hover:bg-white/5"
            data-testid="sidebar-user-chip"
          >
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ backgroundColor: "var(--sidebar-primary)" }}>
              FD
            </div>
            <div className="min-w-0 flex-1 text-left">
              <div className="text-xs font-medium truncate" style={{ color: "var(--sidebar-foreground)" }}>Front Desk</div>
              <div className="text-xs truncate" style={{ color: "oklch(0.55 0.015 250)" }}>{selectedOfficeName}</div>
            </div>
            <ChevronDown
              size={12}
              className={`flex-shrink-0 transition-transform ${userMenuOpen ? "" : "rotate-180"}`}
              style={{ color: "oklch(0.55 0.015 250)" }}
            />
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top header */}
        <header className="flex-shrink-0 flex items-center gap-3 px-4 py-3 bg-card border-b border-border">
          <button
            className="lg:hidden text-muted-foreground hover:text-foreground"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>

          <div className="flex-1 flex items-center">
            {practiceName && (
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground truncate">
                <Building2 size={14} className="flex-shrink-0 text-muted-foreground" />
                {practiceName}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {/* Case search palette (⌘K) — TC surfaces only; it searches TC
                cases, so it stays out of the Voice header. */}
            {isTcRoute && <TcGlobalSearch />}
            {/* Theme toggle */}
            <button
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        {!isConnected ? (
          <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
            <WifiOff size={13} />
            <span>Backend is offline — changes won't save until reconnected.</span>
          </div>
        ) : isBusy ? (
          <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-sky-50 border-b border-sky-200 text-sky-800 text-xs">
            <Loader2 size={13} className="animate-spin" />
            <span>Busy — the dashboard is retrying. Nothing is lost.</span>
          </div>
        ) : null}

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="page-enter">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
