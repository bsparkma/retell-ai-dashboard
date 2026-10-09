/**
 * Case view → Messages (queue item 38). Review-then-send for patient messages.
 *
 *   - Thread: outbound and inbound interleaved, oldest first, each with an
 *     honest status ("Draft — not sent", "Not sent" + the provider's reason).
 *   - Compose: channel picker, the consent badge for that channel, the address
 *     the SERVER assembled from the case (shown, never typed), and Save draft.
 *   - Send on a draft is THE approval click. It is disabled — with the reason
 *     spelled out — when the channel's provider is not connected (true for both
 *     channels in this slice) or the consent gate would refuse. The server
 *     re-checks everything on the click; this screen only previews it.
 *
 * `seed` arrives from the follow-up queue's "Draft message" action: the server
 * fills the follow-up template into a NEW draft (no AI), which then sits here
 * like any other draft until a human sends or discards it.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Ban, Clock, Loader2, Mail, MessageSquare, Pencil, Send, ShieldCheck, Trash2 } from "lucide-react";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import type { ChannelReadiness, MessageChannel, TcMessage } from "@shared/tc/messaging";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TcApiError, tcErrorMessage } from "../api";
import { DisabledFeatureNote } from "../components/TcShell";
import {
  createDraft,
  discardDraft,
  editDraft,
  getChannelReadiness,
  listCaseMessages,
  recordOptOut,
  sendMessage,
} from "../messaging/messagingApi";
import {
  BLOCK_COPY,
  CHANNEL_LABEL,
  SEND_ERROR_COPY,
  STATUS_LABEL,
  STATUS_TONE,
  consentBadge,
} from "../messaging/copy";
import { MessageBlockCode } from "@shared/tc/messaging";

export interface MessagesTabSeed {
  followupId: string;
  channel: MessageChannel;
}

export interface MessagesTabProps {
  office: OfficeId;
  tcCase: TcCase;
  /** A follow-up to seed a draft from, once. */
  seed?: MessagesTabSeed | null;
  /** Called after the seed has been turned into a draft (or refused). */
  onSeedConsumed?: () => void;
}

