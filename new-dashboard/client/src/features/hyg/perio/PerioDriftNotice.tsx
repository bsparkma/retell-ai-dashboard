/**
 * The exam CareIN wrote is no longer the exam Open Dental holds (item 14).
 *
 * `Written` claims every site was read back and matched. Open Dental's own perio
 * chart has a Delete button on that screen, so the claim can stop being true
 * without CareIN hearing about it. This is what the re-read says when a `Written`
 * chart is opened — and, for two of its answers, what it deliberately does not.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE THINGS THIS FILE MUST NOT DO
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. It must not draw anything for `matches` or `unknown`. `matches` means the
 *    claim was re-checked and still holds — the existing `Written` line already
 *    says it, and repeating it adds noise. `unknown` means Open Dental could not
 *    be read, and a failed read is not evidence of anything; saying "we could not
 *    check" beside a chart note is worse than silence, because it invites a
 *    hygienist to go looking for a problem nobody has found.
 *
 * 2. It must not offer Send again for `changed`. A reading that differs is A
 *    HUMAN WHO CORRECTED THE CHART IN OPEN DENTAL. Sending again would post a
 *    second exam for the same visit and bury their correction under CareIN's
 *    stale numbers. So `changed` gets a sentence and no button at all — the
 *    component takes no resend handler it could accidentally wire up.
 *
 * 3. It must not press anything itself. There is no effect in here, no timer and
 *    no auto-confirm. A person reads the list of exams the patient already has on
 *    this date and decides.
 *
 * ITEM 32: rule 1 is now about a REASON, not a status. `unknown` used to mean
 * only "Open Dental could not be read" (transient) and stays silent for that
 * (`reason: 'unreadable_od'`). Since item 31 it can also mean "Open Dental holds
 * a value CareIN cannot interpret" (`reason: 'uninterpretable'`) — durable, and
 * somebody's hand. That gets ONE quiet, neutral line naming where: not the
 * amber notice, no icon, no button. CareIN does not know what the value means,
 * so it does not print it — only the tooth, surface and family.
 *
 * ITEM 31: `changed` now covers recession, furcation and mobility as well as
 * probing. Each line names its family ("#3 B gingival margin: …") and mobility
 * names the TOOTH, so a changed recession never reads as a changed depth. The
 * three rules above hold for every family alike.
 */
import { AlertTriangle, Send, Trash2 } from "lucide-react";

import { type PerioDrift, type PerioSameDateExam } from "@shared/hyg/perio";
import { perioChangeLine, perioUnreadableList } from "@shared/hyg/perioSend";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

/** How many changed sites are listed before the rest are counted. */
const SHOWN_CHANGES = 8;

/**
 * The notice, or nothing at all.
 *
 * Returns null for `not_applicable`, `matches` and an `unknown` whose reason is
 * `unreadable_od` — see the header. That silence is the point.
 */
