/**
 * DashboardLayout — CareIn "Warm Clinic" Design
 * Fixed deep-navy sidebar + top header bar + main content area
 * Sidebar: 240px fixed, navy background, teal active indicators
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  LayoutDashboard,
  Radio,
  PhoneCall,
  Bot,
  CalendarDays,
  PhoneIncoming,
  BarChart3,
  Settings,
  Building2,
  ChevronDown,
  Moon,
  Sun,
  Bell,
  Search,
  Menu,
  X,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";

const LOGO_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310419663031054856/K6tiRwvhaJ5eVuqkxBJoTR/carein-logo-mark-WmvfiqGRU6eTRKJUhc4vUK.webp";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/live", label: "Live Monitor", icon: Radio, badge: "3", badgeType: "live" as const },
  { path: "/calls", label: "Call Log", icon: PhoneCall },
  { path: "/agents", label: "Agent Builder", icon: Bot },
  { path: "/calendar", label: "Calendar", icon: CalendarDays },
  { path: "/callbacks", label: "Callbacks", icon: PhoneIncoming, badge: "7", badgeType: "warning" as const },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/admin", label: "Admin", icon: Settings },
];

const offices = [
  "Downtown Dental",
  "Westside Smiles",
  "North Campus Dental",
  "Eastview Family Dental",
];

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const [location] = useLocation();
  const { theme, toggleTheme } = useTheme();
  const [selectedOffice, setSelectedOffice] = useState(offices[0]);
  const [officeDropOpen, setOfficeDropOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isConnected] = useState(true);

  const handleNavClick = () => {
    setSidebarOpen(false);
  };

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
        style={{ backgroundColor: "oklch(0.16 0.055 245)" }}
      >
        {/* Sidebar header */}
        <div className="flex items-center gap-3 px-4 py-5 border-b" style={{ borderColor: "oklch(0.25 0.05 245)" }}>
          <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 bg-white/10 flex items-center justify-center">
            <img src={LOGO_URL} alt="CareIn" className="w-7 h-7 object-contain" />
          </div>
          <div className="min-w-0">
            <div className="text-white font-bold text-base leading-tight" style={{ fontFamily: "Outfit, sans-serif" }}>
              CareIn
            </div>
            <div className="text-xs" style={{ color: "oklch(0.60 0.08 210)" }}>
              AI Operations Hub
            </div>
          </div>
          <button
            className="ml-auto lg:hidden text-white/60 hover:text-white"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        {/* Office selector */}
        <div className="px-3 py-3 border-b" style={{ borderColor: "oklch(0.25 0.05 245)" }}>
          <button
            onClick={() => setOfficeDropOpen(!officeDropOpen)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-white/5"
            style={{ color: "oklch(0.80 0.01 240)" }}
          >
            <Building2 size={14} className="flex-shrink-0" style={{ color: "oklch(0.60 0.08 210)" }} />
            <span className="truncate flex-1 text-left text-xs font-medium">{selectedOffice}</span>
            <ChevronDown size={12} className={`flex-shrink-0 transition-transform ${officeDropOpen ? "rotate-180" : ""}`} />
          </button>
          {officeDropOpen && (
            <div className="mt-1 rounded-md overflow-hidden" style={{ backgroundColor: "oklch(0.12 0.04 245)" }}>
              {offices.map((office) => (
                <button
                  key={office}
                  onClick={() => { setSelectedOffice(office); setOfficeDropOpen(false); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors"
                  style={{ color: office === selectedOffice ? "oklch(0.70 0.14 210)" : "oklch(0.72 0.01 240)" }}
                >
                  {office}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          <div className="text-xs font-semibold uppercase tracking-wider mb-2 px-3" style={{ color: "oklch(0.45 0.04 245)" }}>
            Operations
          </div>
          {navItems.slice(0, 6).map(({ path, label, icon: Icon, badge, badgeType }) => {
            const isActive = path === "/" ? location === "/" : location.startsWith(path);
            return (
              <Link key={path} href={path} onClick={handleNavClick}>
                <div
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-150 group ${
                    isActive ? "border-l-[3px]" : "border-l-[3px] border-transparent"
                  }`}
                  style={{
                    backgroundColor: isActive ? "oklch(0.55 0.18 210 / 0.18)" : "transparent",
                    borderLeftColor: isActive ? "oklch(0.60 0.16 210)" : "transparent",
                    color: isActive ? "oklch(0.72 0.14 210)" : "oklch(0.72 0.01 240)",
                  }}
                >
                  <Icon size={16} className="flex-shrink-0" />
                  <span className="flex-1">{label}</span>
                  {badge && (
                    <span
                      className="text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center"
                      style={{
                        backgroundColor: badgeType === "live"
                          ? "oklch(0.65 0.18 155 / 0.25)"
                          : "oklch(0.78 0.17 75 / 0.25)",
                        color: badgeType === "live"
                          ? "oklch(0.65 0.18 155)"
                          : "oklch(0.78 0.17 75)",
                      }}
                    >
                      {badge}
                    </span>
                  )}
                  {path === "/live" && (
                    <span className="live-dot flex-shrink-0" />
                  )}
                </div>
              </Link>
            );
          })}

          <div className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2 px-3" style={{ color: "oklch(0.45 0.04 245)" }}>
            Insights
          </div>
          {navItems.slice(6).map(({ path, label, icon: Icon }) => {
            const isActive = location.startsWith(path);
            return (
              <Link key={path} href={path} onClick={handleNavClick}>
                <div
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-150 ${
                    isActive ? "border-l-[3px]" : "border-l-[3px] border-transparent"
                  }`}
                  style={{
                    backgroundColor: isActive ? "oklch(0.55 0.18 210 / 0.18)" : "transparent",
                    borderLeftColor: isActive ? "oklch(0.60 0.16 210)" : "transparent",
                    color: isActive ? "oklch(0.72 0.14 210)" : "oklch(0.72 0.01 240)",
                  }}
                >
                  <Icon size={16} className="flex-shrink-0" />
                  <span>{label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Sidebar footer */}
        <div className="px-4 py-4 border-t" style={{ borderColor: "oklch(0.25 0.05 245)" }}>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1.5 text-xs"
              style={{ color: isConnected ? "oklch(0.65 0.18 155)" : "oklch(0.62 0.22 25)" }}
            >
              {isConnected ? <Wifi size={12} /> : <WifiOff size={12} />}
              <span>{isConnected ? "Connected" : "Offline"}</span>
            </div>
            <div className="ml-auto text-xs" style={{ color: "oklch(0.45 0.04 245)" }}>
              v2.0
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: "oklch(0.55 0.18 210)" }}>
              FD
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate" style={{ color: "oklch(0.80 0.01 240)" }}>Front Desk</div>
              <div className="text-xs truncate" style={{ color: "oklch(0.50 0.04 245)" }}>Downtown Dental</div>
            </div>
          </div>
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

          {/* Search */}
          <div className="flex-1 max-w-md">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search patients, calls, agents... (⌘K)"
                className="w-full pl-9 pr-4 py-2 text-sm bg-muted rounded-md border border-transparent focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
                onFocus={() => toast.info("Global search coming soon")}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {/* Connection status */}
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium" style={{ backgroundColor: "oklch(0.65 0.18 155 / 0.1)", color: "oklch(0.50 0.18 155)" }}>
              <span className="live-dot" style={{ width: 6, height: 6 }} />
              Live
            </div>

            {/* Notifications */}
            <button
              className="relative p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={() => toast.info("Notifications panel coming soon")}
            >
              <Bell size={18} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
            </button>

            {/* Theme toggle */}
            <button
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

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