const TONE_CLASS: Record<"muted" | "info" | "ok" | "bad", string> = {
  muted: "bg-muted text-muted-foreground",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

function sendErrorMessage(e: unknown): string {
  if (e instanceof TcApiError && e.code) {
    const block = MessageBlockCode.safeParse(e.code);
    if (block.success) return BLOCK_COPY[block.data];
    const known = SEND_ERROR_COPY[e.code];
    if (known) return known;
  }
  return tcErrorMessage(e);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function MessagesTab({ office, tcCase, seed = null, onSeedConsumed }: MessagesTabProps) {
  const bodyId = useId();
  const subjectId = useId();

  const [messages, setMessages] = useState<TcMessage[]>([]);
  const [readiness, setReadiness] = useState<ChannelReadiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [channel, setChannel] = useState<MessageChannel>(seed?.channel ?? "sms");
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [optOutOpen, setOptOutOpen] = useState(false);

  const caseId = tcCase.caseId;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [m, r] = await Promise.all([listCaseMessages(office, caseId), getChannelReadiness(office, caseId)]);
      setMessages(m);
      setReadiness(r);
    } catch (e) {
      setLoadError(tcErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [office, caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Seed once per mount — a ref, not state, so a re-render cannot seed twice.
  const seeded = useRef(false);
  useEffect(() => {
    if (!seed || seeded.current) return;
    seeded.current = true;
    setChannel(seed.channel);
    createDraft(office, { caseId, channel: seed.channel, followupId: seed.followupId })
      .then(() => {
        toast.success("Draft ready from the follow-up. Review it, then click Send.");
        return load();
      })
      .catch((e: unknown) => toast.error(sendErrorMessage(e)))
      .finally(() => onSeedConsumed?.());
  }, [seed, office, caseId, load, onSeedConsumed]);

  const current = readiness.find((r) => r.channel === channel) ?? null;
  const badge = current ? consentBadge(current.consentState, current.odTextConsent) : null;

  const resetCompose = () => {
    setBody("");
    setSubject("");
    setEditingId(null);
  };

  const handleSave = async () => {
    if (!body.trim()) {
      toast.error("Write the message first.");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await editDraft(office, editingId, {
          body: body.trim(),
          ...(channel === "email" && subject.trim() ? { subject: subject.trim() } : {}),
        });
        toast.success("Draft updated. Nothing was sent.");
      } else {
        await createDraft(office, {
          caseId,
          channel,
          body: body.trim(),
          ...(channel === "email" && subject.trim() ? { subject: subject.trim() } : {}),
        });
        toast.success("Draft saved. Nothing was sent.");
      }
      resetCompose();
      await load();
    } catch (e) {
      toast.error(sendErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSend = async (m: TcMessage) => {
    setBusyId(m.messageId);
    try {
      const sent = await sendMessage(office, m.messageId);
      toast.success(`${CHANNEL_LABEL[sent.channel]} ${STATUS_LABEL[sent.status].toLowerCase()}.`);
      await load();
    } catch (e) {
      toast.error(sendErrorMessage(e));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleDiscard = async (m: TcMessage) => {
    setBusyId(m.messageId);
    try {
      await discardDraft(office, m.messageId);
      if (editingId === m.messageId) resetCompose();
      toast.success("Draft discarded.");
      await load();
    } catch (e) {
      toast.error(sendErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleOptOut = async () => {
    setSaving(true);
    try {
      await recordOptOut(office, caseId, channel);
      toast.success(`${CHANNEL_LABEL[channel]} opt-out recorded.`);
      setOptOutOpen(false);
      await load();
    } catch (e) {
      toast.error(sendErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" data-testid="messages-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading messages…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-start gap-2 py-6" data-testid="messages-error">
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      {/* ── Thread ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-card p-4" aria-label="Message thread">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Thread</h3>
          <p className="text-xs text-muted-foreground">Nothing goes out until you click Send on that message.</p>
        </div>
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="messages-empty">
            No messages with this patient yet.
          </p>
        ) : (
          <ol className="space-y-3" data-testid="messages-thread">
            {messages.map((m) => {
              const inbound = m.direction === "inbound";
              const r = readiness.find((x) => x.channel === m.channel) ?? null;
              const isDraft = m.status === "draft";
              const canSend = isDraft && r !== null && r.adapterEnabled && r.blockCode === null;
              const ChannelIcon = m.channel === "sms" ? MessageSquare : Mail;
              return (
                <li
                  key={m.messageId}
                  data-testid={`message-${m.status}`}
                  className={`flex ${inbound ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl border p-3 ${
                      inbound
                        ? "border-border bg-muted/40"
                        : isDraft
                          ? "border-dashed border-border bg-background"
                          : "border-border bg-primary/5"
                    }`}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <ChannelIcon className="h-3 w-3" />
                      <span>{inbound ? "From patient" : "To patient"}</span>
                      <span>· {formatWhen(m.sentAt ?? m.createdAt)}</span>
                      <span className={`rounded-full px-2 py-0.5 font-medium ${TONE_CLASS[STATUS_TONE[m.status]]}`}>
                        {STATUS_LABEL[m.status]}
                      </span>
                    </div>
                    {m.subject && <p className="text-xs font-semibold text-foreground">{m.subject}</p>}
                    <p className="whitespace-pre-wrap text-sm text-foreground">{m.body}</p>
                    {m.status === "failed" && m.error && (
                      <p className="mt-2 flex items-start gap-1 text-xs text-red-700 dark:text-red-300">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {m.error}
                      </p>
                    )}
                    {isDraft && (
                      <div className="mt-3 space-y-2 border-t border-border pt-2">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1"
                            disabled={busyId === m.messageId}
                            onClick={() => {
                              setChannel(m.channel);
                              setBody(m.body);
                              setSubject(m.subject ?? "");
                              setEditingId(m.messageId);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1"
                            disabled={busyId === m.messageId}
                            onClick={() => void handleDiscard(m)}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Discard
                          </Button>
                          <Button
                            size="sm"
                            className="gap-1"
                            disabled={!canSend || busyId === m.messageId}
                            aria-disabled={!canSend}
                            data-testid="send-button"
                            onClick={() => void handleSend(m)}
                          >
                            {busyId === m.messageId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            Send
                          </Button>
                        </div>
                        {r && !r.adapterEnabled && <DisabledFeatureNote reason="messaging_provider" />}
                        {r && r.blockCode && (
                          <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="send-block">
                            {BLOCK_COPY[r.blockCode]}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ── Compose ────────────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="Compose">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{editingId ? "Edit draft" : "New draft"}</h3>
          {editingId && (
            <Button size="sm" variant="ghost" onClick={resetCompose}>
              Cancel edit
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Channel">
          {(["sms", "email"] as const).map((ch) => {
            const r = readiness.find((x) => x.channel === ch);
            const Icon = ch === "sms" ? MessageSquare : Mail;
            const active = channel === ch;
            return (
              <button
                key={ch}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={editingId !== null && !active}
                onClick={() => setChannel(ch)}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                } disabled:opacity-50`}
              >
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <Icon className="h-3.5 w-3.5" /> {CHANNEL_LABEL[ch]}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {r && r.adapterEnabled ? "Connected" : "Not connected yet"}
                </span>
              </button>
            );
          })}
        </div>

        {current && (
          <div className="space-y-1.5 text-xs" data-testid="consent-panel">
            <p className="text-muted-foreground">
              To:{" "}
              {current.address ? (
                <span className="font-medium text-foreground">{current.address}</span>
              ) : (
                <span className="italic">
                  {channel === "sms" ? "no usable mobile number on the case" : "no email on the case"}
                </span>
              )}
            </p>
            {badge && (
              <Badge
                variant="outline"
                data-testid="consent-badge"
                className={
                  current.consentState === "opted_out" || current.odTextConsent === "no" || current.odTextConsent === "unavailable"
                    ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
                    : current.odTextConsent === "yes"
                      ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                      : "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"
                }
              >
                {current.consentState === "opted_out" ? (
                  <Ban className="h-3 w-3" />
                ) : current.odTextConsent === "yes" ? (
                  <ShieldCheck className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                {badge}
              </Badge>
            )}
            {current.quietHours && (
              <p className="flex items-center gap-1 text-amber-700 dark:text-amber-300" data-testid="quiet-hours">
                <Clock className="h-3 w-3" /> {BLOCK_COPY.QUIET_HOURS}
              </p>
            )}
            {!current.adapterEnabled && <DisabledFeatureNote reason="messaging_provider" />}
          </div>
        )}

        {channel === "email" && (
          <div className="space-y-1.5">
            <Label htmlFor={subjectId}>Subject</Label>
            <Input id={subjectId} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor={bodyId}>Message</Label>
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="h-32 resize-none"
            maxLength={channel === "sms" ? 1600 : 8000}
            placeholder={channel === "sms" ? "Write a text…" : "Write an email…"}
          />
          {channel === "sms" && <p className="text-right text-xs text-muted-foreground">{body.length} characters</p>}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-muted-foreground"
            disabled={!current?.address || current.consentState === "opted_out"}
            onClick={() => setOptOutOpen(true)}
          >
            <Ban className="h-3.5 w-3.5" /> Record opt-out
          </Button>
          <Button size="sm" disabled={saving || !current?.address} onClick={() => void handleSave()}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {editingId ? "Save changes" : "Save draft"}
          </Button>
        </div>
      </section>

      <Dialog open={optOutOpen} onOpenChange={(open) => !saving && setOptOutOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a {CHANNEL_LABEL[channel].toLowerCase()} opt-out?</DialogTitle>
            <DialogDescription>
              Use this when the patient asked not to be contacted this way. It blocks every future{" "}
              {CHANNEL_LABEL[channel].toLowerCase()} to this address for this office, and it cannot be undone from
              this screen.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setOptOutOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={saving} onClick={() => void handleOptOut()}>
              Record opt-out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
