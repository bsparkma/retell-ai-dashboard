/**
 * Internal notes on a call — the list and the add box.
 *
 * ONE component, used in two places: inside a popover on the worklist row (jot
 * it where the work is) and as a card on the call-detail page. The team should
 * not have to leave the list to write down what happened on a call, and should
 * not have to remember two different affordances for the same thing.
 *
 * Notes are append-only. There is no edit control because there is no edit
 * route: a note reads as what was written at the time it was written. Delete is
 * offered only where it will actually succeed — the author's own notes, or any
 * note for an admin — and the server refuses the rest regardless of what the UI
 * chose to render.
 *
 * NOTHING here touches Open Dental or TC. A note is internal.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Trash2, StickyNote } from "lucide-react";
import { formatTimeAgo } from "@/lib/utils";
import type { CallNote } from "@/lib/api";

/** Same cap the server enforces (NOTE_MAX_LENGTH in backend/utils/callDispositions.js). */
export const NOTE_MAX_LENGTH = 2000;

interface CallNotesPanelProps {
  notes: CallNote[];
  /** Persist a new note. Rejects on failure — the box keeps the text so nothing is lost. */
  onAdd: (text: string) => Promise<void>;
  /** Remove a note. Only rendered for notes canDelete() approves. */
  onDelete: (noteId: string) => Promise<void>;
  /** The signed-in user's email, for "is this mine?". Null when unauthenticated. */
  actorEmail: string | null;
  /** Does the signed-in user hold admin (may delete anyone's note)? */
  actorIsAdmin: boolean;
  /** Cap the scroll height (the row popover is tighter than the detail page). */
  maxListHeight?: string;
}

/**
 * Author-or-admin, matched on email case-insensitively — the same rule the server
 * applies (see canDeleteNote server-side). This only decides whether to render a
 * button; the 403 is the real boundary.
 */
export function canDeleteNote(note: CallNote, actorEmail: string | null, actorIsAdmin: boolean): boolean {
  if (actorIsAdmin) return true;
  const author = note.author?.email;
  if (!author || !actorEmail) return false;
  return author.trim().toLowerCase() === actorEmail.trim().toLowerCase();
}

export function CallNotesPanel({
  notes, onAdd, onDelete, actorEmail, actorIsAdmin, maxListHeight = "16rem",
}: CallNotesPanelProps) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const trimmed = text.trim();

  const submit = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onAdd(trimmed);
      setText(""); // cleared only on success — a failed save must not eat the words
    } catch {
      /* the caller toasts; the text stays in the box */
    } finally {
      setSaving(false);
    }
  };

  const remove = async (noteId: string) => {
    setDeleting(noteId);
    try {
      await onDelete(noteId);
    } catch {
      /* the caller toasts */
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="call-notes-panel">
      {notes.length === 0 ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <StickyNote size={12} className="opacity-60" />
          No notes yet.
        </p>
      ) : (
        <ul className="space-y-2.5 overflow-y-auto pr-1" style={{ maxHeight: maxListHeight }}>
          {notes.map((note) => (
            <li key={note.id} className="group text-sm">
              <div className="flex items-start justify-between gap-2">
                {/* whitespace-pre-wrap: a note written with line breaks reads back
                    with them, and break-words keeps a pasted URL inside the column. */}
                <p className="whitespace-pre-wrap break-words text-foreground leading-snug">{note.text}</p>
                {canDeleteNote(note, actorEmail, actorIsAdmin) && (
                  <button
                    onClick={() => remove(note.id)}
                    disabled={deleting === note.id}
                    aria-label="Delete this note"
                    title="Delete this note"
                    className="flex-shrink-0 text-muted-foreground/60 hover:text-destructive transition-colors disabled:opacity-50"
                  >
                    {deleting === note.id
                      ? <Loader2 size={12} className="animate-spin" />
                      : <Trash2 size={12} />}
                  </button>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {note.author?.name || note.author?.email || "Someone"}
                {note.createdAt ? ` · ${formatTimeAgo(note.createdAt)}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note…"
          maxLength={NOTE_MAX_LENGTH}
          rows={2}
          className="text-sm resize-none"
          aria-label="Add a note"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {/* Only shown as it starts to matter — a character counter on an empty
                box is noise. */}
            {trimmed.length > NOTE_MAX_LENGTH - 200 ? `${trimmed.length} / ${NOTE_MAX_LENGTH}` : ""}
          </span>
          <Button size="sm" className="h-7 text-xs" disabled={!trimmed || saving} onClick={submit}>
            {saving ? <><Loader2 size={12} className="mr-1 animate-spin" /> Saving…</> : "Add note"}
          </Button>
        </div>
      </div>
    </div>
  );
}
