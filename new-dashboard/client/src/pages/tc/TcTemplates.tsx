/**
 * /tc/templates — email template library.
 *
 * Lists templates with category chip, usage (total / last 30d), seed lock.
 * Seeded templates can't be deleted (backend 409 SEED_TEMPLATE_PROTECTED —
 * the delete action is hidden for them anyway, and the error is caught with a
 * friendly toast just in case). "New template" creates a minimal starter
 * (header + text + signature + footer) then jumps into the editor.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Copy,
  FileText,
  Loader2,
  Lock,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { TcEmailTemplate } from "@shared/tc/contract";
import {
  TcApiError,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
  tcErrorMessage,
  templateUsage,
  type TemplateUsage,
} from "@/features/tc/api";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import { TEMPLATE_CATEGORY_LABELS, starterBlocks } from "@/features/tc/email/blockFactory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function TcTemplates() {
  const office = useTcOffice();
  const [, setLocation] = useLocation();

  const [templates, setTemplates] = useState<TcEmailTemplate[]>([]);
  const [usage, setUsage] = useState<Record<string, TemplateUsage>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [creating, setCreating] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TcEmailTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!office) return;
    setLoading(true);
    setLoadError(null);
    // Usage is best-effort — an empty communications log must not block the list.
    Promise.all([
      listTemplates(office),
      templateUsage(office).catch(() => ({}) as Record<string, TemplateUsage>),
    ])
      .then(([t, u]) => {
        setTemplates(t);
        setUsage(u);
      })
      .catch((e: unknown) => setLoadError(tcErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [office]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const list = q
      ? templates.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.subject.toLowerCase().includes(q) ||
            TEMPLATE_CATEGORY_LABELS[t.category].toLowerCase().includes(q),
        )
      : templates;
    return list
      .slice()
      .sort((a, b) => (a.isSeed === b.isSeed ? a.name.localeCompare(b.name) : a.isSeed ? -1 : 1));
  }, [templates, search]);

  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  const handleCreate = async () => {
    setCreating(true);
    try {
      const t = await createTemplate(office, {
        name: "Untitled template",
        category: "general",
        subject: "Subject line",
        preheader: "",
        blocks: starterBlocks(),
      });
      toast.success("Template created");
      setLocation(`/tc/templates/${t.templateId}`);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const handleDuplicate = async (t: TcEmailTemplate) => {
    setDuplicatingId(t.templateId);
    try {
      const copy = await duplicateTemplate(office, t.templateId);
      toast.success(`Duplicated as "${copy.name}"`);
      load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteTemplate(office, deleteTarget.templateId);
      setTemplates((prev) => prev.filter((t) => t.templateId !== deleteTarget.templateId));
      toast.success(`"${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
    } catch (e) {
      if (e instanceof TcApiError && e.code === "SEED_TEMPLATE_PROTECTED") {
        toast.error("Seeded templates can't be deleted — duplicate them to customize instead.");
        setDeleteTarget(null);
      } else {
        toast.error(tcErrorMessage(e));
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <TcPageHeader
        title="Email Templates"
        subtitle="Block-based templates for patient emails. Seeded templates are starting points — duplicate them to customize."
        actions={
          <>
            <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button onClick={() => void handleCreate()} disabled={creating}>
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              New template
            </Button>
          </>
        }
      />

      <div className="relative mb-4 max-w-sm">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates…"
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading templates…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <Mail className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {search ? "No templates match your search." : "No templates yet — create your first one."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => {
            const u = usage[t.templateId] ?? { total: 0, last30Days: 0 };
            return (
              <div
                key={t.templateId}
                className="rounded-xl border border-border bg-card p-4 shadow-sm flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate flex items-center gap-1.5">
                      <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{t.name}</span>
                      {t.isSeed && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Lock className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-label="Seeded template" />
                          </TooltipTrigger>
                          <TooltipContent>Seeded template — duplicate to customize; can't be deleted</TooltipContent>
                        </Tooltip>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1">{t.subject}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className="border-transparent bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300 shrink-0"
                  >
                    {TEMPLATE_CATEGORY_LABELS[t.category]}
                  </Badge>
                </div>

                <p className="text-xs text-muted-foreground">
                  Used <span className="font-medium text-foreground tabular-nums">{u.total}</span> time{u.total === 1 ? "" : "s"}
                  {" · "}
                  <span className="font-medium text-foreground tabular-nums">{u.last30Days}</span> in last 30 days
                </p>

                <div className="flex items-center gap-1.5 mt-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setLocation(`/tc/templates/${t.templateId}`)}
                  >
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDuplicate(t)}
                    disabled={duplicatingId === t.templateId}
                    aria-label={`Duplicate ${t.name}`}
                  >
                    {duplicatingId === t.templateId ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </Button>
                  {!t.isSeed && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 dark:text-red-400 hover:text-red-600"
                      onClick={() => setDeleteTarget(t)}
                      aria-label={`Delete ${t.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this template?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `"${deleteTarget.name}" will be permanently deleted. This cannot be undone.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => {
                e.preventDefault(); // stay open until the API resolves
                void handleDeleteConfirmed();
              }}
            >
              {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
