/**
 * /platform — the Platform Console (PR C).
 *
 * The super_admin's home for the things that used to be a runbook or a browser
 * console: which practices exist, what each one has bought, who works there,
 * what they did, and how long calls are kept.
 *
 * THE GATING HERE IS COSMETIC. Every endpoint behind this page sits behind
 * `requireSuperAdmin()` — a tenant admin holds `admin.all`, reaches every other
 * admin surface in the product, and still gets 403 from all of them. What this
 * file adds is an honest dead-end instead of a screen full of failed requests.
 *
 * WHY THE TOP-LEVEL SPLIT IS "Practices" vs "Call store". Retention is a
 * PLATFORM-WIDE setting: the call store is one JSON file for the whole process
 * and has no tenant dimension (see docs/PLATFORM_CONSOLE.md). Nesting it under a
 * selected practice would imply a per-practice policy the pruner cannot honour —
 * the tab boundary is the scoping, made visible.
 */
import { useEffect, useState } from "react";
import { ShieldAlert, Building2, Database } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { api, ApiError } from "@/lib/api";
import type { Practice } from "@/lib/api";
import PracticesPanel from "./platform/PracticesPanel";
import RetentionPanel from "./platform/RetentionPanel";

/** The message to show for a failed request — the server's, whenever it sent one. */
export function loadError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong";
}

/**
 * The dead-end for anyone who is not a platform administrator.
 *
 * Deliberately not a redirect. `/platform` is absent from ROUTE_PERMISSIONS, so
 * the shell's courtesy redirect leaves it alone and someone who follows a link
 * here lands on an explanation rather than being bounced somewhere else with no
 * account of why. Naming the tier is the point: "ask a platform administrator"
 * is actionable; a blank page is not.
 */
function AccessRequired() {
  return (
    <div
      className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center"
      data-testid="platform-access-required"
    >
      <ShieldAlert className="h-8 w-8 text-muted-foreground" />
      <h1 className="text-lg font-semibold text-foreground">Platform access required</h1>
      <p className="text-sm text-muted-foreground">
        The platform console manages every practice on CareIN, so it is limited to platform
        administrators. Your practice&apos;s own settings and people are under Admin.
      </p>
    </div>
  );
}

export default function Platform() {
  const auth = useAuth();
  const isSuperAdmin = auth.status === "authenticated" && auth.user.isSuperAdmin === true;

  const [practices, setPractices] = useState<Practice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Not merely "don't render" — don't ASK. Firing eight requests we know will
    // 403 would fill the audit trail and the console with noise on every visit
    // by someone who took a wrong link.
    if (!isSuperAdmin) return;
    let live = true;
    api
      .listPractices()
      .then((rows) => {
        if (!live) return;
        setPractices(rows);
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setPractices(null);
        setError(loadError(e));
      });
    return () => {
      live = false;
    };
  }, [isSuperAdmin]);

  if (auth.status !== "authenticated") return null;
  if (!isSuperAdmin) return <AccessRequired />;

  return (
    <div className="space-y-6 p-6" data-testid="platform-console">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Platform</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every practice on CareIN, and the settings that apply across all of them.
        </p>
      </header>

      <Tabs defaultValue="practices">
        <TabsList>
          <TabsTrigger value="practices" data-testid="tab-practices">
            <Building2 className="mr-1.5 h-3.5 w-3.5" />
            Practices
          </TabsTrigger>
          <TabsTrigger value="call-store" data-testid="tab-call-store">
            <Database className="mr-1.5 h-3.5 w-3.5" />
            Call store
          </TabsTrigger>
        </TabsList>

        <TabsContent value="practices" className="mt-4">
          <PracticesPanel
            practices={practices}
            error={error}
            onPracticesChange={setPractices}
          />
        </TabsContent>

        <TabsContent value="call-store" className="mt-4">
          {/* Platform-wide, not per-practice — see the note at the top. */}
          <RetentionPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