export function PerioDriftNotice({
  drift,
  onResend,
  busy,
}: {
  drift: PerioDrift;
  /** Offered for `missing` ONLY. Opening a dialog; it sends nothing itself. */
  onResend: () => void;
  busy: boolean;
}) {
  if (drift.status === "missing") {
    return (
      <div
        className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
        data-testid="hyg-perio-drift-missing"
      >
        <p className="flex items-start gap-1.5 font-medium text-destructive">
          <Trash2 size={14} className="mt-0.5 shrink-0" />
          Exam {drift.examNum} is no longer in Open Dental.
        </p>
        <p className="mt-1 text-muted-foreground">
          CareIN wrote it and read every site back, and it has since been removed in Open Dental. These
          readings are not in the chart. Nothing has been sent again — send it when you are ready, and it
          will go in as a new exam.
        </p>
        <button
          type="button"
          onClick={onResend}
          disabled={busy}
          className={cn(TAP, "mt-2 inline-flex items-center gap-1.5 border-destructive/40 text-destructive")}
          data-testid="hyg-perio-drift-resend"
        >
          <Send size={14} /> Send again
        </button>
      </div>
    );
  }

  if (drift.status === "changed") {
    const shown = drift.changes.slice(0, SHOWN_CHANGES);
    const rest = drift.changes.length - shown.length;
    return (
      <div
        className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
        data-testid="hyg-perio-drift-changed"
      >
        <p className="flex items-start gap-1.5 font-medium text-amber-800 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Exam {drift.examNum} was changed in Open Dental after CareIN wrote it.
        </p>
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {shown.map((c) => (
            <li key={`${c.tooth}-${c.surface ?? "tooth"}-${c.kind}`} className="font-mono text-xs">
              {perioChangeLine(c)}
            </li>
          ))}
          {rest > 0 ? <li className="text-xs">and {rest} more</li> : null}
        </ul>
        {/*
          NO "Send again" HERE, DELIBERATELY. Somebody corrected this chart in
          Open Dental. What is there is newer than what CareIN wrote.
        */}
        {/*
          ITEM 31: the line runs CareIN → Open Dental (`perioChartChanges(baseline,
          odChart)`), so CareIN's reading is on the LEFT. Before item 31 this
          sentence said the opposite.
        */}
        <p className="mt-1 text-muted-foreground">
          CareIN wrote the readings on the left; Open Dental holds the ones on the right. Somebody edited
          the exam there, so what is in the chart is newer than this. Use{" "}
          <span className="font-medium text-foreground">Amend chart</span> to start from what Open Dental
          holds now.
        </p>
      </div>
    );
  }

  if (drift.status === "unknown" && drift.reason === "uninterpretable" && drift.positions.length > 0) {
    // QUIET AND NEUTRAL, DELIBERATELY: no amber, no icon, no button. Nothing here
    // is known to be wrong — CareIN only knows it cannot read it.
    const plural = drift.positions.length > 1;
    return (
      <p className="px-1 text-sm text-muted-foreground" data-testid="hyg-perio-drift-uninterpretable">
        Open Dental holds {plural ? "values" : "a value"} here CareIN can&rsquo;t read (
        {perioUnreadableList(drift.positions)}). Check {plural ? "them" : "it"} in Open Dental.
      </p>
    );
  }

  // `not_applicable`, `matches`, `unknown` for an unreadable Open Dental — the
  // Written line stands, unqualified.
  return null;
}

/**
 * The resend confirmation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT LISTS EVERY EXAM THE PATIENT ALREADY HAS ON THIS DATE
 * ═════════════════════════════════════════════════════════════════════════════
 * Including ones CareIN did not write. A hygienist who deleted CareIN's exam and
 * re-charted the visit by hand in Open Dental must see that before she creates a
 * second exam for the same visit. CareIN does not decide it for her: the list is
 * shown, plainly, and the button still says Send again.
 *
 * An empty list is its own sentence — the visit has no perio exam at all, which is
 * the ordinary case this exists for.
 */
export function PerioResendConfirm({
  open,
  examNum,
  examDate,
  patientName,
  sameDateExams,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  examNum: number;
  examDate: string;
  patientName: string;
  sameDateExams: PerioSameDateExam[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-w-lg" data-testid="hyg-perio-resend-confirm">
        <DialogHeader>
          <DialogTitle>Send this chart again?</DialogTitle>
          <DialogDescription>
            Exam {examNum} is no longer in Open Dental, so {patientName}&rsquo;s readings for {examDate} are
            not in the chart.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            This posts a <span className="font-medium text-foreground">new</span> exam and reads every site
            back before it says anything landed. It gets a new exam number — {examNum} is not brought back.
          </p>

          <div className="rounded-lg border border-border px-3 py-2">
            <p className="font-medium">
              Perio exams {patientName} already has on {examDate}
            </p>
            {sameDateExams.length === 0 ? (
              <p className="mt-0.5 text-muted-foreground" data-testid="hyg-perio-resend-none">
                None. This visit has no perio exam in Open Dental at all.
              </p>
            ) : (
              <>
                <ul className="mt-1 space-y-0.5" data-testid="hyg-perio-resend-samedate">
                  {sameDateExams.map((e) => (
                    <li key={e.examNum} className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs">Exam {e.examNum}</span>
                      <span className="text-xs text-muted-foreground">
                        {e.careinWrote ? "written by CareIN" : "not written by CareIN"}
                      </span>
                    </li>
                  ))}
                </ul>
                {/*
                  The whole reason the list is here. She may have re-charted the
                  visit in Open Dental already, in which case sending again makes
                  a duplicate — and only she can know that.
                */}
                <p className="mt-1.5 flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  If one of these is this visit&rsquo;s chart, re-charted in Open Dental, sending again will
                  leave the patient with two exams for the same day.
                </p>
              </>
            )}
          </div>

          {error ? (
            <p className="text-destructive" data-testid="hyg-perio-resend-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <button type="button" onClick={onCancel} className={cn(TAP, "border-border")} disabled={busy}>
            Keep it as it is
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(TAP, "border-transparent bg-foreground text-background")}
            data-testid="hyg-perio-resend-confirm-go"
          >
            {busy ? "Working…" : "Send again"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
