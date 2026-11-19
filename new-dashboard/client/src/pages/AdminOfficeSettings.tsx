/**
 * /admin/office-settings — this practice's per-office settings (MT-2c, ruling A).
 *
 * /admin is practice-level: the practice's admins manage THEIR practice's
 * offices here. The Developer Console (/platform) keeps its own copy of these
 * controls for Beau and developers. Both pages draw the SAME panels and the
 * server runs the SAME handlers (backend routes/officeSwitches.js); this page
 * only says which door to go through: /api/admin/office-settings, behind
 * admin.all and each switch's module guard.
 *
 * Every rule the page appears to follow is enforced by the server. The tenant
 * is never sent — the server takes it from the session — and an office that is
 * not this practice's is refused there, not hidden here.
 *
 * Sections are shown only for modules the practice has, matching the server's
 * module guards, so a practice without TC gets no TC switches rather than
 * switches that 403.
 *
 * NOT HERE, ON PURPOSE:
 *   - The process-wide settings (email and SMS sending, call retention). They
 *     are CareIN's, not one practice's, and stay in the Developer Console.
 *   - Writing the nurture / opportunities switches. Neither has a write path
 *     yet; they are shown read-only, and CareIN turns them on.
 *   - The email identity. It already has a practice home (TC settings →
 *     Practice info); this page links there instead of drawing a second copy.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ChevronRight, Loader2, Lock, MapPin, Mail, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { tcSettingsHref } from "@/features/tc/settings/paths";
import { api, type RunbookSwitchState } from "@/lib/api";
import { hasModule } from "@/lib/modules";
import HygienePanel from "./platform/HygienePanel";
import { TcCheckoutPanel } from "./platform/TcCheckoutPanel";
import {
  TcAutoCheckoutPanel,
  TcOdSyncPanel,
  TcReferralEmailPanel,
  TcReferralPatientEmailPanel,
  TcReferralsPanel,
} from "./platform/TcReferralsPanel";

const OFFICE_LABELS: Record<string, string> = { roland: "Roland", valley: "Riley (valley)" };

const RUNBOOK_LABELS: Record<RunbookSwitchState["switches"][number]["settingKey"], { title: string; detail: string }> = {
  tc_nurture_enabled: {
    title: "Nurture campaigns",
    detail: "Automated follow-up messages to patients on a nurture track.",
  },
  tc_opportunities_sync: {
    title: "Opportunities sync",
    detail: "The nightly read of treatment-planned, unscheduled work from Open Dental.",
  },
};

/** Nurture + opportunities: what is in force per office. Read-only — see the header. */
function RunbookSwitchesSection() {
  const [state, setState] = useState<RunbookSwitchState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await api.getRunbookSwitches());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load these switches");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-3" data-testid="runbook-switches">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Lock className="h-4 w-4" /> Turned on by CareIN
        </h2>
        <p className="text-sm text-muted-foreground">
          These are shown so you can see what is running at each office. They cannot be changed here
          yet; ask CareIN to turn one on or off.
        </p>
      </div>
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}
      {!error && !state && (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {state && !state.policyKnown && (
        <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="runbook-policy-unknown">
          These settings could not be read just now, so every office shows as off.
        </p>
      )}
      {state && (
        <div className="divide-y divide-border rounded-xl border border-border">
          {(Object.keys(RUNBOOK_LABELS) as Array<keyof typeof RUNBOOK_LABELS>).map((key) => (
            <div key={key} className="p-3">
              <p className="font-medium text-foreground">{RUNBOOK_LABELS[key].title}</p>
              <p className="text-xs text-muted-foreground">{RUNBOOK_LABELS[key].detail}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {state.switches
                  .filter((s) => s.settingKey === key)
                  .map((s) => (
                    <Badge
                      key={s.office}
                      variant={s.enabled ? "default" : "outline"}
                      data-testid={`runbook-${key}-${s.office}`}
                    >
                      {OFFICE_LABELS[s.office] ?? s.office}: {s.enabled ? "on" : "off"}
                    </Badge>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function AdminOfficeSettings() {
  const auth = useAuth();
  const tenantModules = auth.status === "authenticated" ? auth.user.tenant?.modules : undefined;
  const tc = hasModule(tenantModules, "tc");
  const hyg = hasModule(tenantModules, "hyg");
  // Bumped by Refresh; remounting the panels is their reload.
  const [generation, setGeneration] = useState(0);

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6" data-testid="admin-office-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <MapPin className="h-5 w-5 text-muted-foreground" /> Office settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What is switched on at each of your offices. A change takes effect on the next request,
            and what you see after a change is what was saved.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setGeneration((n) => n + 1)} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {!tc && !hyg && (
        <p className="text-sm text-muted-foreground" data-testid="admin-office-settings-empty">
          Your practice has no products with per-office settings.
        </p>
      )}

      <div key={generation} className="space-y-8">
        {tc && (
          <>
            <TcCheckoutPanel door="admin" />
            <TcOdSyncPanel door="admin" />
            <TcAutoCheckoutPanel door="admin" />
            <TcReferralsPanel door="admin" />
            <TcReferralEmailPanel door="admin" />
            <TcReferralPatientEmailPanel door="admin" />
          </>
        )}
        {hyg && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">Hygiene</h2>
            <HygienePanel door="admin" />
          </section>
        )}
        {tc && <RunbookSwitchesSection />}
      </div>

      {tc && (
        <Link
          href={tcSettingsHref("practice")}
          className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm hover:bg-muted/50"
          data-testid="admin-office-settings-email-identity"
        >
          <span className="flex items-center gap-2 text-foreground">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Each office&apos;s email identity (reply-to, name, phone) is under Practice info
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      )}
    </div>
  );
}
