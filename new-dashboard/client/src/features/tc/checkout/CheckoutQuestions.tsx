/**
 * "Ask hygiene" — the question thread on a checkout card (CO-7), TC side.
 *
 * The front desk asks the hygienist something about this patient; the
 * hygienist sees a badge on the visit in the hygiene app's day view and replies
 * inline. The thread is open while any question in it is unresolved; "Mark
 * resolved" closes every open one. In-app only: nothing is emailed, texted or
 * written to Open Dental, and nothing makes a sound.
 *
 * Everything shown is the server's read-back (each answer is the thread as
 * stored). A thread that cannot be loaded says so — never an empty thread.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCheck, Loader2, MessageCircleQuestion, RefreshCw, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { checkoutClock } from "@/features/tc/checkout/CheckoutOutcome";
import {
  askCheckoutQuestion,
  getCheckoutQuestions,
  resolveCheckoutQuestions,
} from "@/features/tc/checkout/checkoutApi";
import { CHECKOUT_QUESTION_MAX, type TcCheckoutQuestionThread } from "@shared/tc/checkoutRouting";
import type { OfficeId } from "@shared/tc/contract";

/** The visible chip for an open thread — on the card row and atop the thread. */
export function OpenQuestionsChip({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge
      className="gap-1 border-amber-700 bg-amber-300 text-black hover:bg-amber-300 dark:bg-amber-300 dark:text-black"
      data-testid="checkout-open-questions"
    >
      <MessageCircleQuestion className="w-3 h-3" aria-hidden />
      {count} open {count === 1 ? "question" : "questions"} for hygiene
    </Badge>
  );
}

export function CheckoutQuestions({ office, handoffId }: { office: OfficeId; handoffId: string }) {
  const [thread, setThread] = useState<TcCheckoutQuestionThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"ask" | "resolve" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setThread(await getCheckoutQuestions(office, handoffId));
    } catch (e) {
      setError(tcErrorMessage(e));
    }
  }, [office, handoffId]);

  useEffect(() => {
    setThread(null);
    void load();
  }, [load]);

  const ask = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy("ask");
    try {
      setThread(await askCheckoutQuestion(office, handoffId, body));
      setDraft("");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const resolve = async () => {
    setBusy("resolve");
    try {
      setThread(await resolveCheckoutQuestions(office, handoffId));
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-2 border-t border-border pt-4" data-testid="checkout-questions">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Ask hygiene</h3>
        {thread && <OpenQuestionsChip count={thread.open} />}
        {thread && thread.open > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1 text-xs"
            disabled={busy !== null}
            onClick={() => void resolve()}
            data-testid="checkout-questions-resolve"
          >
            {busy === "resolve" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCheck className="w-3 h-3" aria-hidden />}
            Mark resolved
          </Button>
        )}
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span>The questions could not be loaded: {error}</span>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void load()}>
            <RefreshCw className="w-3 h-3" aria-hidden /> Retry
          </Button>
        </div>
      ) : thread === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Loading questions…
        </p>
      ) : (
        <>
          {thread.messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No questions yet. Ask the hygienist something about this patient; they answer from their day view.
            </p>
          ) : (
            <ol className="space-y-1.5" data-testid="checkout-questions-list">
              {thread.messages.map((m) => (
                <li
                  key={m.questionId}
                  className={`rounded-md border p-2 text-sm ${
                    m.authorRole === "hygienist"
                      ? "ml-6 border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950"
                      : m.resolvedAt
                        ? "border-border bg-muted/40 text-muted-foreground"
                        : "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
                  }`}
                  data-testid={`checkout-question-${m.authorRole}`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {m.authorRole === "hygienist" ? "Hygienist" : "Front desk"} · {m.authorEmail} · {checkoutClock(m.createdAt)}
                    {m.authorRole === "tc" && m.resolvedAt ? ` · resolved ${checkoutClock(m.resolvedAt)}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              rows={2}
              maxLength={CHECKOUT_QUESTION_MAX}
              placeholder="e.g. Did they want the crown done before the holidays?"
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Question for hygiene"
              data-testid="checkout-question-draft"
            />
            <Button
              size="sm"
              className="gap-1.5"
              disabled={busy !== null || draft.trim() === ""}
              onClick={() => void ask()}
              data-testid="checkout-question-ask"
            >
              {busy === "ask" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" aria-hidden />}
              Ask
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
