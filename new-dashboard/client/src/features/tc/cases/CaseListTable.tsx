/**
 * Pipeline list view — a plain sortable table of case summaries. Row click
 * opens the case page. Client-side sort toggles on Value and Created only
 * (the rest keep server order).
 */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TcCaseSummary } from "../api";
import { formatCents } from "../money";
import { CaseStatusBadge, UrgencyBadge } from "../components/TcShell";
import { CASE_CATEGORY_LABELS } from "./NewCaseDialog";

type SortKey = "value" | "created";
type SortDir = "asc" | "desc";

function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function CaseListTable({
  cases,
  onOpen,
}: {
  cases: TcCaseSummary[];
  onOpen: (caseId: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );
  };

  const sorted = useMemo(() => {
    if (!sort) return cases;
    const arr = [...cases].sort((a, b) =>
      sort.key === "value"
        ? a.caseValueCents - b.caseValueCents
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return sort.dir === "desc" ? arr.reverse() : arr;
  }, [cases, sort]);

  const sortIcon = (key: SortKey) => {
    if (sort?.key !== key) return <ArrowUpDown className="w-3.5 h-3.5" />;
    return sort.dir === "desc"
      ? <ArrowDown className="w-3.5 h-3.5" />
      : <ArrowUp className="w-3.5 h-3.5" />;
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Patient</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Urgency</TableHead>
            <TableHead>
              <button
                type="button"
                onClick={() => toggleSort("value")}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                Value {sortIcon("value")}
              </button>
            </TableHead>
            <TableHead>Assigned TC</TableHead>
            <TableHead>
              <button
                type="button"
                onClick={() => toggleSort("created")}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                Created {sortIcon("created")}
              </button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <TableRow
              key={row.caseId}
              onClick={() => onOpen(row.caseId)}
              className="cursor-pointer"
            >
              <TableCell className="font-medium text-foreground">{row.patientName}</TableCell>
              <TableCell><CaseStatusBadge status={row.status} /></TableCell>
              <TableCell className="text-muted-foreground">
                {CASE_CATEGORY_LABELS[row.category]}
              </TableCell>
              <TableCell><UrgencyBadge urgency={row.urgency} /></TableCell>
              <TableCell className="font-semibold text-foreground">
                {formatCents(row.caseValueCents)}
              </TableCell>
              <TableCell className="text-muted-foreground">{row.assignedTc || "—"}</TableCell>
              <TableCell className="text-muted-foreground">{formatCreated(row.createdAt)}</TableCell>
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                No cases match the current filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
