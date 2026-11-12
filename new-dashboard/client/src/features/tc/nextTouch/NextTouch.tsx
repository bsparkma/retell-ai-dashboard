/**
 * Next touch UI: the chip, the date + owner fields, and the dialog that sets
 * one.
 *
 * A case's next touch is its earliest pending follow-up
 * (shared/tc/nextTouch.ts). These components only show and set it. The chip is
 * red when the touch is overdue, amber when it is due today, and neutral when
 * it is upcoming. An open case with none shows "No next step".
 *
 * The dialog's defaults are the slice's: owner = the signed-in person, date =
 * two business days out, channel = a call. "Not now" always closes it and
 * leaves the case flagged, which is the honest state.
 */
import { useEffect, useId, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2 } from "lucide-react";
import type { z } from "zod";
import type { FollowupChannel, TcFollowup } from "@shared/tc/contract";
import {
  pickNextTouch,
  defaultNextTouchDate,
  NEXT_TOUCH_REQUIRED,
  nextTouchState,
  ownerInitials,
  type NextTouchState,
} from "@shared/tc/nextTouch";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import type { TcNextTouchSummary } from "../api";
import { todayIsoDate } from "../lib/followups";

export type ChannelId = z.infer<typeof FollowupChannel>;

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  phone_call: "Call",
  text: "Text",
  email: "Email",
  in_person: "In person",
};
const CHANNEL_IDS = Object.keys(CHANNEL_LABELS) as ChannelId[];

/** The signed-in person's identity string (email), or "" while unknown. */
export function useCurrentUserEmail(): string {
  const auth = useAuth();
  return auth.status === "authenticated" ? auth.user.email : "";
}

/** Did the server refuse a status move because it needs a next touch? */
export function isNextTouchRequired(e: unknown): boolean {
  // Duck-typed on the TcApiError `code` so it holds wherever the api module is
  // mocked or bundled twice.
  return typeof e === "object" && e !== null && "code" in e && e.code === NEXT_TOUCH_REQUIRED;
}

/** A full case's followups → the compact next touch a summary row carries. */
export function nextTouchSummaryOf(followups: readonly TcFollowup[]): TcNextTouchSummary | null {
  const t = pickNextTouch(followups);
  return t
    ? { followupId: t.followupId, dueDate: t.dueDate, owner: t.owner, channel: t.channel, kind: t.kind }
    : null;
}

/** "Nov 13" for a YYYY-MM-DD date, timezone-proof. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const STATE_CLASS: Record<NextTouchState, string> = {
  overdue:
    "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  today:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  upcoming: "border-border bg-muted text-muted-foreground",
};

const STATE_WORD: Record<NextTouchState, string> = {
  overdue: "overdue",
  today: "due today",
  upcoming: "upcoming",
};

/**
 * The card chip. `nextTouch` null = an open case with no pending follow-up:
 * "No next step". The caller decides whether the case is open at all.
 */
export function NextTouchChip({
  nextTouch,
  today,
  className,
}: {
  nextTouch: { dueDate: string; owner: string | null } | null;
  today?: string;
  className?: string;
}) {
  if (nextTouch === null) {
    return (
      <span
        data-testid="next-touch-chip"
        data-state="none"
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-dashed border-red-300 bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700",
          "dark:border-red-900 dark:bg-red-950 dark:text-red-300",
          className,
        )}
      >
        <AlertTriangle className="w-3 h-3" />
        No next step
      </span>
    );
  }
  const state = nextTouchState(nextTouch.dueDate, today ?? todayIsoDate());
  const initials = ownerInitials(nextTouch.owner);
  return (
    <span
      data-testid="next-touch-chip"
      data-state={state}
      title={`Next touch ${shortDate(nextTouch.dueDate)} (${STATE_WORD[state]}) · ${nextTouch.owner ?? "no owner"}`}
      aria-label={`Next touch ${shortDate(nextTouch.dueDate)}, ${STATE_WORD[state]}, owner ${nextTouch.owner ?? "none"}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        STATE_CLASS[state],
        className,
      )}
    >
      <CalendarClock className="w-3 h-3" />
      {shortDate(nextTouch.dueDate)}
      <span className="rounded bg-background/60 px-1 font-semibold tracking-wide">{initials}</span>
    </span>
  );
}

export interface NextTouchValues {
  dueDate: string;
  owner: string;
  channel: ChannelId;
}

/** The slice's defaults: +2 business days, the signed-in person, a call. */
export function defaultNextTouchValues(owner: string, today: string = todayIsoDate()): NextTouchValues {
  return { dueDate: defaultNextTouchDate(today), owner, channel: "phone_call" };
}

/** Date + owner both present and well-formed. */
export function nextTouchValuesError(v: NextTouchValues): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.dueDate)) return "Pick a next-touch date.";
  if (v.owner.trim() === "") return "Name who owns the next touch.";
  return null;
}

/** The two required fields (date + owner) plus channel, controlled. */
export function NextTouchFields({
  value,
  onChange,
  disabled = false,
}: {
  value: NextTouchValues;
  onChange: (next: NextTouchValues) => void;
  disabled?: boolean;
}) {
  const dateId = useId();
  const ownerId = useId();
  const channelId = useId();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor={dateId}>Next touch</Label>
        <Input
          id={dateId}
          type="date"
          value={value.dueDate}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, dueDate: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={ownerId}>Owner</Label>
        <Input
          id={ownerId}
          value={value.owner}
          disabled={disabled}
          autoComplete="off"
          placeholder="Who makes the touch"
          onChange={(e) => onChange({ ...value, owner: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={channelId}>How</Label>
        <Select
          value={value.channel}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...value, channel: v as ChannelId })}
        >
          <SelectTrigger id={channelId} aria-label="Next touch channel" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_IDS.map((c) => (
              <SelectItem key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * "Set the next touch" dialog. `onSave` does the write (create a follow-up, or
 * re-send a status move with nextTouch). The dialog only closes after it
 * resolves. A failure keeps the values and shows the message. "Not now"
 * dismisses and leaves the case as it is.
 */
export function SetNextTouchDialog({
  open,
  onOpenChange,
  title,
  description,
  saveLabel = "Set next touch",
  dismissLabel = "Not now",
  today,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  saveLabel?: string;
  dismissLabel?: string;
  today?: string;
  onSave: (values: NextTouchValues) => Promise<void>;
}) {
  const me = useCurrentUserEmail();
  const [values, setValues] = useState<NextTouchValues>(() => defaultNextTouchValues(me, today));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Fresh defaults each time it opens (and once the signed-in user is known).
  useEffect(() => {
    if (open) {
      setValues(defaultNextTouchValues(me, today));
      setError(null);
      setSaving(false);
    }
  }, [open, me, today]);

  const save = async () => {
    const problem = nextTouchValuesError(values);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({ ...values, owner: values.owner.trim() });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set the next touch.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <NextTouchFields value={values} onChange={setValues} disabled={saving} />
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {dismissLabel}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
