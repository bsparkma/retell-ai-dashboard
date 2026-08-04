/**
 * Notes tab — long-form case notes (explicit confirmed-save via patchCase),
 * one-click contact-attempt logging (channel × outcome grid → typed
 * contact_attempt event), and a quick note that appends a note_added event.
 */
import { useState } from "react";
import type { ContactAttemptDetail, OfficeId, TcCase } from "@shared/tc/contract";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Mail, MessageSquare, Phone, StickyNote } from "lucide-react";
import { addCaseEvent, patchCase, tcErrorMessage } from "../api";

type AttemptChannel = ContactAttemptDetail["channel"];
type AttemptOutcome = ContactAttemptDetail["outcome"];

const CHANNELS: { id: AttemptChannel; label: string; icon: typeof Phone }[] = [
  { id: "call", label: "Call", icon: Phone },
  { id: "text", label: "Text", icon: MessageSquare },
  { id: "email", label: "Email", icon: Mail },
];

const OUTCOMES: { id: AttemptOutcome; label: string }[] = [
  { id: "reached", label: "Reached" },
  { id: "voicemail", label: "Voicemail" },
  { id: "no_answer", label: "No answer" },
];

const OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  reached: "reached",
  voicemail: "left voicemail",
  no_answer: "no answer",
};

export interface NotesTabProps {
  office: OfficeId;
  tcCase: TcCase;
  onCaseUpdate: (updated: TcCase) => void;
}

export function NotesTab({ office, tcCase, onCaseUpdate }: NotesTabProps) {
  const [notes, setNotes] = useState(tcCase.notes);
  const [savingNotes, setSavingNotes] = useState(false);
  const [quickNote, setQuickNote] = useState("");
  const [addingQuickNote, setAddingQuickNote] = useState(false);
  const [loggingAttempt, setLoggingAttempt] = useState(false);

  const notesDirty = notes !== tcCase.notes;

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      const updated = await patchCase(office, tcCase.caseId, { notes });
      toast.success("Notes saved");
      onCaseUpdate(updated);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSavingNotes(false);
    }
  };

  const logAttempt = async (channel: AttemptChannel, outcome: AttemptOutcome) => {
    setLoggingAttempt(true);
    try {
      const event = await addCaseEvent(office, tcCase.caseId, {
        type: "contact_attempt",
        description: `Contact attempt — ${channel}, ${OUTCOME_LABEL[outcome]}`,
        detail: { channel, outcome },
      });
      toast.success("Contact attempt logged");
      onCaseUpdate({ ...tcCase, events: [...tcCase.events, event] });
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setLoggingAttempt(false);
    }
  };

  const addQuickNote = async () => {
    const text = quickNote.trim();
    if (text === "") return;
    setAddingQuickNote(true);
    try {
      const event = await addCaseEvent(office, tcCase.caseId, {
        type: "note_added",
        description: text,
      });
      toast.success("Note added");
      onCaseUpdate({ ...tcCase, events: [...tcCase.events, event] });
      setQuickNote("");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setAddingQuickNote(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Case notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            aria-label="Case notes"
            value={notes}
            rows={8}
            placeholder="Discovery, financial conversation, family context…"
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="flex justify-end">
            <Button onClick={() => void saveNotes()} disabled={savingNotes || !notesDirty}>
              {savingNotes && <Loader2 className="animate-spin" />}
              Save notes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Log contact attempt</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {CHANNELS.map((ch) => (
            <div key={ch.id} className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground w-20">
                <ch.icon size={14} />
                {ch.label}
              </span>
              {OUTCOMES.map((o) => (
                <Button
                  key={o.id}
                  variant="outline"
                  size="sm"
                  disabled={loggingAttempt}
                  onClick={() => void logAttempt(ch.id, o.id)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold inline-flex items-center gap-2">
            <StickyNote size={14} className="text-muted-foreground" />
            Quick note
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Label htmlFor="tc-quick-note" className="sr-only">
              Quick note
            </Label>
            <Input
              id="tc-quick-note"
              value={quickNote}
              placeholder="Add a note to the activity timeline…"
              onChange={(e) => setQuickNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addQuickNote();
              }}
            />
            <Button
              variant="outline"
              onClick={() => void addQuickNote()}
              disabled={addingQuickNote || quickNote.trim() === ""}
            >
              {addingQuickNote && <Loader2 className="animate-spin" />}
              Add note
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
