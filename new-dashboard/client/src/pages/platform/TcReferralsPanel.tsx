/**
 * The TC referrals switches, per office: referrals itself (queue item 52),
 * referral EMAIL (R5) and (R5b) the PATIENT email after a send. The same
 * shape and the same honesty rules as TcCheckoutPanel (item 50), drawn by one
 * component with three configurations.
 *
 * Mirrors the Hygiene panel's honesty rules: the state shown is what the
 * server answered after the write (never the click), the layer that answered
 * is named, and an env break-glass that is overriding the switch is said out
 * loud. Turning an office ON asks for confirmation; turning it OFF does not —
 * the fast path is the safe one.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, Loader2, Mail, Send, ShieldAlert, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type { TcCheckoutOfficeSwitch, TcReferralsSwitchState } from "@/lib/api";

const OFFICE_LABELS: Record<string, string> = { roland: "Roland", valley: "Riley (valley)" };

const SOURCE_LABELS: Record<TcCheckoutOfficeSwitch["source"], string> = {
  db: "Set here",
  env: "Environment override",
  default: "Default (off)",
};

interface SwitchPanelConfig {
  /** data-testid prefix: `${prefix}-panel`, `${prefix}-office-<o>`, `${prefix}-switch-<o>`, `${prefix}-confirm-on`. */
  prefix: string;
  /** "Referrals" / "Referral email" — in toasts, labels and the dialog. */
  noun: string;
  icon: ReactNode;
  title: string;
  description: string;
  confirmDescription: string;
  load: () => Promise<TcReferralsSwitchState>;
  save: (office: string, enabled: boolean) => Promise<TcReferralsSwitchState>;
}

