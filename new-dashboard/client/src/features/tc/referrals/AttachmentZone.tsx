/**
 * The referral form's upload zone (queue item 55, R4).
 *
 * Drag files onto it, pick them, or PASTE — Win+Shift+S puts the snip on the
 * clipboard, so Ctrl+V into the zone works as well as dragging. Images and PDFs
 * only, 10 MB each, at most 5 per referral (counting what is already
 * attached). The checks here are a courtesy so a wrong file is caught before
 * the round trip; the SERVER decides, by the file's bytes.
 *
 * The helper line is exactly the PM's: "Press Win+Shift+S to snip the X-ray,
 * then drag it here."
 *
 * The zone only COLLECTS files. The surface that owns the form uploads them
 * after the referral is saved, one by one, and reports each result honestly.
 */
import { useRef, useState } from "react";
import { FileText, ImageIcon, Paperclip, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  REFERRAL_ATTACHMENT_HINT,
  TC_REFERRAL_ATTACHMENT_MAX_FILES,
  TC_REFERRAL_ATTACHMENT_TYPES,
  attachmentProblem,
} from "@shared/tc/referrals";

export interface AttachmentZoneProps {
  files: File[];
  onChange: (files: File[]) => void;
  /** Files the referral already carries (they count toward the 5). */
  alreadyAttached?: number;
  disabled?: boolean;
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function AttachmentZone({ files, onChange, alreadyAttached = 0, disabled = false }: AttachmentZoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  function add(incoming: File[]) {
    const next = [...files];
    const refused: string[] = [];
    for (const f of incoming) {
      const why = attachmentProblem(f, alreadyAttached + next.length);
      if (why) refused.push(why);
      else next.push(f);
    }
    setProblems(refused);
    if (next.length !== files.length) onChange(next);
  }

  const room = TC_REFERRAL_ATTACHMENT_MAX_FILES - alreadyAttached - files.length;

  return (
    <div className="space-y-2" data-testid="referral-attachment-zone">
      <div
        role="button"
        tabIndex={0}
        aria-label="Attach files: drop, paste or choose"
        aria-disabled={disabled || room <= 0}
        onClick={() => !disabled && room > 0 && input.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled && room > 0) {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) add(Array.from(e.dataTransfer.files));
        }}
        onPaste={(e) => {
          if (disabled) return;
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            add(pasted);
          }
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center text-sm transition-colors",
          over ? "border-primary bg-primary/5" : "border-border",
          disabled || room <= 0 ? "opacity-60" : "cursor-pointer hover:bg-muted/40",
        )}
      >
        <Paperclip className="w-5 h-5 text-muted-foreground" aria-hidden />
        <span className="font-medium text-foreground">Drop X-rays, photos or PDFs here, or click to choose</span>
        <span className="text-xs text-muted-foreground" data-testid="referral-attachment-hint">
          {REFERRAL_ATTACHMENT_HINT}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Images or PDF · up to 10 MB each · {Math.max(0, room)} of {TC_REFERRAL_ATTACHMENT_MAX_FILES} left
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={TC_REFERRAL_ATTACHMENT_TYPES.join(",")}
          data-testid="referral-attachment-input"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      {problems.map((p) => (
        <p key={p} className="text-xs text-destructive" role="alert">
          {p}
        </p>
      ))}
      {files.length > 0 && (
        <ul className="space-y-1" data-testid="referral-attachment-pending">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-xs">
              <span className="flex items-center gap-1.5 truncate">
                {f.type === "application/pdf" ? <FileText className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />}
                <span className="truncate">{f.name}</span>
                <span className="text-muted-foreground">{sizeLabel(f.size)}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
