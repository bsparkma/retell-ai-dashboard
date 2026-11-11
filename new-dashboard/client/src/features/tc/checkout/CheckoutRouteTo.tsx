/**
 * "Route to…" on a checkout card (CO-6).
 *
 * While the card waits, the desk can send the patient to one of four places in
 * TC without answering the checkout:
 *
 *   Pre-auth    a pre-authorization, prefilled from the card (the staged
 *               procedures become its description), on the patient's case when
 *               there is one
 *   Pipeline    the patient's case, at the status picked here
 *   Follow-up   a follow-up on that case: due date and talking point required
 *   TC Inbox    an unowned case for a coordinator to claim later — this one
 *               CLOSES the card (Dismissed, "Sent to the TC Inbox")
 *
 * The first three leave the card Waiting and point it at the case they touched;
 * the checkout is still answered Scheduled / Not scheduled / Nothing needed.
 * Nothing here names the patient: the server takes them from the stored card.
 * What the card shows afterwards is the server's read-back, never the click.
 */
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ClipboardList, Forward, GitBranch, Inbox, Loader2, PhoneCall, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { CASE_STATUSES } from "@/features/tc/status";
import { routeCheckout } from "@/features/tc/checkout/checkoutApi";
import {
  TC_CHECKOUT_PIPELINE_STATUSES,
  TC_CHECKOUT_ROUTE_DESTINATIONS,
  TC_CHECKOUT_ROUTE_LABELS,
  type TcCheckoutPipelineStatus,
  type TcCheckoutRouteDestination,
  type TcCheckoutRouteRequest,
} from "@shared/tc/checkoutRouting";
import { TC_CHECKOUT_WAITING, type TcCheckoutHandoff } from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

const ICONS: Record<TcCheckoutRouteDestination, LucideIcon> = {
  preauth: ClipboardList,
  pipeline: GitBranch,
  followup: PhoneCall,
  inbox: Inbox,
};

const HINTS: Record<TcCheckoutRouteDestination, string> = {
  preauth: "A pre-authorization for this patient, prefilled from the card. The card stays waiting.",
  pipeline: "The patient's case, at the status you pick. The card stays waiting.",
  followup: "A follow-up on the patient's case. The card stays waiting.",
  inbox: "An unowned case in the TC Inbox, for a coordinator to claim. This closes the card.",
};

const CHANNELS = [
  ["phone_call", "Phone call"],
  ["text", "Text"],
  ["email", "Email"],
  ["in_person", "In person"],
] as const;

const SELECT =
  "w-full h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

