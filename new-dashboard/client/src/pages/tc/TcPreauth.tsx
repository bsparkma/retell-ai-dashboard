/**
 * /tc/preauth — insurance pre-authorization tracker.
 *
 * 7-column board (PREAUTH_BOARD_STATUSES); transitions go through
 * transitionPreauth so the server stamps submittedDate/decisionDate — the
 * board re-renders from the returned row, never from optimistic guesses.
 * That holds for drag-and-drop too: handleTransition is awaited by the board,
 * which keeps the dragged card in its original column until this resolves.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import type { TcPreauthCase } from "@shared/tc/contract";
import { deletePreauth, listPreauth, tcErrorMessage, transitionPreauth } from "@/features/tc/api";
import { PREAUTH_STATUSES, type PreauthStatusId } from "@/features/tc/status";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import { PreauthBoard } from "@/features/tc/preauth/PreauthBoard";
import { PreauthDialog } from "@/features/tc/preauth/PreauthDialog";
import { Button } from "@/components/ui/button";
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

export default function TcPreauth() {
  const office = useTcOffice();
  const [cases, setCases] = useState<TcPreauthCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TcPreauthCase | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TcPreauthCase | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    if (!office) return;
    setLoading(true);
    setLoadError(null);
    listPreauth(office)
      .then(setCases)
      .catch((e: unknown) => setLoadError(tcErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [office]);

  useEffect(() => {
    load();
  }, [load]);

  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  const replaceRow = (row: TcPreauthCase) =>
    setCases((prev) => prev.map((c) => (c.preauthId === row.preauthId ? row : c)));

  const handleTransition = async (preauth: TcPreauthCase, status: PreauthStatusId) => {
    try {
      const updated = await transitionPreauth(office, preauth.preauthId, status);
      replaceRow(updated);
      toast.success(`${updated.patientName} moved to ${PREAUTH_STATUSES[updated.status].label}`);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    }
  };

  const handleSaved = (saved: TcPreauthCase, mode: "created" | "updated") => {
    if (mode === "created") setCases((prev) => [saved, ...prev]);
    else replaceRow(saved);
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePreauth(office, deleteTarget.preauthId);
      setCases((prev) => prev.filter((c) => c.preauthId !== deleteTarget.preauthId));
      toast.success(`${deleteTarget.patientName} removed from pre-auth tracking`);
      setDeleteTarget(null);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6">
      <TcPageHeader
        title="Pre-Authorizations"
        subtitle="Track insurance pre-auth cases from submission to decision"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="w-4 h-4" /> New pre-auth
            </Button>
          </>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading pre-auth cases…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      ) : (
        <PreauthBoard
          cases={cases}
          onTransition={handleTransition}
          onEdit={(p) => {
            setEditing(p);
            setDialogOpen(true);
          }}
          onDelete={setDeleteTarget}
        />
      )}

      <PreauthDialog
        office={office}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={handleSaved}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this pre-auth?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${deleteTarget.patientName}'s pre-authorization will be permanently removed. This cannot be undone.`
                : ""}
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
