/**
 * Settings → Providers: the office's provider directory.
 *
 * The list the referral's "Referring provider" and the pre-auth's "Doctor"
 * pick from. The app owns it:
 *  - add a provider by hand, edit a name or credential, mark one inactive
 *    (inactive providers drop out of the pick; nothing that already names
 *    them changes). There is no delete.
 *  - "Import from Open Dental" reads this office's providers ONCE, read-only,
 *    and merges them in: new ones added, names of ones already imported
 *    updated, nothing removed or deactivated. There is no automatic sync —
 *    the button is the refresh.
 *
 * A practice admin or office manager changes it (the server says so in
 * `canEdit` and refuses everyone else); everyone else here sees the list.
 * Every row shown is what the server returned after it stored the change.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DownloadCloud, Loader2, Pencil, Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { tcErrorMessage } from "@/features/tc/api";
import {
  createProvider,
  importProviders,
  listProviders,
  updateProvider,
} from "@/features/tc/providers/providersApi";
import type { OfficeId } from "@shared/tc/contract";
import {
  TC_PROVIDER_NAME_MAX,
  TC_PROVIDER_SUFFIX_MAX,
  TcProviderInput,
  type TcProviderEntry,
  type TcProviderImportResponse,
} from "@shared/tc/providers";

interface Draft {
  name: string;
  credentialSuffix: string;
  active: boolean;
}

const EMPTY: Draft = { name: "", credentialSuffix: "", active: true };

/** What an import did, in words. Pure. */
export function importSummary(r: Pick<TcProviderImportResponse, "added" | "updated" | "unchanged" | "skippedHidden" | "skippedHygienists" | "skippedNoName">): string {
  const parts = [`${r.added} added`, `${r.updated} updated`, `${r.unchanged} already up to date`];
  const skipped: string[] = [];
  if (r.skippedHidden) skipped.push(`${r.skippedHidden} hidden in Open Dental`);
  if (r.skippedHygienists) skipped.push(`${r.skippedHygienists} hygienist${r.skippedHygienists === 1 ? "" : "s"}`);
  if (r.skippedNoName) skipped.push(`${r.skippedNoName} with no name`);
  return `${parts.join(", ")}.${skipped.length ? ` Left out: ${skipped.join(", ")}.` : ""}`;
}

function ProviderDialog({
  open,
  editing,
  saving,
  onCancel,
  onSave,
}: {
  open: boolean;
  editing: TcProviderEntry | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: TcProviderInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(editing ? { name: editing.name, credentialSuffix: editing.credentialSuffix, active: editing.active } : EMPTY);
      setError(null);
    }
  }, [open, editing]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  }

  function submit() {
    // The same schema the server applies.
    const parsed = TcProviderInput.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form");
      return;
    }
    onSave(parsed.data);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent className="max-w-md" data-testid="tc-provider-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit provider" : "Add a provider"}</DialogTitle>
          <DialogDescription>
            {editing?.odProvNum
              ? "Imported from Open Dental. The next import updates the name from Open Dental again."
              : "Shown in the referring provider and pre-auth doctor lists."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="prov-name">Name *</Label>
            <Input
              id="prov-name"
              value={draft.name}
              maxLength={TC_PROVIDER_NAME_MAX}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Jane Smith"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="prov-suffix">Credential</Label>
            <Input
              id="prov-suffix"
              value={draft.credentialSuffix}
              maxLength={TC_PROVIDER_SUFFIX_MAX}
              onChange={(e) => set("credentialSuffix", e.target.value)}
              placeholder="DDS"
            />
          </div>
          <div className="sm:col-span-3 flex items-center gap-2">
            <Switch id="prov-active" checked={draft.active} onCheckedChange={(v) => set("active", v)} />
            <Label htmlFor="prov-active">Active (shows up when choosing a provider)</Label>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? "Save changes" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProvidersSection({ office }: { office: OfficeId }) {
  const [entries, setEntries] = useState<TcProviderEntry[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TcProviderEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastImport, setLastImport] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listProviders(office, showInactive)
      .then((r) => {
        setEntries(r.entries);
        setCanEdit(r.canEdit);
      })
      .catch((e: unknown) => setError(tcErrorMessage(e)));
  }, [office, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(input: TcProviderInput) {
    setSaving(true);
    try {
      if (editing) {
        await updateProvider(office, editing.providerId, input);
        toast.success("Provider saved");
      } else {
        await createProvider(office, input);
        toast.success("Provider added");
      }
      setDialogOpen(false);
      setEditing(null);
      load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function runImport() {
    setImporting(true);
    try {
      const r = await importProviders(office);
      const summary = importSummary(r);
      setLastImport(summary);
      toast.success(`Imported from Open Dental: ${summary}`);
      load();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setImporting(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="tc-providers-section">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-4 h-4 mr-1" aria-hidden /> Retry
        </Button>
      </div>
    );
  }
  if (!entries) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground" data-testid="tc-providers-section">
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
        <span className="text-sm">Loading providers…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="tc-providers-section">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold">Providers</CardTitle>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Switch id="prov-show-inactive" checked={showInactive} onCheckedChange={setShowInactive} />
                <Label htmlFor="prov-show-inactive" className="text-xs">
                  Show inactive
                </Label>
              </div>
              {canEdit && (
                <>
                  <Button size="sm" variant="outline" onClick={() => void runImport()} disabled={importing}>
                    {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                    Import from Open Dental
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(null);
                      setDialogOpen(true);
                    }}
                  >
                    <Plus className="w-4 h-4" />
                    Add provider
                  </Button>
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The names offered for a referral's referring provider and a pre-auth's doctor.
            {canEdit
              ? " Importing reads this office's Open Dental once and adds or renames providers; it never removes one — mark a provider inactive here instead."
              : " Only a practice admin or office manager can change this list."}
          </p>
          {lastImport && (
            <p className="text-xs text-muted-foreground" data-testid="tc-provider-import-summary">
              Last import: {lastImport}
            </p>
          )}
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {canEdit
                ? "No providers yet. Import them from Open Dental, or add them one at a time."
                : "No providers yet. Ask a practice admin or office manager to set them up."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Credential</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  {canEdit && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((p) => (
                  <TableRow key={p.providerId} data-testid="tc-provider-row">
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{p.credentialSuffix || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.odProvNum ? "Open Dental" : "Added here"}
                    </TableCell>
                    <TableCell>
                      {p.active ? (
                        <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline">Inactive</Badge>
                      )}
                    </TableCell>
                    {canEdit && (
                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => {
                            setEditing(p);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProviderDialog
        open={dialogOpen}
        editing={editing}
        saving={saving}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSave={(input) => void save(input)}
      />
    </div>
  );
}
