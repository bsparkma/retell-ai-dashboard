/**
 * Add files to a referral that already exists (R6.2) — for the edit surfaces:
 * the hub's staff edit and the doctor's sign-off edit.
 *
 * The R4 pieces, unchanged: AttachmentZone collects (and pre-checks) the
 * files, uploadAll sends them one by one through the caller's upload route,
 * and reportFailedUploads names each one that did not land. The SERVER decides
 * everything that matters (type by bytes, 10 MB, at most 5, the status). After
 * an attempt the caller re-reads the list, so what shows is what is stored.
 *
 * There is no remove: a stored file stays with the referral.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Paperclip } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TcReferralAttachment } from "@shared/tc/referrals";
import { AttachmentZone } from "./AttachmentZone";
import { reportFailedUploads, uploadAll } from "./ReferralsPanel";

export interface AddAttachmentsProps {
  /** Files the referral already carries (they count toward the 5). */
  alreadyAttached: number;
  upload: (file: File) => Promise<TcReferralAttachment>;
  /** After any attempt, so the caller can re-read the stored list. */
  onDone: () => void;
  disabled?: boolean;
}

export function AddAttachments({ alreadyAttached, upload, onDone, disabled = false }: AddAttachmentsProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  async function attach() {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const { stored, failed } = await uploadAll(files, upload);
      reportFailedUploads(failed);
      if (stored.length > 0) toast.success(stored.length === 1 ? "File attached" : `${stored.length} files attached`);
      // Each failure was named above. Matching them back by name is unsafe
      // (every pasted snip is "image.png"), so the queue empties either way.
      setFiles([]);
    } finally {
      setUploading(false);
      onDone();
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="referral-add-attachments">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add files</p>
      <AttachmentZone
        files={files}
        onChange={setFiles}
        alreadyAttached={alreadyAttached}
        disabled={disabled || uploading}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1"
        disabled={disabled || uploading || files.length === 0}
        onClick={() => void attach()}
      >
        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
        {files.length > 1 ? `Attach ${files.length} files` : "Attach file"}
      </Button>
    </div>
  );
}
