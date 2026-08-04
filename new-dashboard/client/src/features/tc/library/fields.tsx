/**
 * Shared building blocks for the /tc/library section editors: the
 * confirmed-save hook (toast only after the PUT resolves; local state updated
 * from the RETURNED value), inline validation-issue rendering, empty states,
 * and small input parsers. All money entered here goes through
 * dollarsInputToCents — sections store integer cents.
 */
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, Save, Wand2 } from "lucide-react";
import type { LibrarySection, OfficeId } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import {
  putLibrarySection,
  TcApiError,
  tcErrorMessage,
  type TcValidationIssue,
} from "../api";
import type { SectionValue } from "./defaults";

// ── Confirmed-save hook ─────────────────────────────────────────────────────

export interface SectionSave<K extends LibrarySection> {
  saving: boolean;
  /** Server-side VALIDATION_FAILED issues from the last save attempt. */
  issues: TcValidationIssue[];
  clearIssues: () => void;
  /**
   * PUTs the whole section. Resolves with the persisted value (callers reset
   * their draft/baseline from it) or null on failure — the form stays dirty.
   */
  save: (value: SectionValue<K>) => Promise<SectionValue<K> | null>;
}

export function useSectionSave<K extends LibrarySection>(
  office: OfficeId,
  section: K,
  label: string,
  onSaved: (value: SectionValue<K>) => void,
): SectionSave<K> {
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<TcValidationIssue[]>([]);

  const save = async (value: SectionValue<K>): Promise<SectionValue<K> | null> => {
    setSaving(true);
    setIssues([]);
    try {
      const persisted = await putLibrarySection(office, section, value);
      onSaved(persisted);
      toast.success(`${label} saved`);
      return persisted;
    } catch (e) {
      if (e instanceof TcApiError && e.code === "VALIDATION_FAILED") {
        setIssues(e.issues);
      }
      toast.error(tcErrorMessage(e));
      return null;
    } finally {
      setSaving(false);
    }
  };

  return { saving, issues, clearIssues: () => setIssues([]), save };
}

// ── Chrome ──────────────────────────────────────────────────────────────────

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 shadow-sm space-y-4">
      <div>
        <h2
          className="text-sm font-semibold text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          {title}
        </h2>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Honest unconfigured state: nothing is invented or written silently — the
 * button only loads suggested defaults into the editor draft; the user must
 * still click Save to persist anything.
 */
export function SectionEmptyState({
  what,
  onSeed,
}: {
  what: string;
  onSeed: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center space-y-3">
      <p className="text-sm text-muted-foreground">
        This office hasn&apos;t configured {what} yet.
      </p>
      <Button variant="outline" size="sm" onClick={onSeed}>
        <Wand2 className="w-4 h-4 mr-1" /> Set up defaults
      </Button>
      <p className="text-xs text-muted-foreground">
        Loads suggested defaults into the editor below — nothing is saved until
        you click Save.
      </p>
    </div>
  );
}

export function IssueList({ issues }: { issues: TcValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-1">
      {issues.map((i, idx) => (
        <p key={idx} className="text-xs text-destructive">
          {i.path ? `${i.path}: ` : ""}
          {i.message}
        </p>
      ))}
    </div>
  );
}

export function FieldError({ msg }: { msg: string | null | undefined }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
        {saving ? (
          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
        ) : (
          <Save className="w-4 h-4 mr-1" />
        )}
        Save
      </Button>
      {onDiscard && dirty && !saving && (
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          Discard changes
        </Button>
      )}
      {dirty && (
        <span className="text-xs text-muted-foreground">Unsaved changes</span>
      )}
    </div>
  );
}

// ── Parsers ─────────────────────────────────────────────────────────────────

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** "3, 6, 12" → [3, 6, 12]; null when any entry is invalid or out of range. */
export function parseIntList(
  text: string,
  opts: { min: number; max: number; maxLen: number; minLen?: number },
): number[] | null {
  const trimmed = text.trim();
  const parts =
    trimmed === ""
      ? []
      : trimmed
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "");
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = parseInt(p, 10);
    if (n < opts.min || n > opts.max) return null;
    out.push(n);
  }
  if (out.length > opts.maxLen) return null;
  if (opts.minLen !== undefined && out.length < opts.minLen) return null;
  return out;
}

/** Whole-number input in [min, max]; null when invalid. */
export function intFromInput(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n >= min && n <= max ? n : null;
}

/** Decimal input (percent/APR) in [min, max]; null when invalid. */
export function numFromInput(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (t === "" || !/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