function OfficeSwitchPanel({ config }: { config: SwitchPanelConfig }) {
  const [state, setState] = useState<TcReferralsSwitchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const noun = config.noun.toLowerCase();

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await config.load());
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not load the ${noun} switch`);
    }
  }, [config, noun]);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = async (office: string, enabled: boolean) => {
    setSaving(office);
    try {
      const next = await config.save(office, enabled);
      setState(next);
      const now = next.offices.find((o) => o.office === office);
      toast.success(`${config.noun} ${now?.enabled ? "on" : "off"} for ${OFFICE_LABELS[office] ?? office}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not save the ${noun} switch`);
      await load();
    } finally {
      setSaving(null);
    }
  };

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </span>
        <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <section className="space-y-4" data-testid={`${config.prefix}-panel`}>
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          {config.icon} {config.title}
        </h2>
        <p className="text-sm text-muted-foreground">{config.description}</p>
      </div>
      {state.controlPlaneError && (
        <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <ShieldAlert className="w-4 h-4" /> The control plane could not be read just now; what you see may be stale.
        </p>
      )}
      <div className="divide-y divide-border rounded-xl border border-border">
        {state.offices.map((o) => (
          <div key={o.office} className="flex items-center justify-between gap-3 p-3" data-testid={`${config.prefix}-office-${o.office}`}>
            <div>
              <p className="font-medium text-foreground">{OFFICE_LABELS[o.office] ?? o.office}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{SOURCE_LABELS[o.source]}</Badge>
                {o.source === "env" && !o.enabled && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {o.envVar}=false is forcing this office OFF; this switch cannot override it.
                  </span>
                )}
                {o.source === "env" && o.enabled && (
                  <span className="text-amber-700 dark:text-amber-300">
                    On through the {o.envVar}=true fallback — nobody has chosen here yet.
                  </span>
                )}
                {o.updatedBy && <span>Last changed by {o.updatedBy}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {saving === o.office && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
              <Switch
                checked={o.enabled}
                disabled={saving !== null}
                aria-label={`${config.noun} for ${OFFICE_LABELS[o.office] ?? o.office}`}
                onCheckedChange={(on) => (on ? setConfirming(o.office) : void commit(o.office, false))}
                data-testid={`${config.prefix}-switch-${o.office}`}
              />
            </div>
          </div>
        ))}
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => (open ? undefined : setConfirming(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Turn {noun} on for {confirming ? OFFICE_LABELS[confirming] ?? confirming : ""}?
            </DialogTitle>
            <DialogDescription>{config.confirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              onClick={() => {
                const office = confirming;
                setConfirming(null);
                if (office) void commit(office, true);
              }}
              data-testid={`${config.prefix}-confirm-on`}
            >
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

const REFERRALS: SwitchPanelConfig = {
  prefix: "tc-referrals",
  noun: "Referrals",
  icon: <Send className="w-4 h-4" />,
  title: "TC referrals",
  description:
    "When on, this office uses referrals: the Referrals settings (specialist directory and policies), the Referrals hub, the Referrals panel on a case, Start referral on a hygiene visit, a call and a checkout, and the doctor's Awaiting sign-off queue. Nothing is emailed unless referral email (below) is on too. Per office. The TC module must also be bought.",
  confirmDescription:
    "This office's team will see referrals wherever they appear — Settings, the hub, cases, hygiene visits, calls and checkout — and the doctor gets the sign-off queue. Nothing is emailed to a specialist unless referral email is on too, and nothing is written to Open Dental. You can turn it off again at any time, instantly.",
  load: () => api.getTcReferralsOffices(),
  save: (office, enabled) => api.setTcReferralsOfficeEnabled(office, enabled),
};

const REFERRAL_EMAIL: SwitchPanelConfig = {
  prefix: "tc-referral-email",
  noun: "Referral email",
  icon: <Mail className="w-4 h-4" />,
  title: "TC referral email",
  description:
    "When on, approved referrals can be emailed to the specialist from the Referrals hub — and, where the office chose it, sent automatically when the doctor approves. Needs referrals on, and this office's own sending address and reply-to set up. Per office.",
  confirmDescription:
    "Approved referrals in this office can then be emailed to specialists, with their letter and files. Nothing is written to Open Dental. You can turn it off again at any time, instantly.",
  load: () => api.getTcReferralEmailOffices(),
  save: (office, enabled) => api.setTcReferralEmailOfficeEnabled(office, enabled),
};

const REFERRAL_PATIENT_EMAIL: SwitchPanelConfig = {
  prefix: "tc-referral-patient-email",
  noun: "Patient referral email",
  icon: <UserRound className="w-4 h-4" />,
  title: "TC referral patient email",
  description:
    "When on, after a referral is emailed to the specialist, the patient also gets an email: who they're referred to, the specialist's phone, and an \"I've scheduled my appointment\" button. Only that email — the specialist's letter and its buttons follow the referral email switch above. The address is read from this office's Open Dental. Per office.",
  confirmDescription:
    "Patients in this office will be emailed each time one of their referrals is emailed to a specialist, at the address on file in Open Dental. Nothing is written to Open Dental. You can turn it off again at any time, instantly.",
  load: () => api.getTcReferralPatientEmailOffices(),
  save: (office, enabled) => api.setTcReferralPatientEmailOfficeEnabled(office, enabled),
};

/** The referrals switch (item 52). */
export function TcReferralsPanel() {
  return <OfficeSwitchPanel config={REFERRALS} />;
}

/** The referral email switch (R5). */
export function TcReferralEmailPanel() {
  return <OfficeSwitchPanel config={REFERRAL_EMAIL} />;
}

const OD_SYNC: SwitchPanelConfig = {
  prefix: "tc-od-sync",
  noun: "Open Dental sync",
  icon: <CalendarClock className="w-4 h-4" />,
  title: "TC Open Dental pipeline sync",
  description:
    "When on, the Pipeline's \"Sync now\" and the nightly pass read each Scheduled case's linked appointment from this office's Open Dental and act only on an unambiguous signal: Complete moves the case to Completed, Broken or Unscheduled moves it to Pending Patient, a new date or time updates the link. Anything else is flagged for a person. Every move has an Undo. Read-only — nothing is written to Open Dental. Per office.",
  confirmDescription:
    "Scheduled cases in this office with a linked appointment will follow Open Dental from the next sync: they can move to Completed or Pending Patient on their own, each with a badge and an Undo. Nothing is written to Open Dental. You can turn it off again at any time, instantly.",
  load: () => api.getTcOdSyncOffices(),
  save: (office, enabled) => api.setTcOdSyncOfficeEnabled(office, enabled),
};

/** The Open Dental pipeline sync switch (CO-4b). */
export function TcOdSyncPanel() {
  return <OfficeSwitchPanel config={OD_SYNC} />;
}

/** The referral PATIENT email switch (R5b): only the patient's email after a send. */
export function TcReferralPatientEmailPanel() {
  return <OfficeSwitchPanel config={REFERRAL_PATIENT_EMAIL} />;
}
