/**
 * Shared Open Dental UI pieces for the TC module (Slice 5).
 *
 * Three jobs, all of them about honesty:
 *
 *  1. `OdNotConnected` — the ONE place the "OD not connected for this office
 *     yet" state is rendered. Its copy matches the calls worklist verbatim
 *     (pages/calls/CallWorklist.tsx) so the phrase means the same thing
 *     everywhere in the product.
 *  2. `OdCoverageNotes` — renders the backend's per-element coverage report.
 *     When a number could not be fetched, the user sees WHY next to the number,
 *     not a confident-looking zero.
 *  3. `OdPatientSearch` — the debounced, read-only patient picker. Open Dental
 *     matches names by PREFIX, so this always shows DOB and phone and never
 *     auto-selects: choosing the wrong patient is a clinical error, not a typo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import { AlertTriangle, Info, Loader2, PlugZap, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  isOdNotConnected,
  odSearchPatients,
  tcErrorMessage,
  type OdCoverage,
  type OdPatient,
} from "../api";

// ── "OD not connected for this office yet" ──────────────────────────────────

/**
 * The honest empty state for an office with no Open Dental connection (today:
 * Valley). Not an error — the office is real and entitled; the practice-
 * management connection simply doesn't exist yet.
 */
export function OdNotConnected({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span className={cn("text-xs text-muted-foreground/70 italic", className)}>
        OD not connected for this office yet
      </span>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center",
        className,
      )}
      data-testid="od-not-connected"
    >
      <PlugZap size={20} className="text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">OD not connected for this office yet.</p>
      <p className="max-w-sm text-xs text-muted-foreground/80">
        Open Dental reads are available for Roland today. This office will light up when its
        practice-management connection is added.
      </p>
    </div>
  );
}

/** Generic failure box with a retry, for OD reads that genuinely broke. */
export function OdError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
      <p className="flex items-start gap-2 text-sm text-destructive">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
        {message}
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ── Coverage + notes ────────────────────────────────────────────────────────

