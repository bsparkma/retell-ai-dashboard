/**
 * Before & After gallery grid (Slice 4).
 *
 * Reads tc_gallery_cases via listGallery; every image renders through
 * tcMediaUrl (entitlement-checked byte proxy). Until Azure Blob is wired in
 * staging the proxy 503s MEDIA_STORE_UNCONFIGURED — TcMediaImage degrades to
 * an honest placeholder instead of a broken-image glyph.
 *
 * No upload UI: Slice 4 has no upload endpoint. "Add case" references an
 * existing media key (importer-provisioned) by text — direct uploads arrive
 * with the media pipeline.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ImageOff, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { OfficeId, TcGalleryCase } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  createGalleryCase,
  deleteGalleryCase,
  listGallery,
  tcErrorMessage,
  tcMediaUrl,
} from "../api";

// ── Shared media <img> with graceful degradation ────────────────────────────

/**
 * The ONLY way TC media renders an image. Broken loads (403/404/503
 * MEDIA_STORE_UNCONFIGURED) swap to a placeholder box instead of the browser's
 * broken-image glyph. Reused by SmileSimList and the presentation deck.
 */
export function TcMediaImage({
  office,
  blobKey,
  alt,
  label,
  className = "",
}: {
  office: OfficeId;
  blobKey: string;
  alt: string;
  /** Optional corner tag, e.g. "Before" / "After". */
  label?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [office, blobKey]);

  if (broken) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1.5 bg-muted/60 text-muted-foreground ${className}`}
      >
        <ImageOff className="w-5 h-5" aria-hidden />
        <span className="text-[10px] leading-tight text-center px-2">
          Media store not connected
        </span>
      </div>
    );
  }
  return (
    <div className={`relative overflow-hidden ${className}`}>
      <img
        src={tcMediaUrl(office, blobKey)}
        alt={alt}
        className="w-full h-full object-cover"
        onError={() => setBroken(true)}
      />
      {label && (
        <span className="absolute top-1.5 left-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          {label}
        </span>
      )}
    </div>
  );
}

/** Side-by-side before/after (or original/result) pair. */
export function TcMediaPair({
  office,
  beforeKey,
  afterKey,
  beforeLabel,
  afterLabel,
  altBase,
  heightClass = "h-40",
}: {
  office: OfficeId;
  beforeKey: string;
  afterKey: string;
  beforeLabel: string;
  afterLabel: string;
  altBase: string;
  heightClass?: string;
}) {
  return (
    <div className={`flex ${heightClass}`}>
      <TcMediaImage
        office={office}
        blobKey={beforeKey}
        alt={`${altBase} — ${beforeLabel.toLowerCase()}`}
        label={beforeLabel}
        className="flex-1 min-w-0"
      />
      <div className="w-px bg-border" aria-hidden />
      <TcMediaImage
        office={office}
        blobKey={afterKey}
        alt={`${altBase} — ${afterLabel.toLowerCase()}`}
        label={afterLabel}
        className="flex-1 min-w-0"
      />
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Add-case dialog ─────────────────────────────────────────────────────────

interface AddForm {
  title: string;
  category: string;
  description: string;
  doctorName: string;
  beforeBlobKey: string;
  afterBlobKey: string;
}

const EMPTY_FORM: AddForm = {
  title: "",
  category: "",
  description: "",
  doctorName: "",
  beforeBlobKey: "",
  afterBlobKey: "",
};

function AddCaseDialog({
  office,
  open,
  onOpenChange,
  onCreated,
}: {
  office: OfficeId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: TcGalleryCase) => void;
}) {
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<AddForm>) => setForm((f) => ({ ...f, ...patch }));

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setForm(EMPTY_FORM);
      setFormError(null);
    }
    onOpenChange(next);
  };

  const save = async () => {
    if (!form.title.trim()) {
      setFormError("Title is required.");
      return;
    }
    if (!form.beforeBlobKey.trim() || !form.afterBlobKey.trim()) {
      setFormError("Both a before and an after media key are required.");
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const created = await createGalleryCase(office, {
        title: form.title.trim(),
        beforeBlobKey: form.beforeBlobKey.trim(),
        afterBlobKey: form.afterBlobKey.trim(),
        ...(form.category.trim() ? { category: form.category.trim() } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.doctorName.trim() ? { doctorName: form.doctorName.trim() } : {}),
      });
      toast.success("Gallery case added");
      onCreated(created);
      handleOpenChange(false);
    } catch (e) {
      // Confirmed-save rule: failures keep the dialog open.
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add gallery case</DialogTitle>
          <DialogDescription>
            Add a before &amp; after case for patient presentations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="gallery-title">Title</Label>
            <Input
              id="gallery-title"
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="e.g. Porcelain veneer smile makeover"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gallery-category">Category</Label>
              <Input
                id="gallery-category"
                value={form.category}
                onChange={(e) => set({ category: e.target.value })}
                placeholder="e.g. Veneers"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gallery-doctor">Doctor</Label>
              <Input
                id="gallery-doctor"
                value={form.doctorName}
                onChange={(e) => set({ doctorName: e.target.value })}
                placeholder="Dr. Sparkman"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gallery-description">Description</Label>
            <Textarea
              id="gallery-description"
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="e.g. 10 upper and lower veneers, full smile transformation"
              rows={2}
            />
          </div>

          <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              References an existing media key — direct uploads arrive with the
              media pipeline.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="gallery-before-key">Before media key</Label>
                <Input
                  id="gallery-before-key"
                  value={form.beforeBlobKey}
                  onChange={(e) => set({ beforeBlobKey: e.target.value })}
                  placeholder="gallery/…-before.jpg"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gallery-after-key">After media key</Label>
                <Input
                  id="gallery-after-key"
                  value={form.afterBlobKey}
                  onChange={(e) => set({ afterBlobKey: e.target.value })}
                  placeholder="gallery/…-after.jpg"
                />
              </div>
            </div>
          </div>

          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            {saving ? "Saving…" : "Add case"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Grid ────────────────────────────────────────────────────────────────────

export function GalleryGrid({ office }: { office: OfficeId }) {
  const [cases, setCases] = useState<TcGalleryCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TcGalleryCase | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listGallery(office)
      .then(setCases)
      .catch((e: unknown) => setLoadError(tcErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [office]);

  useEffect(() => {
    load();
  }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteGalleryCase(office, deleteTarget.galleryId);
      toast.success("Gallery case deleted");
      setCases((prev) => prev.filter((c) => c.galleryId !== deleteTarget.galleryId));
      setDeleteTarget(null);
    } catch (e) {
      // Failure keeps the confirm dialog open.
      toast.error(tcErrorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Visual before &amp; after cases for patient presentations.
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="w-4 h-4" /> Add case
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading gallery…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
            <RefreshCw className="w-4 h-4" /> Retry
          </Button>
        </div>
      ) : cases.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ImageOff className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground max-w-sm">
            No gallery cases yet for this office. Add your first before &amp;
            after case to use in presentations.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {cases.map((item) => (
            <div
              key={item.galleryId}
              className="group relative overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md"
            >
              <button
                type="button"
                aria-label={`Delete ${item.title}`}
                className="absolute top-2 right-2 z-10 rounded-full bg-black/50 p-1.5 text-white opacity-0 transition-opacity hover:bg-red-600 focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => setDeleteTarget(item)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              <TcMediaPair
                office={office}
                beforeKey={item.beforeBlobKey}
                afterKey={item.afterBlobKey}
                beforeLabel="Before"
                afterLabel="After"
                altBase={item.title}
              />

              <div className="p-3 space-y-1.5">
                <div className="text-sm font-semibold text-foreground leading-snug">
                  {item.title}
                </div>
                {item.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {item.category && (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
                    >
                      {item.category}
                    </Badge>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {item.doctorName ? `${item.doctorName} · ` : ""}
                    {formatDate(item.createdAt)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddCaseDialog
        office={office}
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(created) => setCases((prev) => [created, ...prev])}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete gallery case?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.title}" will be permanently removed from the gallery. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            {/* Plain button (not AlertDialogAction) so a failed delete keeps the dialog open. */}
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
