/**
 * The practice catalog, and the entitlement kill switch.
 *
 * CREATING A PRACTICE IS NOT HERE, on purpose. Provisioning means a database,
 * Key Vault secrets and migrations; it stays the `platform/provisionTenant.js`
 * runbook. A button that half-provisions is worse than no button.
 *
 * THE TOGGLE RENDERS THE DATABASE'S ANSWER. `setPracticeModule` returns the
 * module set as the server re-read it after the write, and that is what lands in
 * state — never the value the click sent. A write that silently did nothing must
 * not be able to look like a success.
 */
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Users as UsersIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { Practice, PracticeModule } from "@/lib/api";
import { loadError } from "../Platform";
import PracticeUsersPanel from "./PracticeUsersPanel";
import PracticeAuditPanel from "./PracticeAuditPanel";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** The flip awaiting confirmation. Held as state so the dialog can name it. */
interface PendingFlip {
  practice: Practice;
  module: PracticeModule;
  enabled: boolean;
}

/**
 * The confirm dialog.
 *
 * It states the BLAST RADIUS with the practice's real name and its roster size,
 * because "turn off tc?" and "hide the TC module for all 13 people at Smith
 * Dental, now" are the same click and only one of them is a decision.
 *
 * Turning something ON gets a confirm too, just a calmer one — granting a module
 * a practice has not bought is also not a click to make by accident.
 */
function FlipConfirmDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingFlip | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const off = pending ? !pending.enabled : false;
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="module-confirm">
        {pending && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {off && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                {off ? `Turn off ${pending.module.label}?` : `Turn on ${pending.module.label}?`}
              </DialogTitle>
              <DialogDescription data-testid="module-confirm-blast-radius">
                {off ? (
                  <>
                    Turning off <strong>{pending.module.module}</strong> hides the{" "}
                    {pending.module.label} module for every user at{" "}
                    <strong>{pending.practice.displayName}</strong> immediately — all{" "}
                    {pending.practice.userCount} of them, on their next request. Their data is
                    not deleted, and turning it back on restores access.
                  </>
                ) : (
                  <>
                    Turning on <strong>{pending.module.module}</strong> gives all{" "}
                    {pending.practice.userCount} users at{" "}
                    <strong>{pending.practice.displayName}</strong> access to{" "}
                    {pending.module.label}, subject to their own role.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant={off ? "destructive" : "default"}
                onClick={onConfirm}
                disabled={busy}
                data-testid="module-confirm-accept"
              >
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {off ? `Turn off ${pending.module.label}` : `Turn on ${pending.module.label}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function PracticesPanel({
  practices,
  error,
  onPracticesChange,
}: {
  practices: Practice[] | null;
  error: string | null;
  onPracticesChange: (rows: Practice[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingFlip | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (practices === null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading practices…
      </div>
    );
  }
  if (practices.length === 0) {
    // Distinct from the loading state above: "we asked and there are none" is a
    // different fact from "we have not asked yet", and a spinner that never
    // resolves is how an empty answer gets mistaken for a broken one.
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        No practices are registered. Provisioning a practice is a runbook —
        <code className="mx-1">platform/provisionTenant.js</code>— not a button here.
      </div>
    );
  }

  const selected = practices.find((p) => p.tenantId === selectedId) ?? null;

  const commitFlip = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const modules = await api.setPracticeModule(
        pending.practice.tenantId,
        pending.module.module,
        pending.enabled,
      );
      // The SERVER's readback replaces the row. Nothing optimistic.
      onPracticesChange(
        practices.map((p) => (p.tenantId === pending.practice.tenantId ? { ...p, modules } : p)),
      );
      const now = modules.find((m) => m.module === pending.module.module);
      toast.success(
        `${pending.module.label} is ${now?.enabled ? "on" : "off"} for ${pending.practice.displayName}`,
      );
      setPending(null);
    } catch (e) {
      // The server's message, not ours. A failed flip stays visibly unflipped:
      // the switch is driven by `practices`, which we did not touch.
      toast.error(loadError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="practices-table">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Practice</th>
                <th className="px-4 py-2.5 font-medium">Slug</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Modules</th>
                <th className="px-4 py-2.5 font-medium">Users</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {practices.map((p) => {
                const active = p.tenantId === selectedId;
                return (
                  <tr
                    key={p.tenantId}
                    onClick={() => setSelectedId(active ? null : p.tenantId)}
                    className={`cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40 ${
                      active ? "bg-muted/60" : ""
                    }`}
                    data-testid={`practice-row-${p.slug}`}
                  >
                    <td className="px-4 py-3 font-medium text-foreground">{p.displayName}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{p.slug}</td>
                    <td className="px-4 py-3">
                      <Badge variant={p.status === "active" ? "secondary" : "outline"}>
                        {p.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {p.modules.filter((m) => m.enabled).length === 0 ? (
                          <span className="text-xs text-muted-foreground">none</span>
                        ) : (
                          p.modules
                            .filter((m) => m.enabled)
                            .map((m) => (
                              <Badge key={m.module} variant="outline" className="font-mono text-[11px]">
                                {m.module}
                              </Badge>
                            ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <UsersIcon className="h-3.5 w-3.5" />
                        {p.userCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(p.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {selected === null ? (
        <p className="px-1 text-sm text-muted-foreground">
          Select a practice to manage its modules, see who works there, and read its audit trail.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-card" data-testid="practice-detail">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">{selected.displayName}</h2>
          </div>

          <Tabs defaultValue="modules" className="p-4">
            <TabsList>
              <TabsTrigger value="modules" data-testid="tab-modules">Modules</TabsTrigger>
              <TabsTrigger value="users" data-testid="tab-users">Users</TabsTrigger>
              <TabsTrigger value="audit" data-testid="tab-audit">Audit</TabsTrigger>
            </TabsList>

            <TabsContent value="modules" className="mt-4 space-y-2">
              {selected.modules.map((m) => (
                <div
                  key={m.module}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{m.label}</span>
                      <code className="text-[11px] text-muted-foreground">{m.module}</code>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{m.blurb}</p>
                  </div>
                  <Switch
                    checked={m.enabled}
                    // Never flips on click. The click opens the dialog; only the
                    // server's readback moves this.
                    onCheckedChange={(next) =>
                      setPending({ practice: selected, module: m, enabled: next })
                    }
                    aria-label={`${m.label} for ${selected.displayName}`}
                    data-testid={`module-switch-${m.module}`}
                  />
                </div>
              ))}
            </TabsContent>

            <TabsContent value="users" className="mt-4">
              <PracticeUsersPanel practice={selected} />
            </TabsContent>

            <TabsContent value="audit" className="mt-4">
              <PracticeAuditPanel practice={selected} />
            </TabsContent>
          </Tabs>
        </div>
      )}

      <FlipConfirmDialog
        pending={pending}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={commitFlip}
      />
    </div>
  );
}
