/**
 * Home — the module hub ("app launcher"), the product's front door.
 *
 * After login every user lands here and picks a module. Tiles are driven
 * entirely by ModuleContext (entitled modules from /auth/me ∩ the client
 * registry in lib/modules.ts) — when a new module is entitled and registered
 * its tile appears with zero changes to this page.
 *
 * Renders chrome-free (DashboardLayout skips the sidebar/header for /home)
 * because the sidebar nav belongs to a module and none is chosen yet.
 * Authenticated but NOT module-gated: this is the chooser, not a module.
 */
import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Building2, ChevronDown, LogOut, Moon, Sun } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useModule } from "@/contexts/ModuleContext";
import { useTheme } from "@/contexts/ThemeContext";
import { logout } from "@/lib/auth";

const LOGO_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310419663031054856/K6tiRwvhaJ5eVuqkxBJoTR/carein-logo-mark-WmvfiqGRU6eTRKJUhc4vUK.webp";

export default function Home() {
  const auth = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { modules, setModule } = useModule();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const practiceName = auth.status === "authenticated" ? auth.user.tenant?.displayName : undefined;
  const firstName = auth.status === "authenticated" ? auth.user.name.split(" ")[0] : undefined;
  const userEmail = auth.status === "authenticated" ? auth.user.email : undefined;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Minimal header — no module is active yet, so no sidebar chrome. */}
      <header className="flex items-center gap-3 border-b border-border bg-card px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-primary/10">
          <img src={LOGO_URL} alt="CareIn" className="h-7 w-7 object-contain" />
        </div>
        <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
          CareIn
        </div>
        <div className="ml-auto flex items-center gap-3">
          {/* Practice/user area — opens the account menu (email + sign out). */}
          <div className="relative">
            <button
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              data-testid="home-user-chip"
            >
              <Building2 size={14} className="flex-shrink-0" />
              {practiceName ?? "Account"}
              <ChevronDown
                size={12}
                className={`flex-shrink-0 transition-transform ${userMenuOpen ? "rotate-180" : ""}`}
              />
            </button>
            {userMenuOpen && (
              <div
                className="absolute right-0 top-full z-10 mt-1 min-w-48 overflow-hidden rounded-md border border-border bg-card shadow-md"
                data-testid="home-user-menu"
              >
                {userEmail && (
                  <div
                    className="truncate border-b border-border px-3 py-2 text-xs text-muted-foreground"
                    data-testid="home-user-email"
                  >
                    {userEmail}
                  </div>
                )}
                <button
                  onClick={() => void logout()}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
                  data-testid="home-signout"
                >
                  <LogOut size={14} className="flex-shrink-0" />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
          <button
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      {/* Module chooser */}
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-3xl">
          <h1 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose where you want to work today.
          </p>

          {modules.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
              No modules are enabled for your practice yet. Contact CareIN support to get set up.
            </div>
          ) : (
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="module-tiles">
              {modules.map((m) => {
                const Icon = m.icon;
                return (
                  <Link
                    key={m.id}
                    href={m.basePath}
                    onClick={() => setModule(m.id)}
                    data-testid={`module-tile-${m.id}`}
                  >
                    <div className="group flex h-full cursor-pointer flex-col rounded-xl border border-border bg-card p-6 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                      <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon size={22} />
                      </div>
                      <div className="mt-4 flex items-center gap-2">
                        <span className="text-base font-semibold text-foreground">{m.label}</span>
                        <ArrowRight
                          size={16}
                          className="text-muted-foreground opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100"
                        />
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{m.description}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
