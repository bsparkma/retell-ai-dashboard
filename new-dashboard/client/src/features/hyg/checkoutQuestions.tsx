/**
 * CO-7 — the front desk's questions on a visit's checkout card, in the hygiene
 * day view: a badge under the visit with the open-question count, and an inline
 * reply box.
 *
 * The badges are counts per AptNum (GET /api/hyg/day/checkout-questions), read
 * the way the progress pill is: on load, every 60 s while visible, and on focus.
 * The thread itself — free text about a patient — is read only when the
 * hygienist opens it (audited on the server). A reply is the server's
 * read-back. In-app only, and silent: no sound, no email, no text.
 *
 * Rendered BESIDE the appointment card, never inside it: the card is a link,
 * and a text box inside a link is a text box nobody can type in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageCircleQuestion, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchCheckoutQuestionBadges,
  fetchCheckoutThread,
  replyCheckoutQuestion,
} from "@/features/hyg/api";
import {
  CHECKOUT_QUESTION_MAX,
  type HygCheckoutQuestionBadge,
  type TcCheckoutQuestionThread,
} from "@shared/tc/checkoutRouting";
import type { OfficeId } from "@shared/tc/contract";

export interface CheckoutQuestionBadges {
  /** The badge for one AptNum, or null (no thread, or not read yet). */
  badgeFor: (aptNum: number | null) => HygCheckoutQuestionBadge | null;
  /** The last read failed: say so once, rather than showing no badges as if none. */
  failed: boolean;
  /** Ask again now (after a reply). */
  refresh: () => void;
}

/**
 * The day's badges. `aptNums` empty or `office` null → nothing is asked.
 */
export function useCheckoutQuestionBadges(
  office: OfficeId | null,
  date: string | null,
  aptNums: readonly number[],
): CheckoutQuestionBadges {
  const key = office && date && aptNums.length > 0 ? `${office}|${date}|${aptNums.join(",")}` : "";
  const query = useRef({ office, date, aptNums });
  query.current = { office, date, aptNums };
  const [read, setRead] = useState<{ key: string; failed: boolean; byApt: ReadonlyMap<number, HygCheckoutQuestionBadge> }>({
    key: "",
    failed: false,
    byApt: new Map(),
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const q = query.current;
    if (!key || !q.office || !q.date) return;
    const qOffice = q.office;
    const qDate = q.date;
    const qApts = q.aptNums;
    let disposed = false;
    let inFlight: AbortController | null = null;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      inFlight?.abort();
      const mine = new AbortController();
      inFlight = mine;
      fetchCheckoutQuestionBadges(qOffice, qDate, qApts, mine.signal)
        .then((res) => {
          if (disposed || mine.signal.aborted) return;
          setRead({ key, failed: false, byApt: new Map(res.badges.map((b) => [b.aptNum, b])) });
        })
        .catch(() => {
          if (disposed || mine.signal.aborted) return;
          setRead({ key, failed: true, byApt: new Map() });
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const timer = setInterval(load, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      inFlight?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", load);
    };
  }, [key, nonce]);

  const badgeFor = useCallback(
    (aptNum: number | null) => (aptNum !== null && read.key === key ? read.byApt.get(aptNum) ?? null : null),
    [read, key],
  );
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { badgeFor, failed: read.key === key && read.failed, refresh };
}

/**
 * Under one visit's card: "2 questions from the front desk" — open, the thread
 * and a reply box. Nothing at all when the visit's card has no thread.
 */
export function VisitCheckoutQuestions({
  office,
  aptNum,
  badge,
  onChanged,
}: {
  office: OfficeId;
  aptNum: number | null;
  badge: HygCheckoutQuestionBadge | null;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [thread, setThread] = useState<TcCheckoutQuestionThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (aptNum === null) return;
    setError(null);
    try {
      setThread(await fetchCheckoutThread(office, aptNum));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The questions could not be loaded");
    }
  }, [office, aptNum]);

  useEffect(() => {
    if (expanded) void load();
  }, [expanded, load]);

  if (!badge || aptNum === null) return null;
  const open = thread ? thread.open : badge.open;

  const reply = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      setThread(await replyCheckoutQuestion(office, aptNum, body));
      setDraft("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The reply was not saved");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5" data-testid="hyg-checkout-questions">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
          open > 0
            ? "border-amber-700 bg-amber-300 text-black"
            : "border-border bg-muted text-muted-foreground"
        }`}
        data-testid="hyg-checkout-questions-badge"
      >
        <MessageCircleQuestion size={14} aria-hidden />
        {open > 0
          ? `${open} open ${open === 1 ? "question" : "questions"} from the front desk`
          : "Front desk questions answered"}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 rounded-lg border border-border bg-card p-2.5" data-testid="hyg-checkout-thread">
          {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
          {thread === null && !error ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" aria-hidden /> Loading…
            </p>
          ) : thread ? (
            <ol className="space-y-1.5">
              {thread.messages.map((m) => (
                <li
                  key={m.questionId}
                  className={`rounded-md p-2 text-sm ${
                    m.authorRole === "hygienist" ? "ml-4 bg-sky-50 dark:bg-sky-950" : "bg-amber-50 dark:bg-amber-950"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {m.authorRole === "hygienist" ? "You / hygiene" : "Front desk"} · {m.authorEmail}
                    {m.authorRole === "tc" && m.resolvedAt ? " · resolved" : ""}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
          {thread && thread.open > 0 && (
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                rows={2}
                maxLength={CHECKOUT_QUESTION_MAX}
                placeholder="Reply to the front desk"
                aria-label="Reply to the front desk"
                onChange={(e) => setDraft(e.target.value)}
                data-testid="hyg-checkout-reply-draft"
              />
              <Button
                size="sm"
                className="min-h-9 gap-1.5"
                disabled={busy || draft.trim() === ""}
                onClick={() => void reply()}
                data-testid="hyg-checkout-reply-send"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} aria-hidden />}
                Reply
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
