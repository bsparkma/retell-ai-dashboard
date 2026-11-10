/**
 * The voice module's call-notification toggles, on /admin (SC-1).
 *
 * These lived on /admin's old Settings tab, beside the operations readouts.
 * They are a PRACTICE choice (which call alerts this practice wants), so SC-1
 * keeps them on /admin under Module settings → Voice when the operations
 * widgets move to the Developer Console.
 *
 * Same endpoint as before, /api/notifications-config, and the same save
 * behavior. The only change is that the card loads its own config instead of
 * riding the Admin page's combined fetch.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bell, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { NotificationsConfig } from "@/lib/api";

const NOTIF_TOGGLES: Array<{ label: string; key: keyof NotificationsConfig }> = [
  { label: "Emergency call alerts", key: "emergencyCallAlerts" },
  { label: "Missed call notifications", key: "missedCallNotifications" },
  { label: "Daily call summary email", key: "dailyCallSummaryEmail" },
  { label: "Agent error alerts", key: "agentErrorAlerts" },
];

export default function VoiceNotificationsCard() {
  const [notifConfig, setNotifConfig] = useState<NotificationsConfig>({
    emergencyCallAlerts: true,
    missedCallNotifications: true,
    dailyCallSummaryEmail: true,
    agentErrorAlerts: false,
    lastSaved: null,
  });
  const [notifHasUnsaved, setNotifHasUnsaved] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);

  useEffect(() => {
    let live = true;
    // As before: a failed read leaves the defaults showing.
    api
      .getNotificationsConfig()
      .then((cfg) => {
        if (live) setNotifConfig(cfg);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const handleSaveNotifications = async () => {
    setNotifSaving(true);
    try {
      const { lastSaved: _ls, ...toSave } = notifConfig;
      const saved = await api.saveNotificationsConfig(toSave);
      setNotifConfig(saved);
      setNotifHasUnsaved(false);
      toast.success("Notification settings saved");
    } catch {
      toast.error("Save failed — try again");
    } finally {
      setNotifSaving(false);
    }
  };

  return (
    <div data-testid="admin-voice-notifications">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Bell size={14} className="text-primary" /> Notifications
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {NOTIF_TOGGLES.map(({ label, key }) => {
                const enabled = !!notifConfig[key];
                return (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-sm text-foreground">{label}</span>
                    <button
                      className="relative w-10 h-5 rounded-full transition-all"
                      style={{ backgroundColor: enabled ? "var(--primary)" : "color-mix(in oklab, var(--muted-foreground) 30%, transparent)" }}
                      onClick={() => {
                        setNotifConfig(prev => ({ ...prev, [key]: !prev[key] }));
                        setNotifHasUnsaved(true);
                      }}
                    >
                      <span
                        className="absolute top-0.5 left-0.5 w-4 h-4 bg-background dark:bg-foreground rounded-full shadow transition-transform"
                        style={{ transform: enabled ? "translateX(20px)" : "translateX(0)" }}
                      />
                    </button>
                  </div>
                );
              })}
              <div className="flex items-center justify-between pt-2">
                <div className="text-xs text-muted-foreground">
                  {notifConfig.lastSaved
                    ? `Last saved ${new Date(notifConfig.lastSaved).toLocaleString()}`
                    : "Never saved"}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                  disabled={!notifHasUnsaved || notifSaving}
                  onClick={handleSaveNotifications}
                >
                  {notifSaving && <Loader2 size={12} className="animate-spin" />}
                  {notifHasUnsaved ? "Save changes" : "Saved"}
                </Button>
              </div>
            </CardContent>
          </Card>
    </div>
  );
}
