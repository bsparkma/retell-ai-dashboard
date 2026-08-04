/**
 * Objections tab — log and review patient objections. Category comes from the
 * library "objections" section when the office has configured it (Select),
 * otherwise free text. Delete requires an alert-dialog confirm (patientWords is
 * verbatim PHI — no accidental destruction).
 */
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { LibraryObjection, OfficeId, TcCase } from "@shared/tc/contract";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, MessageSquareWarning, Plus, Trash2 } from "lucide-react";
import { addObjection, deleteObjection, getLibrarySection, tcErrorMessage } from "../api";

type LibraryObjectionEntry = z.infer<typeof LibraryObjection>;

export interface ObjectionsTabProps {
  office: OfficeId;
  tcCase: TcCase;
  onCaseUpdate: (updated: TcCase) => void;
}

export function ObjectionsTab({ office, tcCase, onCaseUpdate }: ObjectionsTabProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** null = section unconfigured → free-text category input. */
  const [libraryObjections, setLibraryObjections] = useState<LibraryObjectionEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLibrarySection(office, "objections")
      .then((value) => {
        if (!cancelled) setLibraryObjections(value.length > 0 ? value : null);
      })
      .catch(() => {
        // 404 (unconfigured) or any failure → free-text entry still works.
        if (!cancelled) setLibraryObjections(null);
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  const objections = [...tcCase.objections].sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteObjection(office, tcCase.caseId, deleteTarget);
      toast.success("Objection deleted");
      onCaseUpdate({
        ...tcCase,
        objections: tcCase.objections.filter((o) => o.objectionId !== deleteTarget),
      });
      setDeleteTarget(null);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {objections.length === 0
            ? "No objections logged."
            : `${objections.length} objection${objections.length === 1 ? "" : "s"} logged`}
        </p>
        <Button variant="outline" onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          Log objection
        </Button>
      </div>

      {objections.map((obj) => (
        <Card key={obj.objectionId}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <MessageSquareWarning size={14} className="text-amber-600 dark:text-amber-400" />
                  <span className="text-sm font-semibold text-foreground">{obj.category}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(obj.loggedAt).toLocaleString()}
                  </span>
                </div>
                {obj.patientWords && (
                  <p className="text-sm text-foreground italic">“{obj.patientWords}”</p>
                )}
                {obj.note && <p className="text-sm text-muted-foreground">{obj.note}</p>}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete objection"
                onClick={() => setDeleteTarget(obj.objectionId)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <AddObjectionDialog
        key={addOpen ? "open" : "closed"}
        office={office}
        tcCase={tcCase}
        libraryObjections={libraryObjections}
        open={addOpen}
        onOpenChange={setAddOpen}
        onCaseUpdate={onCaseUpdate}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this objection?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the logged objection, including the patient's words. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting && <Loader2 className="animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddObjectionDialog({
  office,
  tcCase,
  libraryObjections,
  open,
  onOpenChange,
  onCaseUpdate,
}: {
  office: OfficeId;
  tcCase: TcCase;
  libraryObjections: LibraryObjectionEntry[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCaseUpdate: (updated: TcCase) => void;
}) {
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [patientWords, setPatientWords] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (category.trim() === "") {
      setInlineError("Pick or enter an objection category.");
      return;
    }
    setInlineError(null);
    setSubmitting(true);
    try {
      const objection = await addObjection(office, tcCase.caseId, {
        category: category.trim(),
        note,
        patientWords,
      });
      toast.success("Objection logged");
      onCaseUpdate({ ...tcCase, objections: [...tcCase.objections, objection] });
      onOpenChange(false);
    } catch (e) {
      toast.error(tcErrorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log objection</DialogTitle>
          <DialogDescription>{tcCase.patientName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tc-objection-category">Category</Label>
            {libraryObjections ? (
              <Select value={category || undefined} onValueChange={setCategory}>
                <SelectTrigger id="tc-objection-category" className="w-full">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {libraryObjections.map((o) => (
                    <SelectItem key={o.key} value={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="tc-objection-category"
                value={category}
                placeholder="e.g. Cost concern"
                onChange={(e) => setCategory(e.target.value)}
              />
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tc-objection-words">Patient's words (verbatim)</Label>
            <Textarea
              id="tc-objection-words"
              value={patientWords}
              rows={2}
              placeholder="What the patient actually said…"
              onChange={(e) => setPatientWords(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tc-objection-note">Note</Label>
            <Textarea
              id="tc-objection-note"
              value={note}
              rows={3}
              placeholder="Context, response, next step…"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {inlineError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {inlineError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            Log objection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
