import type { ReactNode } from "react"
import { Link, useLocation } from "wouter"
import {
  CalendarDays,
  Inbox,
  Send,
  FileText,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Stethoscope,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/store/app-store"
import { OfficeSwitcher, HygienistSwitcher, DatePickerControl } from "@/components/office-switcher"
import { MicButton } from "@/components/mic-button"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const navItems = [
  { href: "/day", label: "Day View", icon: CalendarDays },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/submissions", label: "Submissions", icon: Send },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
]

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation()
  const navCollapsed = useAppStore((s) => s.navCollapsed)
  const setNavCollapsed = useAppStore((s) => s.setNavCollapsed)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-card px-4">
        <Button
          variant="ghost"
          size="icon"
          className="tap-target shrink-0"
          onClick={() => setNavCollapsed(!navCollapsed)}
          aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {navCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>

        <div className="flex items-center gap-2 pr-2">
          <Stethoscope className="size-5 text-primary" />
          <span className="hidden text-base font-semibold tracking-tight sm:inline">CareIN Hygiene</span>
        </div>

        <div className="flex flex-1 items-center gap-2 overflow-x-auto">
          <OfficeSwitcher />
          <DatePickerControl />
          <HygienistSwitcher />
        </div>

        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="tap-target" onClick={toggleTheme} aria-label="Toggle theme">
                {theme === "light" ? <Moon /> : <Sun />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle dark mode</TooltipContent>
          </Tooltip>
          <MicButton />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <nav
          className={cn(
            "flex shrink-0 flex-col gap-1 border-r bg-sidebar p-2 transition-all duration-200",
            navCollapsed ? "w-16" : "w-56",
          )}
        >
          {navItems.map((item) => {
            const active = location === item.href || (item.href === "/day" && location === "/")
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "tap-target flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="size-5 shrink-0" />
                {!navCollapsed && <span className="truncate">{item.label}</span>}
              </Link>
            )
          })}
        </nav>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
