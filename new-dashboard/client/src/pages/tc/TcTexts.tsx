/**
 * /tc/texts — received texts nobody has opened yet (queue item 39).
 *
 * Two lists, because they need different next steps:
 *
 *   New replies on cases   the text matched ONE open case in this office by
 *                          phone number. Opening the case's Messages tab marks
 *                          it seen.
 *   Not matched to a case  no open case had that number, or more than one did
 *                          (ambiguity is a refusal, never a guess). A person has
 *                          to work out who it is. Linking one to a case is not in
 *                          this slice; "Mark as seen" clears the count.
 *
 * The TC nav's count is the total of both, from the server. Nothing on this
 * page sends anything.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ArrowRight, CheckCheck, Inbox, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import type { TcMessage } from "@shared/tc/messaging";
import { Button } from "@/components/ui/button";
import { tcErrorMessage } from "@/features/tc/api";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import { listInbox, listUnseenOnCases, markSeen } from "@/features/tc/messaging/messagingApi";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function TextRow({ m, action }: { m: TcMessage; action?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card p-3" data-testid="text-row">
      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{m.fromAddress ?? "Unknown number"}</span>
          <span>· {formatWhen(m.createdAt)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{m.body}</p>
      </div>
      {action}
    </li>
  );
}

export default function TcTexts() {
  const office = useTcOffice();
  const [onCases, setOnCases] = useState<TcMessage[]>([]);
  const [unlinked, setUnlinked] = useState<TcMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async () => {
    if (!office) return;
    setLoading(true);
    setError(null);
    try {
      const [a, b] = await Promise.all([listUnseenOnCases(office), listInbox(office)]);
      setOnCases(a);
      setUnlinked(b);
    } catch (e) {
      setError(tcErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [office]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!office) return <TcOfficeGate />;

  const markInboxSeen = async () => {
    setMarking(true);
    try {
      const n = await markSeen(office, null);
      toast.success(n === 1 ? "1 text marked as seen." : `${n} texts marked as seen.`);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <TcPageHeader
        title="Texts"
        subtitle="Texts patients sent to this office. Nothing here sends anything."
        actions={
          <Button size="sm" variant="outline" className="gap-1" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading texts…
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2 py-6">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <section aria-label="New replies on cases">
            <h2 className="mb-2 text-sm font-semibold text-foreground">New replies on cases</h2>
            {onCases.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="texts-on-cases-empty">
                No unread replies on cases.
              </p>
            ) : (
              <ul className="space-y-2">
                {onCases.map((m) => (
                  <TextRow
                    key={m.messageId}
                    m={m}
                    action={
                      m.caseId ? (
                        <Link href={`/tc/cases/${m.caseId}?tab=messages`}>
                          <Button size="sm" variant="outline" className="gap-1">
                            Open case <ArrowRight className="h-3.5 w-3.5" />
                          </Button>
                        </Link>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Not matched to a case">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Not matched to a case</h2>
              {unlinked.length > 0 && (
                <Button size="sm" variant="ghost" className="gap-1" disabled={marking} onClick={() => void markInboxSeen()}>
                  <CheckCheck className="h-3.5 w-3.5" /> Mark as seen
                </Button>
              )}
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              A text lands here when no open case in this office has that phone number, or when more than one does.
              CareIN does not guess which patient it is.
            </p>
            {unlinked.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="texts-unlinked-empty">
                <Inbox className="h-4 w-4" /> Nothing unmatched.
              </p>
            ) : (
              <ul className="space-y-2">
                {unlinked.map((m) => (
                  <TextRow key={m.messageId} m={m} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
