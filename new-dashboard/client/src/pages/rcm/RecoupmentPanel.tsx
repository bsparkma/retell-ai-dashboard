/**
 * D-6 — the takeback panel and its typed confirmation (Slice 6d).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A TAKEBACK HAS ITS OWN PANEL AND ITS OWN BUTTON
 * ═════════════════════════════════════════════════════════════════════════════
 * The ordinary Approve button refuses every recoupment and always will. Merging
 * the two would put "approve nine claims" and "authorise a write that may never
 * be undone" behind the same click, distinguished only by whichever claims
 * happened to be on the remittance — and the number of claims is not the sort of
 * thing a person notices at the moment they press a button.
 *
 * So this is separate, visually distinct, and it never says "Approve N claims".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DIALOG IS A COURTESY. THE SERVER IS THE GATE.
 * ═════════════════════════════════════════════════════════════════════════════
 * Everything below — the typed field, the disabled button, the path radio — is
 * for the person, not for safety. `POST /approve-recoupment` recomputes the
 * total from the claim rows and compares it to the string that was sent, so a
 * request that skips this screen entirely is refused exactly the same way.
 * Nothing here is load-bearing, and nothing here should ever be trusted to be.
 *
 * Two details that ARE load-bearing, both about honesty rather than security:
 *
 *   1. `typedTotalExpected` is rendered VERBATIM from the server. The client
 *      never formats cents into the phrase it is about to demand — that is how
 *      a dialog comes to show `-54.08` while the server wants `-54.8`, leaving
 *      an approver typing something nothing ever displayed.
 *
 *   2. The path radio defaults to the server's `defaultPath`, not to a constant
 *      here. The adjustment is the default and the supplemental is the opt-in,
 *      and that ordering must not be a thing a client can quietly get wrong.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Undo2 } from "lucide-react";
import {
  approveRecoupment,
  getRecoupmentChecklist,
  RcmApiError,
  type RecoupmentApprovalResult,
  type RecoupmentChecklist,
  type RecoupmentPath,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `absent` IS NOT `failed`, AND THAT IS THE WHOLE POINT OF THIS UNION
 * ─────────────────────────────────────────────────────────────────────────────
 * This panel used to render a red failure line for ANY error the checklist read
 * returned — a 404 included. A 404 from `GET /:id/recoupment` means the check is
 * not there for this office (a stale id, a check retired underneath an open tab,
 * a link followed after an office switch). It does not mean anything went wrong,
 * and it certainly does not mean anything went wrong WITH A TAKEBACK.
 *
 * A false red on the one surface whose subject is money moving BACKWARDS is a
 * trust defect, not a cosmetic one: a biller who has learned that this panel
 * cries wolf is a biller who will scroll past the day it does not. So an absence
 * renders nothing, exactly as `recoupmentClaims === 0` already does, and the
 * failure line is reserved for real errors — a 500, a timeout, a refusal.
 *
 * Handed to Stage B by Stage A's review, which found it while rebuilding this
 * screen's neighbour.
 */
type State =
  | { kind: "loading" }
  /** There is no such check here. Render nothing — see above. */
  | { kind: "absent" }
  | { kind: "loaded"; checklist: RecoupmentChecklist }
  | { kind: "failed"; message: string };

/**
 * What each path actually costs, in the words a biller needs at the moment of
 * choosing. The asymmetry is the entire decision, so it is stated plainly rather
 * than left to the labels.
 */
const PATH_COPY: Record<RecoupmentPath, { label: string; detail: string }> = {
  adjustment: {
    label: "As an adjustment (can be undone)",
    detail:
      "Books the takeback on the patient's ledger under this practice's " +
      "“Insurance deductions from previous payments” type. If it turns out to be " +
      "wrong it can be reversed by posting an offsetting adjustment.",
  },
  supplemental: {
    label: "As a negative supplemental (PERMANENT)",
    detail:
      "Writes the takeback onto the claim itself. Open Dental cannot reverse or delete " +
      "it afterwards by any means this integration has, and it permanently pins the claim " +
      "and the procedure it is attached to. Choose this only if your practice specifically " +
      "needs the takeback to sit on the claim.",
  },
};

