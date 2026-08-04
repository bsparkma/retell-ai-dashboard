/**
 * Smile simulation history (Slice 4).
 *
 * Read/delete only: rows come from the importer (and, later, Slice 7 AI
 * generation). The legacy generate flow is DISABLED here — the backend 501s
 * FEATURE_DISABLED — so where legacy had "New Simulation" this renders the
 * honest DisabledFeatureButton and never calls the generate endpoint.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ArrowUpRight, Loader2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { OfficeId, TcSmileSimulation } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DisabledFeatureButton, DisabledFeatureNote } from "../components/TcShell";
import { deleteSmileSim, listSmileSims, tcErrorMessage } from "../api";
import { TcMediaPair } from "./GalleryGrid";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function SmileSimList({ office }: { office: OfficeId }) {
  const [sims, setSims] = useState<TcSmileSimulation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TcSmileSimulation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listSmileSims(office)
      .then(setSims)
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
      await deleteSmileSim(office, deleteTarget.simId);
      toast.success("Simulation deleted");
      setSims((prev) => prev.filter((s) => s.simId !== deleteTarget.simId));
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
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          AI smile previews generated for patients, saved alongside their cases.
        </p>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <DisabledFeatureButton reason="slice7_ai" size="sm">
            <Sparkles className="w-4 h-4 mr-1.5" /> Generate simulation
          </DisabledFeatureButton>
          <DisabledFeatureNote reason="slice7_ai" />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading simulations…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
            <RefreshCw className="w-4 h-4" /> Retry
          </Button>
        </div>
      ) : sims.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Sparkles className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground max-w-sm">
            No smile simulations yet for this office.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {sims.map((sim) => (
            <div
              key={sim.simId}
              className="group relative overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md"
            >
              <button
                type="button"
                aria-label={`Delete ${sim.treatmentType} simulation`}
                className="absolute top-2 right-2 z-10 rounded-full bg-black/50 p-1.5 text-white opacity-0 transition-opacity hover:bg-red-600 focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => setDeleteTarget(sim)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              <TcMediaPair
                office={office}
                beforeKey={sim.originalBlobKey}
                afterKey={sim.resultBlobKey}
                beforeLabel="Original"
                afterLabel="Result"
                altBase={`${sim.treatmentType} simulation`}
              />

              <div className="p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground leading-snug">
                    {sim.treatmentType}
                  </span>
                  {sim.savedToGallery && (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    >
                      In gallery
                    </Badge>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {sim.createdBy ? `${sim.createdBy} · ` : ""}
                  {formatDate(sim.createdAt)}
                </div>
                {/* caseId is nullable on imported rows — render fine without. */}
                {sim.caseId && (
                  <Link
                    href={`/tc/cases/${sim.caseId}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    View case <ArrowUpRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete simulation?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `This ${deleteTarget.treatmentType} simulation will be permanently removed. This cannot be undone.`
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
