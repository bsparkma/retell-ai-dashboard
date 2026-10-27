/**
 * "Log correspondence" (R6.9) — staff record a call, an email or a fax with
 * the specialist's office or the patient that happened OUTSIDE the app. It is
 * a history line, never a move: the referral stays where it is, and nothing is
 * sent, faxed or dialled.
 *
 * The hub's detail panel draws it for a tc.full viewer, on any status but a
 * draft (hubCanLogCorrespondence). The server re-checks all of it.
 *
 * An optional file goes through R4's upload route UNCHANGED, after the contact
 * is logged (so a refused file never loses the note): R4's own checks, its
 * status rule (only while a referral is a draft or awaiting sign-off) and its
 * cap of 5. Where R4 would refuse, the form says so instead of offering the
 * file; where it refuses anyway (two people at the fifth slot), its own words
 * are shown, file by file, and the contact stays logged.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquarePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { logReferralCorrespondence, uploadReferralAttachment } from "@/features/tc/referrals/referralsApi";
import { AttachmentZone } from "@/features/tc/referrals/AttachmentZone";
import { uploadAll } from "@/features/tc/referrals/ReferralsPanel";
import type { OfficeId } from "@shared/tc/contract";
import {
  TC_REFERRAL_ATTACHMENT_MAX_FILES,
  TC_REFERRAL_CORRESPONDENCE_CHANNELS,
  TC_REFERRAL_CORRESPONDENCE_NOTE_MAX,
  type TcReferral,
  type TcReferralCorrespondenceChannel,
  type TcReferralCorrespondenceDirection,
  type TcReferralCorrespondenceParty,
  type TcReferralStatus,
} from "@shared/tc/referrals";

/**
 * Where R4 takes a file: its server rule (referralAttachments.js
 * ATTACHABLE_STATUSES), mirrored for the form only. The server decides.
 */
export const R4_ATTACHABLE_STATUSES: readonly TcReferralStatus[] = ["draft", "pending_signoff"];

/** R4's own refusal sentences, shown where its rule would refuse. */
export const CORRESPONDENCE_FILE_LOCKED_COPY =
  "Files can be added only while a referral is a draft or awaiting sign-off, so this note goes in without one.";
export const CORRESPONDENCE_FILE_FULL_COPY = `A referral can carry at most ${TC_REFERRAL_ATTACHMENT_MAX_FILES} files, so this note goes in without one.`;

const CHANNEL_LABELS: Record<TcReferralCorrespondenceChannel, string> = {
  phone: "Phone",
  email: "Email",
  fax: "Fax",
  other: "Other",
};

/** "From the specialist's office" etc.: who and which way, as one choice. */
const WHO_OPTIONS = [
  { key: "from:specialist", label: "From the specialist's office" },
  { key: "to:specialist", label: "To the specialist's office" },
  { key: "from:patient", label: "From the patient" },
  { key: "to:patient", label: "To the patient" },
] as const;
type WhoKey = (typeof WHO_OPTIONS)[number]["key"];

function splitWho(key: WhoKey): { direction: TcReferralCorrespondenceDirection; party: TcReferralCorrespondenceParty } {
  const [direction, party] = key.split(":") as [TcReferralCorrespondenceDirection, TcReferralCorrespondenceParty];
  return { direction, party };
}

export function LogCorrespondence({
  office,
  referral: r,
  filesAttached,
  onLogged,
  onFilesChanged,
}: {
  /** The office the referral was read from — the call goes there. */
  office: OfficeId;
  referral: TcReferral;
  filesAttached: number;
  /** The server's read-back after the contact was logged. */
  onLogged: (next: TcReferral) => void;
  /** After any file attempt, so the caller re-reads the stored list. */
  onFilesChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<WhoKey>("from:specialist");
  const [channel, setChannel] = useState<TcReferralCorrespondenceChannel>("phone");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What happened to the file(s) after the contact was logged, in R4's words. */
  const [fileOutcome, setFileOutcome] = useState<string[]>([]);

  const attachable = R4_ATTACHABLE_STATUSES.includes(r.status);
  const full = filesAttached >= TC_REFERRAL_ATTACHMENT_MAX_FILES;
  const fileNote = !attachable ? CORRESPONDENCE_FILE_LOCKED_COPY : full ? CORRESPONDENCE_FILE_FULL_COPY : null;

  function reset() {
    setWho("from:specialist");
    setChannel("phone");
    setNote("");
    setFiles([]);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setFileOutcome([]);
    let next: TcReferral;
    try {
      next = await logReferralCorrespondence(office, r.referralId, { ...splitWho(who), channel, note: note.trim() });
    } catch (e) {
      // Nothing was logged; the form stays as typed.
      setError(tcErrorMessage(e));
      setBusy(false);
      return;
    }
    onLogged(next);
    const chosen = files;
    reset();
    setOpen(false);
    if (chosen.length === 0) {
      toast.success("Correspondence logged");
      setBusy(false);
      return;
    }
    try {
      const { stored, failed } = await uploadAll(chosen, (f) => uploadReferralAttachment(office, r.referralId, f));
      if (failed.length > 0) {
        const lines = failed.map((f) => `${f.name} was not attached: ${f.message}`);
        setFileOutcome(lines);
        toast.error(`Correspondence logged — but ${lines.join(" ")}`);
      } else {
        toast.success(stored.length === 1 ? "Correspondence logged, with its file" : `Correspondence logged, with ${stored.length} files`);
      }
    } finally {
      setBusy(false);
      onFilesChanged();
    }
  }

  if (!open) {
    return (
      <div className="space-y-1" data-testid="tc-hub-correspondence">
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={() => {
            setFileOutcome([]);
            setOpen(true);
          }}
          disabled={busy}
          data-testid="tc-hub-correspondence-open"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquarePlus className="w-3.5 h-3.5" />} Log correspondence
        </Button>
        {fileOutcome.map((line) => (
          <p key={line} className="text-xs text-destructive" role="alert" data-testid="tc-hub-correspondence-file-refused">
            Logged. {line}
          </p>
        ))}
      </div>
    );
  }

  const remaining = TC_REFERRAL_CORRESPONDENCE_NOTE_MAX - note.length;
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="tc-hub-correspondence-form">
      <p className="text-xs text-muted-foreground">
        A record of a contact that happened outside the app. It goes in the history; it does not change where the referral stands
        and contacts no one.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="corr-who" className="text-xs">
            Who
          </Label>
          <select
            id="corr-who"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={who}
            onChange={(e) => setWho(e.target.value as WhoKey)}
            disabled={busy}
          >
            {WHO_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="corr-channel" className="text-xs">
            How
          </Label>
          <select
            id="corr-channel"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={channel}
            onChange={(e) => setChannel(e.target.value as TcReferralCorrespondenceChannel)}
            disabled={busy}
          >
            {TC_REFERRAL_CORRESPONDENCE_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="corr-note" className="text-xs">
          What was said *
        </Label>
        <Textarea
          id="corr-note"
          rows={3}
          maxLength={TC_REFERRAL_CORRESPONDENCE_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Their front desk called: the patient is booked for Nov 3."
          disabled={busy}
        />
        <p className="text-[11px] text-muted-foreground">{remaining} characters left</p>
      </div>
      {fileNote ? (
        <p className="text-xs text-muted-foreground" data-testid="tc-hub-correspondence-no-file">
          {fileNote}
        </p>
      ) : (
        <AttachmentZone files={files} onChange={setFiles} alreadyAttached={filesAttached} disabled={busy} />
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy || !note.trim()} data-testid="tc-hub-correspondence-save">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Log it
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