export function RecoupmentPanel({
  office,
  batchId,
  onApproved,
}: {
  office: RcmOfficeId;
  batchId: string;
  onApproved?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [typed, setTyped] = useState("");
  const [path, setPath] = useState<RecoupmentPath>("adjustment");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecoupmentApprovalResult | null>(null);

  useEffect(() => {
    let live = true;
    getRecoupmentChecklist(office, batchId)
      .then((checklist) => {
        if (!live) return;
        setState({ kind: "loaded", checklist });
        // The server states the default so a client cannot pre-select the
        // irreversible path by omission.
        setPath(checklist.defaultPath);
      })
      .catch((err) => {
        if (!live) return;
        /*
         * 404 = there is no such check for this office. An ABSENCE, not a
         * failure, and the panel says nothing about it.
         */
        if (err instanceof RcmApiError && err.status === 404) {
          setState({ kind: "absent" });
          return;
        }
        setState({
          kind: "failed",
          message:
            err instanceof RcmApiError ? err.message : "The takeback panel could not load.",
        });
      });
    return () => {
      live = false;
    };
  }, [office, batchId]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the takeback…
      </div>
    );
  }
  /*
   * Nothing at all — the same silence a check with no takeback on it gets. A
   * panel that appears to say "there is no takeback here" would be an invitation
   * to go looking for one.
   */
  if (state.kind === "absent") return null;

  if (state.kind === "failed") {
    return (
      <p className="p-4 text-sm text-rose-700 dark:text-rose-400" data-testid="recoupment-failed">
        {state.message}
      </p>
    );
  }

  const { checklist } = state;

  /*
   * ZERO IS A REAL ANSWER, and the panel does not render at all for it. A
   * takeback dialog on a remittance with no takeback is an invitation to look
   * for one.
   */
  if (checklist.recoupmentClaims === 0) return null;

  if (result) {
    return (
      <div
        className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30"
        data-testid="recoupment-result"
      >
        <p className="text-sm font-medium">Takeback queued</p>
        {/* The server's own sentence, so it changes on the day it stops being true. */}
        <p className="mt-1 text-xs text-muted-foreground" data-testid="recoupment-note">
          {result.note}
        </p>
      </div>
    );
  }

  const phraseMatches = typed.trim() === checklist.typedTotalExpected;
  const canSubmit = checklist.canApprove && checklist.balanced && phraseMatches && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    approveRecoupment(office, batchId, { typedTotal: typed.trim(), path })
      .then((res) => {
        setResult(res);
        onApproved?.();
      })
      .catch((err) => {
        /*
         * The server's refusal wins over anything this screen believed. If it
         * says the phrase was wrong, it also says what it wanted — show that
         * rather than a bare "no".
         */
        const expected =
          err instanceof RcmApiError && typeof err.details?.expected === "string"
            ? err.details.expected
            : null;
        setError(
          err instanceof RcmApiError
            ? expected
              ? `${err.message} (expected ${expected})`
              : err.message
            : "The takeback could not be approved.",
        );
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div
      className="rounded-xl border-2 border-amber-400 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
      data-testid="recoupment-panel"
    >
      <div className="flex items-start gap-2 border-b border-amber-300 px-4 py-3 dark:border-amber-900">
        <Undo2 className="mt-0.5 h-4 w-4 text-amber-700 dark:text-amber-400" />
        <div>
          <p className="text-sm font-medium">The carrier is taking money back</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {checklist.recoupmentClaims === 1
              ? "One claim on this remittance is a takeback."
              : `${checklist.recoupmentClaims} claims on this remittance are takebacks.`}{" "}
            This is approved separately from the rest.
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        <p className="text-sm">
          Total being taken back:{" "}
          <span className="font-mono font-medium" data-testid="recoupment-total">
            {money(checklist.recoupmentTotalCents)}
          </span>
        </p>

        <fieldset className="mt-3">
          <legend className="text-xs font-medium">How should it be written?</legend>
          {checklist.paths.map((p) => (
            <label key={p} className="mt-2 flex items-start gap-2 text-xs">
              <input
                type="radio"
                name="recoupment-path"
                className="mt-0.5"
                value={p}
                checked={path === p}
                onChange={() => setPath(p)}
                data-testid={`recoupment-path-${p}`}
              />
              <span>
                <span className="font-medium">{PATH_COPY[p].label}</span>
                <span className="block text-muted-foreground">{PATH_COPY[p].detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {path === "supplemental" && (
          <p
            className="mt-3 flex items-start gap-2 rounded-md bg-rose-100 p-2 text-xs text-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
            data-testid="recoupment-permanent-warning"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This cannot be undone. Once it posts, nothing in CareIN or the Open Dental API
              can reverse or delete it.
            </span>
          </p>
        )}

        <label className="mt-3 block text-xs font-medium" htmlFor="recoupment-confirm">
          To confirm, type{" "}
          {/* VERBATIM from the server. Never formatted here — see the header. */}
          <span className="font-mono" data-testid="recoupment-expected">
            {checklist.typedTotalExpected}
          </span>
        </label>
        <input
          id="recoupment-confirm"
          className="mt-1 w-40 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-testid="recoupment-confirm-input"
        />

        {error && (
          <p className="mt-2 text-xs text-rose-700 dark:text-rose-400" data-testid="recoupment-error">
            {error}
          </p>
        )}

        <div className="mt-3">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-amber-700 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-amber-800"
            data-testid="recoupment-approve-button"
          >
            {submitting ? "Approving…" : "Approve the takeback"}
          </button>
          {/*
            A DISABLED BUTTON MUST SAY WHY. §15.2's finding from the staging
            walk: a disabled control with no reason is indistinguishable from a
            broken one.
          */}
          {!checklist.canApprove ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="recoupment-needs-permission">
              Approving a takeback needs posting permission ({checklist.approveRequires}).
            </p>
          ) : !checklist.balanced ? (
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              This remittance does not balance, so nothing on it can be approved yet.
            </p>
          ) : !phraseMatches ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="recoupment-awaiting-phrase">
              Type the amount above exactly as it is shown to enable this.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
