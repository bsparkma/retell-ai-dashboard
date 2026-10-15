/**
 * Settings → Notifications (queue item 51).
 *
 * Two columns per event:
 *   Your alerts      your own override, or "Use the office default"
 *   Office default   what everyone in this office gets unless they chose —
 *                    editable by a practice admin, read-only for everyone else
 *
 * In-app only: a badge, a banner, and optionally a chime from this tab.
 * Every value shown is the server's answer after the save, never the click.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell, Loader2, RefreshCw, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { tcErrorMessage } from "@/features/tc/api";
import {
  getNotificationPrefs,
  setMyNotificationLevel,
  setOfficeNotificationLevel,
} from "@/features/tc/notifications/notificationsApi";
import { playChime } from "@/features/tc/notifications/chime";
import {
  DEFAULT_NOTIFICATION_LEVEL,
  TC_NOTIFICATION_EVENT_LABELS,
  TC_NOTIFICATION_LEVEL_LABELS,
  TcNotificationLevel,
  type TcNotificationEvent,
  type TcNotificationPrefsResponse,
} from "@shared/tc/notifications";
import type { OfficeId } from "@shared/tc/contract";

const OFFICE_DEFAULT = "__office__";
const LEVELS = TcNotificationLevel.options;

const SELECT =
  "min-h-10 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60";

export function NotificationsSection({ office }: { office: OfficeId }) {
  const [state, setState] = useState<TcNotificationPrefsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await getNotificationPrefs(office));
    } catch (e) {
      setError(tcErrorMessage(e));
    }
  }, [office]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (kind: "mine" | "office", event: TcNotificationEvent, raw: string) => {
    const level = raw === OFFICE_DEFAULT ? null : TcNotificationLevel.parse(raw);
    setSaving(`${kind}:${event}`);
    try {
      const next =
        kind === "mine"
          ? await setMyNotificationLevel(office, event, level)
          : await setOfficeNotificationLevel(office, event, level);
      setState(next);
      if (level === "sound_banner") playChime();
      toast.success("Saved");
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await load();
    } finally {
      setSaving(null);
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="w-4 h-4 mr-1" aria-hidden /> Retry
        </Button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
        <span className="text-sm">Loading notifications…</span>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-sm space-y-4" data-testid="tc-notifications-section">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Bell className="w-4 h-4" aria-hidden /> Notifications
        </h2>
        <p className="text-sm text-muted-foreground">
          How this app tells you something needs you, while it is open. <strong>Badge only</strong> updates the
          count in the menu; <strong>Banner</strong> also pops up a message; <strong>Sound + banner</strong> adds a
          short chime. Nothing is sent to your phone or email.
        </p>
      </div>

      <div className="space-y-3">
        {state.events.map((e) => (
          <div key={e.event} className="grid grid-cols-1 sm:grid-cols-[1fr_200px_200px] gap-3 items-end rounded-lg border border-border p-3" data-testid={`tc-notify-${e.event}`}>
            <div>
              <p className="text-sm font-medium text-foreground">{TC_NOTIFICATION_EVENT_LABELS[e.event]}</p>
              <p className="text-xs text-muted-foreground" data-testid={`tc-notify-${e.event}-effective`}>
                You get: {TC_NOTIFICATION_LEVEL_LABELS[e.level]}
                {e.source === "user" ? " (your choice)" : e.source === "office" ? " (office default)" : " (built-in default)"}
              </p>
            </div>
            <label className="text-xs text-muted-foreground space-y-1">
              <span>Your alerts</span>
              <select
                className={SELECT}
                value={e.mine ?? OFFICE_DEFAULT}
                disabled={saving !== null}
                onChange={(ev) => void save("mine", e.event, ev.target.value)}
                data-testid={`tc-notify-${e.event}-mine`}
              >
                <option value={OFFICE_DEFAULT}>Use the office default</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {TC_NOTIFICATION_LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground space-y-1">
              <span>Office default</span>
              <select
                className={SELECT}
                value={e.officeDefault ?? OFFICE_DEFAULT}
                disabled={!state.canEditOffice || saving !== null}
                onChange={(ev) => void save("office", e.event, ev.target.value)}
                data-testid={`tc-notify-${e.event}-office`}
                title={state.canEditOffice ? undefined : "Only a practice admin can change this"}
              >
                <option value={OFFICE_DEFAULT}>
                  Built-in ({TC_NOTIFICATION_LEVEL_LABELS[DEFAULT_NOTIFICATION_LEVEL]})
                </option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {TC_NOTIFICATION_LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => playChime()} data-testid="tc-notify-test-sound">
        <Volume2 className="w-4 h-4" aria-hidden /> Test the sound
      </Button>
    </div>
  );
}
