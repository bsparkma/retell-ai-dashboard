/**
 * One practice's audit trail — read-only, paginated on the SERVER.
 *
 * The table is append-only and stays that way: the application connects as a
 * least-privilege role holding INSERT and SELECT and nothing else, so there is
 * no edit control to build here even if somebody wanted one.
 *
 * PAGING IS SERVER-SIDE because the trail grows without bound. `total` is the
 * count matching the CURRENT filters, not the table size, so "1–50 of 1,240"
 * changes when you filter — which is the honest reading of that number.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { AuditAction, AuditFilters, AuditPage, AuditResult, Practice } from "@/lib/api";
import { loadError } from "../Platform";

const PAGE_SIZE = 50;

/** The vocabularies the table's CHECK constraints admit. Not free text. */
const ACTIONS: AuditAction[] = ["READ", "CREATE", "UPDATE", "DELETE"];
const RESULTS: AuditResult[] = ["SUCCESS", "UNAUTHORIZED", "ERROR"];

/** Filters as the form holds them: all strings, "" meaning "no filter". */
interface FormState {
  action: string;
  result: string;
  resourceType: string;
  resourceId: string;
  from: string;
  to: string;
}

const EMPTY_FORM: FormState = {
  action: "",
  result: "",
  resourceType: "",
  resourceId: "",
  from: "",
  to: "",
};

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** SUCCESS is the quiet case; the other two are the ones worth spotting. */
function resultTone(result: AuditResult): string {
  if (result === "UNAUTHORIZED") return "text-amber-600 dark:text-amber-400";
  if (result === "ERROR") return "text-destructive";
  return "text-muted-foreground";
}

export default function PracticeAuditPanel({ practice }: { practice: Practice }) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  /** The filters actually in force. Separate from `form` so typing a resource
   *  id does not fire a request per keystroke — Apply commits. */
  const [applied, setApplied] = useState<FormState>(EMPTY_FORM);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (signal: { live: boolean }) => {
      setLoading(true);
      const filters: AuditFilters = {
        limit: PAGE_SIZE,
        offset,
        // The server validates these against its own vocabulary and 400s on a
        // bad one; the casts here narrow what the <select> can produce, they do
        // not stand in for that check.
        action: (applied.action || undefined) as AuditAction | undefined,
        result: (applied.result || undefined) as AuditResult | undefined,
        resourceType: applied.resourceType || undefined,
        resourceId: applied.resourceId || undefined,
        from: applied.from || undefined,
        to: applied.to || undefined,
      };
      try {
        const res = await api.listPracticeAudit(practice.tenantId, filters);
        if (!signal.live) return;
        setPage(res);
        setError(null);
      } catch (e) {
        if (!signal.live) return;
        setPage(null);
        setError(loadError(e));
      } finally {
        if (signal.live) setLoading(false);
      }
    },
    [practice.tenantId, applied, offset],
  );

  useEffect(() => {
    const signal = { live: true };
    void load(signal);
    return () => {
      signal.live = false;
    };
  }, [load]);

  /** Applying a filter returns to the first page — page 4 of the old result set
   *  is meaningless against the new one, and would often be empty. */
  const apply = () => {
    setOffset(0);
    setApplied(form);
  };
  const reset = () => {
    setOffset(0);
    setForm(EMPTY_FORM);
    setApplied(EMPTY_FORM);
  };

  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-3" data-testid="practice-audit">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 p-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Action
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
            data-testid="audit-filter-action"
          >
            <option value="">Any</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Result
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            value={form.result}
            onChange={(e) => setForm({ ...form, result: e.target.value })}
            data-testid="audit-filter-result"
          >
            <option value="">Any</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Resource type
          <Input
            className="h-8 w-40"
            placeholder="app_user"
            value={form.resourceType}
            onChange={(e) => setForm({ ...form, resourceType: e.target.value })}
            data-testid="audit-filter-resource-type"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Resource id
          <Input
            className="h-8 w-48"
            placeholder="exact match"
            value={form.resourceId}
            onChange={(e) => setForm({ ...form, resourceId: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && apply()}
            data-testid="audit-filter-resource-id"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <Input
            type="date"
            className="h-8 w-36"
            value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
            data-testid="audit-filter-from"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <Input
            type="date"
            className="h-8 w-36"
            value={form.to}
            onChange={(e) => setForm({ ...form, to: e.target.value })}
            data-testid="audit-filter-to"
          />
        </label>

        <Button size="sm" onClick={apply} data-testid="audit-apply">
          <Search className="mr-1.5 h-3.5 w-3.5" />
          Apply
        </Button>
        <Button size="sm" variant="ghost" onClick={reset} data-testid="audit-reset">
          Reset
        </Button>
      </div>

      {error && <p className="text-sm text-destructive" data-testid="audit-error">{error}</p>}

      {page && page.entries.length === 0 && !error && (
        <p className="py-6 text-center text-sm text-muted-foreground" data-testid="audit-empty">
          Nothing matches those filters.
        </p>
      )}

      {page && page.entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Office</th>
              </tr>
            </thead>
            <tbody>
              {page.entries.map((e) => (
                <tr key={e.auditId} className="border-b border-border/50 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatTs(e.ts)}</td>
                  <td className="px-3 py-2 text-foreground">{e.actor ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="font-mono text-[11px]">{e.action}</Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <span className="font-mono text-xs">{e.resourceType}</span>
                    {e.resourceId && <span className="ml-1 text-xs">· {e.resourceId}</span>}
                  </td>
                  <td className={`px-3 py-2 text-xs ${resultTone(e.result)}`}>{e.result}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{e.office ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span data-testid="audit-range">
          {loading ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </span>
          ) : (
            `${first}–${last} of ${total}`
          )}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            data-testid="audit-prev"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={last >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            data-testid="audit-next"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
