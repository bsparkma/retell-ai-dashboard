/**
 * /tc/communications — email communications log (read-only until platform
 * email ships; imported legacy rows land here as 'sent'/'stubbed'/'error').
 *
 * templateName is rendered as the DENORMALIZED string on the row — imported
 * rows can carry null templateId/caseId, so we never look templates up by id.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ExternalLink, Loader2, Mail, RefreshCw, Search } from "lucide-react";
import type { TcCommunication } from "@shared/tc/contract";
import { getCommunication, listCommunications, tcErrorMessage } from "@/features/tc/api";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type StatusFilter = "all" | "sent" | "stubbed" | "error";

const STATUS_BADGE: Record<TcCommunication["status"], string> = {
  sent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  stubbed: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

const STATUS_LABEL: Record<TcCommunication["status"], string> = {
  sent: "Sent",
  stubbed: "Stubbed",
  error: "Error",
};

function StatusChip({ comm }: { comm: TcCommunication }) {
  const chip = (
    <Badge variant="outline" className={`border-transparent ${STATUS_BADGE[comm.status]}`}>
      {STATUS_LABEL[comm.status]}
    </Badge>
  );
  if (comm.status === "error" && comm.error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{chip}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-words">{comm.error}</TooltipContent>
      </Tooltip>
    );
  }
  return chip;
}

function formatSentAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function TcCommunications() {
  const office = useTcOffice();

  const [comms, setComms] = useState<TcCommunication[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [caseIdFilter, setCaseIdFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [detail, setDetail] = useState<TcCommunication | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(() => {
    if (!office) return;
    setLoading(true);
    setLoadError(null);
    listCommunications(office)
      .then(setComms)
      .catch((e: unknown) => setLoadError(tcErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [office]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = caseIdFilter.trim().toLowerCase();
    return comms
      .filter((c) => (statusFilter === "all" ? true : c.status === statusFilter))
      .filter((c) => (q ? (c.caseId ?? "").toLowerCase().includes(q) : true))
      .slice()
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0)); // newest first
  }, [comms, caseIdFilter, statusFilter]);

  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  const openDetail = async (comm: TcCommunication) => {
    setDetail(comm); // show the row data immediately…
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const full = await getCommunication(office, comm.commId); // …then the server row
      setDetail(full);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="p-6">
      <TcPageHeader
        title="Communications"
        subtitle="Every email logged for this office — sends arrive with platform email"
        actions={
          <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative max-w-xs w-full">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={caseIdFilter}
            onChange={(e) => setCaseIdFilter(e.target.value)}
            placeholder="Filter by case ID…"
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="stubbed">Stubbed</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading communications…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      ) : comms.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <Mail className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No emails logged yet — sends arrive with platform email.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <p className="text-sm text-muted-foreground">No communications match the current filters.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sent</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Sender</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Case</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow
                  key={c.commId}
                  className="cursor-pointer"
                  onClick={() => void openDetail(c)}
                >
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatSentAt(c.sentAt)}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate">{c.toEmail}</TableCell>
                  <TableCell className="max-w-[260px] truncate font-medium">{c.subject}</TableCell>
                  <TableCell className="max-w-[180px] truncate text-muted-foreground">
                    {/* Denormalized name — never looked up by templateId. */}
                    {c.templateName || "—"}
                  </TableCell>
                  <TableCell className="max-w-[140px] truncate text-muted-foreground">
                    {c.senderName || c.sender}
                  </TableCell>
                  <TableCell>
                    <StatusChip comm={c} />
                  </TableCell>
                  <TableCell>
                    {c.caseId ? (
                      <Link
                        href={`/tc/cases/${c.caseId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        View case <ExternalLink className="w-3 h-3" />
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Email details
              {detailLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </DialogTitle>
            <DialogDescription>{detail ? formatSentAt(detail.sentAt) : ""}</DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-[110px_1fr] gap-y-2 gap-x-3">
                <span className="text-muted-foreground">Status</span>
                <span>
                  <StatusChip comm={detail} />
                </span>
                <span className="text-muted-foreground">To</span>
                <span className="break-all">{detail.toEmail}</span>
                <span className="text-muted-foreground">Subject</span>
                <span className="font-medium">{detail.subject || "—"}</span>
                <span className="text-muted-foreground">Template</span>
                <span>{detail.templateName || "—"}</span>
                <span className="text-muted-foreground">Sender</span>
                <span>{detail.senderName || detail.sender}</span>
                {detail.providerMessageId && (
                  <>
                    <span className="text-muted-foreground">Message ID</span>
                    <span className="font-mono text-xs break-all">{detail.providerMessageId}</span>
                  </>
                )}
                <span className="text-muted-foreground">Case</span>
                <span>
                  {detail.caseId ? (
                    <Link
                      href={`/tc/cases/${detail.caseId}`}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      View case <ExternalLink className="w-3 h-3" />
                    </Link>
                  ) : (
                    "—"
                  )}
                </span>
              </div>
              {detail.status === "error" && detail.error && (
                <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-xs text-red-700 dark:text-red-300 break-words">
                  {detail.error}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