const COVERAGE_BADGE: Record<OdCoverage["status"], string> = {
  confirmed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  partial: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  gap: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

const COVERAGE_LABEL: Record<OdCoverage["status"], string> = {
  confirmed: "From OD",
  partial: "Partial",
  gap: "Not available",
};

/**
 * What this read could and could not fetch. Only the rows that aren't a clean
 * `confirmed` are shown by default — a wall of green teaches the user to ignore
 * the panel, and then they ignore the amber row that matters.
 */
export function OdCoverageNotes({
  coverage,
  notes,
  showAll = false,
  className,
}: {
  coverage?: OdCoverage[];
  notes?: string[];
  showAll?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(showAll);
  const rows = useMemo(() => coverage ?? [], [coverage]);
  const imperfect = rows.filter((c) => c.status !== "confirmed");
  const visible = expanded ? rows : imperfect;

  if (visible.length === 0 && (!notes || notes.length === 0)) return null;

  return (
    <div className={cn("space-y-2 rounded-md border border-border bg-muted/30 p-3", className)}>
      {notes && notes.length > 0 && (
        <ul className="space-y-1">
          {notes.map((n) => (
            <li key={n} className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      {visible.length > 0 && (
        <ul className="space-y-1.5">
          {visible.map((c) => (
            <li key={c.element} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <Badge
                variant="outline"
                className={cn("border-transparent px-1.5 py-0 text-[10px]", COVERAGE_BADGE[c.status])}
              >
                {COVERAGE_LABEL[c.status]}
              </Badge>
              <span className="font-medium text-foreground">{c.element}</span>
              {c.note && <span className="w-full text-muted-foreground">{c.note}</span>}
            </li>
          ))}
        </ul>
      )}

      {rows.length > imperfect.length && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show only what needs attention" : `Show all ${rows.length} data sources`}
        </button>
      )}
    </div>
  );
}

// ── Patient search ──────────────────────────────────────────────────────────

export interface OdPatientSearchProps {
  office: OfficeId;
  onSelect: (patient: OdPatient) => void;
  /** Currently linked patient, rendered as a removable chip. */
  selected?: OdPatient | null;
  onClear?: () => void;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /**
   * Which search endpoint to use. Defaults to the tc.full `odSearchPatients`.
   * The hygiene intake passes `odAttachSearch` instead: same picker, a route a
   * hygienist may actually reach, resolved per office. The component is
   * identical either way — a brief result simply has blank phone/email, and the
   * rows below already omit those when empty.
   */
  search?: (office: OfficeId, query: string) => Promise<{
    patients: OdPatient[];
    truncated: boolean;
  }>;
}

/**
 * Debounced Open Dental patient search.
 *
 * Read-only: it links a real PatNum to a TC record and nothing else. Two rules
 * are load-bearing and must not be "simplified" away:
 *   - OD's name filters are PREFIX matches, so the header says "starts with" and
 *     every row shows DOB + phone.
 *   - nothing is ever auto-selected, not even a single result. The user picks.
 */
export function OdPatientSearch({
  office,
  onSelect,
  selected,
  onClear,
  label = "Search Open Dental",
  placeholder = "Last name, or first name",
  autoFocus = false,
  className,
  search = odSearchPatients,
}: OdPatientSearchProps) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<OdPatient[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const [searched, setSearched] = useState(false);
  /** Guards against a slow early response overwriting a newer one. */
  const requestSeq = useRef(0);

  const runSearch = useCallback(
    (q: string) => {
      const seq = ++requestSeq.current;
      if (q.trim().length < 2) {
        setResults([]);
        setSearched(false);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      search(office, q.trim())
        .then((res) => {
          if (seq !== requestSeq.current) return;
          setResults(res.patients);
          setTruncated(res.truncated);
          setSearched(true);
          setNotConnected(false);
        })
        .catch((e: unknown) => {
          if (seq !== requestSeq.current) return;
          setResults([]);
          if (isOdNotConnected(e)) {
            setNotConnected(true);
            setError(null);
          } else {
            setNotConnected(false);
            setError(tcErrorMessage(e));
          }
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    },
    [office, search],
  );

  useEffect(() => {
    const t = setTimeout(() => runSearch(term), 350);
    return () => clearTimeout(t);
  }, [term, runSearch]);

  if (notConnected) {
    return <OdNotConnected className={className} />;
  }

  if (selected) {
    return (
      <div className={cn("space-y-1", className)}>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{selected.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              PatNum {selected.patNum}
              {selected.birthdate ? ` · DOB ${selected.birthdate}` : ""}
              {selected.phone ? ` · ${selected.phone}` : ""}
            </p>
          </div>
          {onClear && (
            <Button variant="ghost" size="sm" onClick={onClear} aria-label="Unlink this patient">
              <X size={14} />
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={term}
          autoFocus={autoFocus}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={placeholder}
          className="pl-8"
          aria-label={label}
        />
        {loading && (
          <Loader2
            size={14}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
      </div>

      {error && <OdError message={error} onRetry={() => runSearch(term)} />}

      {term.trim().length >= 2 && !loading && !error && (
        <p className="text-[11px] text-muted-foreground">
          Open Dental matches names that <strong>start with</strong> what you type — check the date
          of birth before you pick.
        </p>
      )}

      {results.length > 0 && (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {results.map((p) => (
            <li key={p.patNum}>
              <button
                type="button"
                onClick={() => onSelect(p)}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-muted/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {p.displayName}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    PatNum {p.patNum}
                    {p.birthdate ? ` · DOB ${p.birthdate}` : " · DOB not on file"}
                    {p.phone ? ` · ${p.phone}` : ""}
                  </span>
                </span>
                {p.status && p.status !== "Patient" && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {p.status}
                  </Badge>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {truncated && results.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          More patients matched than are shown. Type more of the name to narrow it down.
        </p>
      )}

      {searched && !loading && !error && results.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No Open Dental patients start with “{term.trim()}”.
        </p>
      )}
    </div>
  );
}
