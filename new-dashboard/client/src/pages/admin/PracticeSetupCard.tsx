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
 * bounce. Otherwise the row says who sets it. A step the How-to-fix map marks
 * `go: false` (P8) has no Go at all: no screen can fix it.
 *
 * HOW TO FIX (setup polish). Each step that is not done has a "How to fix"
 * button. It opens a side panel (a bottom sheet on a phone) that is NOT modal
 * and does not close when the page behind it is used, so it stays open while
 * the office manager works. It shows the step's current detail line from the
 * server, the plain steps from ./setupHowToFix.ts, the step's Go link (when it
 * has one and the viewer could open it), and "Check again" to re-read.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, HelpCircle, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { canVisit } from "@/lib/permissions";
import { hasModule } from "@/lib/modules";
import { OfficeId } from "@shared/tc/contract";
import { fetchSetupStatus, type SetupStatus, type SetupStep } from "./setupStatusApi";
import { howToFixFor, stepHasGo } from "./setupHowToFix";

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

/** Whether this row (and its panel) shows a Go link. */
function showsGo(step: SetupStep, props: PracticeSetupCardProps): boolean {
  return stepHasGo(step.id) && linkOpens(step.link, props);
}

function HowToFixPanel({
  step,
  props,
  onClose,
  onCheckAgain,
}: {
  step: SetupStep | null;
  props: PracticeSetupCardProps;
  onClose: () => void;
  onCheckAgain: () => void;
}) {
  // A side panel from 768px up; below that (or with no matchMedia at all) a
  // bottom sheet, the layout that cannot be crushed.
  const isMobile = !useMediaQuery("(min-width: 768px)");
  const help = step ? howToFixFor(step.id) : null;
  return (
    <Sheet open={step !== null && help !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={isMobile ? "max-h-[85vh] overflow-y-auto" : "overflow-y-auto"}
        // Not modal, and the page stays usable: clicking or scrolling behind
        // the panel must not close it. Esc and the X still do.
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="setup-howto-panel"
        data-side={isMobile ? "bottom" : "right"}
      >
        {step && help && (
          <>
            <SheetHeader className="pr-10">
              <SheetTitle>How to fix: {step.title}</SheetTitle>
              <SheetDescription data-testid="setup-howto-detail">{step.detail}</SheetDescription>
            </SheetHeader>
            <ol className="list-decimal space-y-2 px-4 pl-8 text-sm text-foreground" data-testid="setup-howto-steps">
              {help.steps.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
              {showsGo(step, props) ? (
                <Button asChild size="sm">
                  <Link href={step.link} data-testid="setup-howto-go">
                    Go <ChevronRight size={14} />
                  </Link>
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={onCheckAgain} data-testid="setup-howto-recheck">
                <RefreshCw size={14} className="mr-1" aria-hidden /> Check again
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function StepRow({
  step,
  props,
  onHowToFix,
}: {
  step: SetupStep;
  props: PracticeSetupCardProps;
  onHowToFix: (id: string) => void;
}) {
  const done = step.status === "done";
  const opens = showsGo(step, props);
  const help = !done && howToFixFor(step.id) !== null;
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
        {help && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 mt-1 text-xs"
            onClick={() => onHowToFix(step.id)}
            data-testid={`setup-howto-${step.id}`}
          >
            <HelpCircle size={13} className="mr-1" aria-hidden /> How to fix
          </Button>
        )}
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
  /** The step whose How-to-fix panel is open, by id (its detail is read live from the answer). */
  const [helpFor, setHelpFor] = useState<string | null>(null);
  /** The last good answer for THIS office (cleared on an office change). */
  const [lastReady, setLastReady] = useState<SetupStatus | null>(null);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    fetchSetupStatus(office)
      .then((data) => {
        if (!live) return;
        setLoad({ state: "ready", data });
        setLastReady(data);
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
  const closeHelp = useCallback(() => setHelpFor(null), []);
  // The open panel follows the latest answer: a re-check updates its detail
  // line, and a step that is now done (or gone, after an office change) closes it.
  // While a re-check is in flight it keeps the last answer, so it does not blink shut.
  const helpSource = load.state === "ready" ? load.data : lastReady;
  const helpStep =
    helpSource && helpFor !== null
      ? (helpSource.steps.find((s) => s.id === helpFor && s.status !== "done") ?? null)
      : null;

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
              onChange={(e) => {
                // Another office's steps: close any open panel and forget the old answer.
                setHelpFor(null);
                setLastReady(null);
                setOffice(e.target.value);
              }}
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
                  <StepRow key={s.id} step={s} props={props} onHowToFix={setHelpFor} />
                ))}
              </ul>
            )}
          </div>
        )}
        <HowToFixPanel step={helpStep} props={props} onClose={closeHelp} onCheckAgain={retry} />
      </CardContent>
    </Card>
  );
}
