/**
 * /admin → "Practice setup" (OB-1): per office, what is set up and what is
 * missing, each step linking to the screen that already edits it.
 *
 * READ-ONLY. The card adds no editor and saves nothing; every status is
 * COMPUTED server-side from the data the feature itself reads
 * (GET /api/admin/setup-status), never a box somebody ticks.
 *
 * HONEST STATES. Loading says it is checking. A failed check says it could
 * not check, with a retry — it never shows a green bar or a done badge it did
 * not get from the server. A step the server could not read arrives as
 * needs_attention with its own "could not check" line.
 *
 * LINKS. "Go" appears only when the viewer could open the screen (its route
 * permission, the module behind it, or super admin for the Developer
 * Console) — the hub's rule that a card never links somewhere that would
 * bounce. Otherwise the row says who sets it.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { canVisit } from "@/lib/permissions";
import { hasModule } from "@/lib/modules";
import { OfficeId } from "@shared/tc/contract";
import { fetchSetupStatus, type SetupStatus, type SetupStep } from "./setupStatusApi";

export interface PracticeSetupCardProps {
  homeOffice: string | null;
  permissions: readonly string[] | undefined;
  tenantModules: readonly string[] | undefined;
  isSuperAdmin: boolean;
}

/** The offices the picker offers before the first answer names them. */
const FALLBACK_OFFICES: ReadonlyArray<{ officeId: string; officeName: string }> = OfficeId.options.map((id) => ({
  officeId: id,
  officeName: id.charAt(0).toUpperCase() + id.slice(1),
}));

function initialOffice(homeOffice: string | null): string {
  const known = FALLBACK_OFFICES.map((o) => o.officeId);
  return homeOffice && known.includes(homeOffice) ? homeOffice : (known[0] ?? "roland");
}

/** Could this viewer open `link`? */
export function linkOpens(link: string, p: PracticeSetupCardProps): boolean {
  const path = link.split("#")[0] ?? link;
  if (path.startsWith("/platform")) return p.isSuperAdmin;
  if (path.startsWith("/admin/tc") && !hasModule(p.tenantModules, "tc")) return false;
  if (path.startsWith("/hyg") && !hasModule(p.tenantModules, "hyg")) return false;
  return canVisit(p.permissions, path);
}

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: SetupStatus };

function StepRow({ step, props }: { step: SetupStep; props: PracticeSetupCardProps }) {
  const done = step.status === "done";
  const opens = linkOpens(step.link, props);
  return (
    <li className="flex items-start gap-3 py-3" data-testid={`setup-step-${step.id}`} data-status={step.status}>
      {done ? (
        <CheckCircle2 size={18} className="text-emerald-600 mt-0.5 flex-shrink-0" aria-hidden />
      ) : (
        <AlertTriangle size={18} className="text-amber-600 mt-0.5 flex-shrink-0" aria-hidden />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{step.title}</span>
          <Badge variant={done ? "secondary" : "outline"} data-testid={`setup-badge-${step.id}`}>
            {done ? "Done" : "Needs attention"}
          </Badge>
          {!step.required && <span className="text-xs text-muted-foreground">Optional</span>}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
      </div>
      {opens ? (
        <Link
          href={step.link}
          className="text-sm text-primary inline-flex items-center gap-0.5 flex-shrink-0"
          data-testid={`setup-go-${step.id}`}
        >
          Go <ChevronRight size={14} />
        </Link>
      ) : (
        <span className="text-xs text-muted-foreground flex-shrink-0">Set by CareIN support</span>
      )}
    </li>
  );
}

export default function PracticeSetupCard(props: PracticeSetupCardProps) {
  const [office, setOffice] = useState<string>(() => initialOffice(props.homeOffice));
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [offices, setOffices] = useState(FALLBACK_OFFICES);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    fetchSetupStatus(office)
      .then((data) => {
        if (!live) return;
        setLoad({ state: "ready", data });
        if (data.offices && data.offices.length > 0) setOffices(data.offices);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoad({ state: "error", message: err instanceof Error ? err.message : "Unknown error" });
      });
    return () => {
      live = false;
    };
  }, [office, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <Card data-testid="practice-setup-card">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck size={18} className="text-primary" /> Practice setup
          </CardTitle>
          <label className="text-sm text-muted-foreground flex items-center gap-2">
            Office
            <select
              className="border border-input bg-background rounded-md px-2 py-1 text-sm text-foreground"
              value={office}
              onChange={(e) => setOffice(e.target.value)}
              data-testid="setup-office-picker"
            >
              {offices.map((o) => (
                <option key={o.officeId} value={o.officeId}>
                  {o.officeName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </CardHeader>
      <CardContent>
        {load.state === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4" data-testid="setup-loading">
            <Loader2 size={16} className="animate-spin" /> Checking this office's setup…
          </div>
        )}

        {load.state === "error" && (
          <div className="flex flex-wrap items-center gap-3 text-sm py-4" role="alert" data-testid="setup-error">
            <AlertTriangle size={16} className="text-destructive" />
            <span className="text-foreground">Could not check this office's setup. {load.message}</span>
            <Button size="sm" variant="outline" onClick={retry}>
              <RefreshCw size={14} className="mr-1" /> Try again
            </Button>
          </div>
        )}

        {load.state === "ready" && (
          <div className="space-y-3">
            <div>
              <div className="text-sm text-foreground mb-1.5" data-testid="setup-progress-label">
                {load.data.doneRequired} of {load.data.totalRequired} required steps done
              </div>
              <Progress
                value={load.data.totalRequired > 0 ? (load.data.doneRequired / load.data.totalRequired) * 100 : 0}
                aria-label={`${load.data.doneRequired} of ${load.data.totalRequired} required steps done`}
              />
            </div>
            {load.data.steps.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="setup-empty">
                No setup steps apply to this office.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {load.data.steps.map((s) => (
                  <StepRow key={s.id} step={s} props={props} />
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
