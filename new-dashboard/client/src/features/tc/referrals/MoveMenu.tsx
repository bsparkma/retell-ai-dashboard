/**
 * The hub's "Move to…" menu (referral-manual-moves): the TC side's moves for
 * one referral, in ONE place, replacing the per-verb buttons and the mark box.
 *
 * It lists exactly the actions it is given — hubActionPlan's, which are the
 * shared transition table's — and adds none. Choosing one opens a confirm step
 * with an optional note for the history (mark sent: how / where, required);
 * only the confirm button calls the route. "Edit (re-approval needed)" opens
 * the edit form instead, which is its own confirm step.
 *
 * Nothing here decides anything: the server re-checks the table, the CAS on
 * the status, and who is asking. A stale card is refused with the server's
 * words, shown by the panel.
 *
 * CARD MOVES (referral-card-move-button): the same menu also sits on each hub
 * card (`placement="card"`) — a compact trigger with its own test ids, the
 * same confirm step and note, the same actions. Only the trigger's look and
 * the ids differ; the panel's menu is unchanged.
 */
import { useId, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TcReferralStatus } from "@shared/tc/referrals";
import { hubActionLabel, hubMoveTargetLabel, type HubAction, type HubVerb } from "./hubActions";

/** What each move does, in a sentence, at the confirm step. */
export const MOVE_HINTS: Record<HubVerb, string> = {
  submit: "Sends it to the doctor for sign-off, unless this office does not require one.",
  withdraw: "Takes it back from the doctor so you can edit it.",
  reopen: "Back to the doctor for re-approval, with your edit.",
  cancel: "It moves to Closed / declined / cancelled and cannot be reopened.",
  mark_sent:
    "Only once it has actually gone — by fax, email or by hand, outside the app. This records it; it does not send anything.",
  mark_acknowledged: "The specialist's office confirmed they have it. This records it; it contacts no one.",
  mark_patient_seen: "The specialist has seen the patient. This records it; it contacts no one.",
  close: "Nothing more to do on this referral.",
};

/** Cancelling after it went out also stops the links in the emails already sent. */
const SENT_OR_LATER: readonly TcReferralStatus[] = ["sent", "acknowledged", "patient_seen"];

export type MoveMenuPlacement = "panel" | "card";

export function MoveMenu({
  status,
  actions,
  busy,
  onMove,
  onReopen,
  placement = "panel",
}: {
  status: TcReferralStatus;
  actions: readonly HubAction[];
  busy: boolean;
  /** Run the move; resolves when the panel has the server's answer. */
  onMove: (action: HubAction, note: string) => void;
  onReopen: () => void;
  /** Where it is drawn: the detail panel (default, unchanged) or a hub card (compact). */
  placement?: MoveMenuPlacement;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<HubAction | null>(null);
  const [note, setNote] = useState("");
  // Unique per menu: a card's menu and the panel's can be open at once.
  const noteId = `hub-move-note-${useId()}`;
  // The panel keeps its ids; a card's are its own, so the two never collide.
  const tid = placement === "card" ? "tc-hub-card-move" : "tc-hub-move";

  if (actions.length === 0) return null;

  function choose(action: HubAction) {
    setOpen(false);
    if (action.verb === "reopen") {
      onReopen();
      return;
    }
    setNote("");
    setPending(action);
  }

  function back() {
    setPending(null);
    setNote("");
  }

  if (pending) {
    const required = pending.verb === "mark_sent";
    const isCancel = pending.verb === "cancel";
    return (
      <div className="space-y-2 rounded-lg border border-border p-3" data-testid={`${tid}-confirm`}>
        <p className="text-sm font-medium">
          {isCancel ? "Cancel this referral?" : `${hubActionLabel(pending)} ${hubMoveTargetLabel(pending)}`}
        </p>
        <p className="text-xs text-muted-foreground">
          {MOVE_HINTS[pending.verb]}
          {isCancel && SENT_OR_LATER.includes(status) ? " The links in the emails already sent will stop working." : ""}
        </p>
        <div className="space-y-1">
          <Label htmlFor={noteId} className="text-xs">
            {required ? "How and where was it sent? *" : "Note for the history (optional)"}
          </Label>
          <Input
            id={noteId}
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            placeholder={required ? "e.g. Faxed to their front desk" : ""}
            disabled={busy}
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={isCancel ? "destructive" : "default"}
            onClick={() => {
              const action = pending;
              const text = note.trim();
              setPending(null);
              setNote("");
              onMove(action, text);
            }}
            disabled={busy || (required && !note.trim())}
            data-testid={`${tid}-go`}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} {isCancel ? "Yes, cancel it" : hubActionLabel(pending)}
          </Button>
          <Button size="sm" variant="outline" onClick={back} disabled={busy}>
            {isCancel ? "Keep it" : "Back"}
          </Button>
        </div>
      </div>
    );
  }

  const card = placement === "card";
  return (
    <div className="space-y-1" data-testid={tid}>
      <Button
        size="sm"
        variant="outline"
        className={card ? "h-7 gap-1 px-2 text-xs" : "gap-1"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={card ? "Move this referral" : undefined}
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        data-testid={`${tid}-menu`}
      >
        {card ? "Move" : "Move to…"} <ChevronDown className="w-3.5 h-3.5" />
      </Button>
      {open && (
        <div role="menu" aria-label="Move this referral" className="w-72 rounded-md border border-border bg-popover p-1 shadow-md">
          {actions.map((a) => (
            <button
              key={a.verb}
              type="button"
              role="menuitem"
              className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
              onClick={() => choose(a)}
              data-testid={`${tid}-${a.verb}`}
            >
              <span className={a.verb === "cancel" ? "text-destructive" : undefined}>{hubActionLabel(a)}</span>
              <span className="text-xs text-muted-foreground">{hubMoveTargetLabel(a)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
