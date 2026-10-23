/**
 * The Nurture Outbox (queue item 47) — the drafts the nightly generator wrote,
 * grouped by campaign, waiting for a person.
 *
 *   Approve   hands THAT draft to the ordinary Send (messagingApi.sendMessage):
 *             the same click, the same consent and quiet-hours checks, the same
 *             honest result as the case's Messages tab.
 *   Skip      the person chose not to send it. It is marked skipped and logged;
 *             the campaign's schedule is untouched.
 *   Approve all (per campaign)
 *             a confirmed loop of individual Sends over the drafts in that
 *             group that can be sent — one request per draft, each checked on
 *             its own, results reported per draft. There is no server-side bulk
 *             send.
 *
 * HONEST STATES. A channel that is not connected for this office gets a
 * banner and NO Approve button on its drafts (the button would only ever
 * fail). A draft flagged at draft time (opted out, unsubscribed, no address)
 * shows why and offers Skip only. Nurture switched off is said in words — not
 * an empty list that looks like "all caught up", and not a row of zeros.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckCheck, Loader2, Mail, MessageSquare, RefreshCw, Send, SkipForward, Sprout } from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import type { MessageChannel } from "@shared/tc/messaging";
import type { NurtureOutboxDraft, NurtureOutboxGroup, NurtureOutboxResponse } from "@shared/tc/nurture";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sendMessage } from "../messaging/messagingApi";
import { adapterReasonCopy, CHANNEL_LABEL } from "../messaging/copy";
import { getNurtureOutbox, skipNurtureDraft } from "./campaignApi";
import { approveErrorText, HINT_COPY, nurtureErrorText } from "./campaignCopy";

type ChannelState = NurtureOutboxResponse["channels"][number];

/** Can this draft be approved at all? null = yes; otherwise the reason it can't. */
function blockedReason(d: NurtureOutboxDraft, channels: ChannelState[]): string | null {
  if (d.consentBlockedHint) return HINT_COPY[d.consentBlockedHint];
  const ch = channels.find((c) => c.channel === d.message.channel);
  if (!ch || !ch.enabled) return ch && ch.reason ? adapterReasonCopy(ch.channel, ch.reason) : "Not connected for this office.";
  return null;
}