/** Today in the office's own day, YYYY-MM-DD — the earliest due date offered. */
function officeToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export function CheckoutRouteTo({
  office,
  handoff,
  onAdopt,
  onReload,
}: {
  office: OfficeId;
  handoff: TcCheckoutHandoff;
  /** The server's read-back of the card after a routing. */
  onAdopt: (next: TcCheckoutHandoff) => void;
  onReload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [dest, setDest] = useState<TcCheckoutRouteDestination>("pipeline");
  const [busy, setBusy] = useState(false);
  // Pre-auth
  const [preauthType, setPreauthType] = useState<"treatment" | "perio" | "manual">("treatment");
  const [carrier, setCarrier] = useState("");
  // Pipeline
  const [status, setStatus] = useState<TcCheckoutPipelineStatus>("pending_tc");
  // Follow-up
  const [dueDate, setDueDate] = useState("");
  const [talkingPoint, setTalkingPoint] = useState("");
  const [channel, setChannel] = useState<(typeof CHANNELS)[number][0]>("phone_call");
  // Shared note (pre-auth notes, pipeline / inbox note)
  const [note, setNote] = useState("");

  if (!TC_CHECKOUT_WAITING.includes(handoff.status)) return null;

  const reset = () => {
    setNote("");
    setCarrier("");
    setTalkingPoint("");
    setDueDate("");
  };

  const body = (): TcCheckoutRouteRequest | null => {
    switch (dest) {
      case "preauth":
        return { destination: "preauth", preauthType, insuranceCarrier: carrier.trim(), notes: note.trim() };
      case "pipeline":
        return { destination: "pipeline", status, note: note.trim() };
      case "followup":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || talkingPoint.trim() === "") return null;
        return { destination: "followup", dueDate, talkingPoint: talkingPoint.trim(), channel };
      case "inbox":
        return { destination: "inbox", note: note.trim() };
    }
  };
  const ready = body() !== null;

  const submit = async () => {
    const b = body();
    if (!b) return;
    setBusy(true);
    try {
      const res = await routeCheckout(office, handoff.handoffId, b);
      onAdopt(res.handoff);
      const url = res.url;
      const what =
        res.destination === "preauth"
          ? res.caseId
            ? "Pre-auth created on the patient's case"
            : "Pre-auth created (the patient has no open case)"
          : res.destination === "pipeline"
            ? res.statusChanged
              ? `Case moved to ${CASE_STATUSES[status].label}`
              : `The case was already ${CASE_STATUSES[status].label}; noted on its timeline`
            : res.destination === "followup"
              ? `Follow-up due ${b.destination === "followup" ? b.dueDate : ""} added`
              : "Sent to the TC Inbox — this card is closed";
      toast.success(what, url ? { action: { label: "Open case", onClick: () => window.location.assign(url) } } : undefined);
      setOpen(false);
      reset();
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
        data-testid="checkout-route-open"
      >
        <Forward className="w-3.5 h-3.5" aria-hidden /> Route to…
      </Button>
      {/* The card's annotation: a routing points it at the case it touched. */}
      {handoff.caseId && (
        <span className="text-xs text-muted-foreground" data-testid="checkout-route-linked">
          Routed to a case ·{" "}
          <Link href={`/tc/cases/${handoff.caseId}`} className="underline text-primary">
            Open the case
          </Link>
        </span>
      )}
      <Dialog open={open} onOpenChange={(o) => (busy ? undefined : setOpen(o))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Route {handoff.patientName} to…</DialogTitle>
            <DialogDescription>{HINTS[dest]}</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label="Destination">
            {TC_CHECKOUT_ROUTE_DESTINATIONS.map((d) => {
              const Icon = ICONS[d];
              return (
                <Button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={dest === d}
                  variant={dest === d ? "default" : "outline"}
                  className="min-h-11 flex-col gap-1 py-2 text-xs"
                  onClick={() => setDest(d)}
                  data-testid={`checkout-route-dest-${d}`}
                >
                  <Icon className="w-4 h-4" aria-hidden />
                  {TC_CHECKOUT_ROUTE_LABELS[d]}
                </Button>
              );
            })}
          </div>

          <div className="space-y-3">
            {dest === "preauth" && (
              <>
                <label className="block text-xs font-medium text-muted-foreground space-y-1">
                  <span>Type</span>
                  <select
                    className={SELECT}
                    value={preauthType}
                    onChange={(e) => setPreauthType(e.target.value as typeof preauthType)}
                    data-testid="checkout-route-preauth-type"
                  >
                    <option value="treatment">Treatment</option>
                    <option value="perio">Perio</option>
                    <option value="manual">Manual</option>
                  </select>
                </label>
                <label className="block text-xs font-medium text-muted-foreground space-y-1">
                  <span>Insurance carrier (optional)</span>
                  <Input
                    value={carrier}
                    maxLength={200}
                    onChange={(e) => setCarrier(e.target.value)}
                    data-testid="checkout-route-preauth-carrier"
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  The description is the card&apos;s staged procedures. Edit the pre-auth afterwards on the Pre-auth page.
                </p>
              </>
            )}
            {dest === "pipeline" && (
              <label className="block text-xs font-medium text-muted-foreground space-y-1">
                <span>Status</span>
                <select
                  className={SELECT}
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TcCheckoutPipelineStatus)}
                  data-testid="checkout-route-status"
                >
                  {TC_CHECKOUT_PIPELINE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {CASE_STATUSES[s].label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {dest === "followup" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs font-medium text-muted-foreground space-y-1">
                    <span>Due date *</span>
                    <Input
                      type="date"
                      min={officeToday()}
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      data-testid="checkout-route-followup-due"
                    />
                  </label>
                  <label className="block text-xs font-medium text-muted-foreground space-y-1">
                    <span>How</span>
                    <select
                      className={SELECT}
                      value={channel}
                      onChange={(e) => setChannel(e.target.value as typeof channel)}
                      data-testid="checkout-route-followup-channel"
                    >
                      {CHANNELS.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block text-xs font-medium text-muted-foreground space-y-1">
                  <span>Talking point *</span>
                  <Textarea
                    value={talkingPoint}
                    rows={3}
                    maxLength={8000}
                    placeholder="What to say when you reach them"
                    onChange={(e) => setTalkingPoint(e.target.value)}
                    data-testid="checkout-route-followup-talking"
                  />
                </label>
              </>
            )}
            {dest !== "followup" && (
              <label className="block text-xs font-medium text-muted-foreground space-y-1">
                <span>{dest === "preauth" ? "Notes (optional)" : "Note (optional)"}</span>
                <Textarea
                  value={note}
                  rows={2}
                  maxLength={dest === "preauth" ? 8000 : 500}
                  onChange={(e) => setNote(e.target.value)}
                  data-testid="checkout-route-note"
                />
              </label>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !ready} onClick={() => void submit()} data-testid="checkout-route-confirm">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Route to ${TC_CHECKOUT_ROUTE_LABELS[dest]}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