export function NurtureOutbox({ office }: { office: OfficeId }) {
  const [data, setData] = useState<NurtureOutboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** message ids with a request in flight */
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const [confirmGroup, setConfirmGroup] = useState<NurtureOutboxGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getNurtureOutbox(office));
    } catch (e) {
      setError(nurtureErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [office]);

  useEffect(() => {
    void load();
  }, [load]);

  const mark = (id: string, on: boolean) =>
    setWorking((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** One Send. Returns null on success, else the reason in words. */
  const approveOne = async (d: NurtureOutboxDraft): Promise<string | null> => {
    mark(d.message.messageId, true);
    try {
      await sendMessage(office, d.message.messageId);
      return null;
    } catch (e) {
      return approveErrorText(e);
    } finally {
      mark(d.message.messageId, false);
    }
  };

  const onApprove = async (d: NurtureOutboxDraft) => {
    const failed = await approveOne(d);
    if (failed) toast.error(failed);
    else toast.success(`${CHANNEL_LABEL[d.message.channel]} sent.`);
    await load();
  };

  const onSkip = async (d: NurtureOutboxDraft) => {
    mark(d.message.messageId, true);
    try {
      await skipNurtureDraft(office, d.message.messageId);
      toast.success("Skipped. It won't be sent, and the campaign carries on as scheduled.");
    } catch (e) {
      toast.error(approveErrorText(e));
    } finally {
      mark(d.message.messageId, false);
    }
    await load();
  };

  const onApproveAll = async (group: NurtureOutboxGroup) => {
    setConfirmGroup(null);
    const sendable = group.drafts.filter((d) => data && blockedReason(d, data.channels) === null);
    let sent = 0;
    const refusals = new Map<string, number>();
    // Sequential on purpose: one Send at a time, each with its own checks.
    for (const d of sendable) {
      const failed = await approveOne(d);
      if (failed) refusals.set(failed, (refusals.get(failed) ?? 0) + 1);
      else sent += 1;
    }
    const notSent = sendable.length - sent;
    if (notSent === 0) toast.success(`${sent} sent from ${group.label}.`);
    else {
      const why = Array.from(refusals.entries()).map(([r, n]) => `${n} × ${r}`).join(" ");
      toast.error(`${sent} sent, ${notSent} not sent. ${why}`);
    }
    await load();
  };

  return (
    <section aria-label="Nurture Outbox" data-testid="nurture-outbox">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sprout className="h-4 w-4 text-violet-600 dark:text-violet-400" /> Nurture Outbox
        </h2>
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Drafts written by nurture campaigns. Nothing here goes out until someone approves it.
      </p>

      {loading && !data ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the outbox…
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : data ? (
        <OutboxBody
          data={data}
          working={working}
          onApprove={(d) => void onApprove(d)}
          onSkip={(d) => void onSkip(d)}
          onApproveAll={(g) => setConfirmGroup(g)}
        />
      ) : null}

      <Dialog open={confirmGroup !== null} onOpenChange={(v) => !v && setConfirmGroup(null)}>
        <DialogContent className="max-w-md">
          {confirmGroup && data && (
            <>
              <DialogHeader>
                <DialogTitle>Send {sendableCount(confirmGroup, data.channels)} from {confirmGroup.label}?</DialogTitle>
                <DialogDescription>
                  Each one is sent on its own through the normal Send, and consent and quiet hours are checked for every
                  one. Anything that can't be sent stays a draft, and you'll see why.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirmGroup(null)}>
                  Cancel
                </Button>
                <Button onClick={() => void onApproveAll(confirmGroup)}>Send them</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function sendableCount(group: NurtureOutboxGroup, channels: ChannelState[]): number {
  return group.drafts.filter((d) => blockedReason(d, channels) === null).length;
}

function OutboxBody({
  data,
  working,
  onApprove,
  onSkip,
  onApproveAll,
}: {
  data: NurtureOutboxResponse;
  working: ReadonlySet<string>;
  onApprove: (d: NurtureOutboxDraft) => void;
  onSkip: (d: NurtureOutboxDraft) => void;
  onApproveAll: (g: NurtureOutboxGroup) => void;
}) {
  const offChannels = data.channels.filter((c) => !c.enabled);
  return (
    <div className="space-y-3">
      {!data.enabled && (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
          data-testid="nurture-off"
        >
          Nurture campaigns are switched off for this office, so no new drafts are being written.
          {data.groups.length > 0 ? " The drafts below were written before it was switched off." : ""}
        </p>
      )}
      {offChannels.map((c) => (
        <p
          key={c.channel}
          className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
          data-testid={`channel-off-${c.channel}`}
        >
          {CHANNEL_LABEL[c.channel]}: {c.reason ? adapterReasonCopy(c.channel, c.reason) : "Not connected for this office."}{" "}
          {c.channel === "sms" ? "Text" : "Email"} drafts can't be approved until it is.
        </p>
      ))}

      {data.groups.length === 0 ? (
        data.enabled ? (
          <p className="text-sm text-muted-foreground" data-testid="nurture-outbox-empty">
            No nurture drafts waiting. New ones are written each morning for campaigns with a touch due.
          </p>
        ) : null
      ) : (
        data.groups.map((g) => {
          const n = sendableCount(g, data.channels);
          return (
            <div key={g.trackKey} className="rounded-lg border border-border" data-testid={`outbox-group-${g.trackKey}`}>
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <span className="text-sm font-medium text-foreground">
                  {g.label} <span className="text-muted-foreground">· {g.drafts.length} waiting</span>
                </span>
                {n > 0 && (
                  <Button size="sm" variant="outline" className="gap-1" onClick={() => onApproveAll(g)}>
                    <CheckCheck className="h-3.5 w-3.5" /> {n === 1 ? "Approve the 1 sendable" : `Approve all ${n}`}
                  </Button>
                )}
              </div>
              <ul className="divide-y divide-border">
                {g.drafts.map((d) => (
                  <DraftRow
                    key={d.message.messageId}
                    d={d}
                    blocked={blockedReason(d, data.channels)}
                    working={working.has(d.message.messageId)}
                    onApprove={() => onApprove(d)}
                    onSkip={() => onSkip(d)}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </div>
  );
}

const CHANNEL_ICON: Record<MessageChannel, typeof Mail> = { sms: MessageSquare, email: Mail };

function DraftRow({
  d,
  blocked,
  working,
  onApprove,
  onSkip,
}: {
  d: NurtureOutboxDraft;
  blocked: string | null;
  working: boolean;
  onApprove: () => void;
  onSkip: () => void;
}) {
  const Icon = CHANNEL_ICON[d.message.channel];
  return (
    <li className="flex items-start gap-3 p-3" data-testid="outbox-draft">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Link href={`/tc/cases/${d.caseId}?tab=messages`} className="font-medium text-foreground hover:underline">
            {d.patientName ?? "Unnamed case"}
          </Link>
          <span>· {CHANNEL_LABEL[d.message.channel]}</span>
          <span>· {d.touchKey}</span>
          {d.consentBlockedHint && (
            <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-300" data-testid="consent-hint">
              {HINT_COPY[d.consentBlockedHint]}
            </Badge>
          )}
        </div>
        {d.message.subject && <p className="mt-1 text-sm font-medium text-foreground">{d.message.subject}</p>}
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground">{d.message.body}</p>
        {blocked && !d.consentBlockedHint && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="approve-blocked">
            {blocked}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        {blocked === null && (
          <Button size="sm" className="gap-1" disabled={working} onClick={onApprove} data-testid="approve">
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Approve
          </Button>
        )}
        <Button size="sm" variant="ghost" className="gap-1" disabled={working} onClick={onSkip} data-testid="skip">
          <SkipForward className="h-3.5 w-3.5" /> Skip
        </Button>
      </div>
    </li>
  );
}
