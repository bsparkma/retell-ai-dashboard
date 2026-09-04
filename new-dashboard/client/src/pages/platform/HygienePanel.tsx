/**
 * The hygiene pilot switch: is hygiene live at this OFFICE, right now.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PANEL EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Until this slice the switch was a hardcoded `false` in backend source. Turning
 * hygiene on for Roland meant a deploy — and so did turning it OFF. Pilot
 * morning, a hygienist hits a problem at 9am with a patient in the chair;
 * switching that office off has to take under a minute and it has to be a click.
 *
 * **A kill switch that requires a deploy is not a kill switch.** Everything
 * below is shaped around making the OFF direction the fast one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO AXES, AND THEY MUST NOT BE CONFUSABLE
 * ─────────────────────────────────────────────────────────────────────────────
 *   Module entitlement (Practices tab) — did this PRACTICE buy hygiene?
 *                                        One answer per tenant.
 *   This switch                        — is hygiene live at this LOCATION?
 *                                        One answer per office inside it.
 *
 * Both must be on before a hygienist can load a day. They are shown together,
 * on separate rows, with the entitlement READ-ONLY here and a pointer to where
 * it is actually changed — because a second place to flip entitlement is a
 * second place for that decision to be made by accident.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HONEST STATEMENTS THIS PANEL IS BUILT AROUND
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. WHICH LAYER answered. "Off because somebody turned it off", "off because
 *      an app setting says so", and "off because nobody has ever chosen" are
 *      three different facts, and the operator is about to act on the difference.
 *   2. WHEN THEY DISAGREE, say WHICH ONE IS IN FORCE. The app-setting override
 *      is one-directional: `HYG_OD_ENABLED_ROLAND=false` kills the office
 *      whatever this console says, and `=true` cannot turn anything on. Those
 *      two read in opposite directions, so they get different sentences — the
 *      one thing an operator must not have to work out at 2am.
 *   3. ON IS NOT THE SAME AS WORKING. An office can be switched on and still
 *      refuse every request because Open Dental is not configured for it. A
 *      green toggle over a 503 is the thing this panel must never show.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, ShieldAlert, Sparkles, Stethoscope } from "lucide-react";

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
import type { HygOfficeSwitch, HygSwitchState, Practice } from "@/lib/api";
import { loadError } from "../Platform";

/** Where the module entitlement is actually changed. */
const ENTITLEMENT_HOME = "the Practices tab";

/**
 * The sentence explaining an office's effective value.
 *
 * Each branch names the layer AND what would change it, because "where does
 * this value come from" and "what do I do about it" are the same question when
 * somebody is standing over an incident.
 */
export function sourceBlurb(office: HygOfficeSwitch, setting: HygSwitchState["setting"]): string {
  if (office.source === "db") {
    // An office ABSENT from the stored row reads as off, exactly like one set
    // to false. Describing it as "turned off by somebody on Tuesday" would put
    // a person's name on a decision nobody made — which is the whole class of
    // thing this panel exists not to do.
    if (!office.inRow) {
      return "The stored setting does not name this office, so hygiene is off here.";
    }
    const who = setting.updatedBy ?? "a platform administrator";
    const when = setting.updatedAt
      ? new Date(setting.updatedAt).toLocaleDateString()
      : "an earlier date";
    return office.db
      ? `Turned on by ${who} on ${when}.`
      : `Turned off by ${who} on ${when}.`;
  }
  if (office.source === "env") {
    // The ONLY way an app setting answers is by switching an office off; a
    // `=true` never reaches here. See the notices below for the rest of it.
    return `The ${office.envVar} app setting is off, which holds hygiene off here.`;
  }
  return "Nobody has chosen from this console, so hygiene is off by default.";
}

/**
 * The confirm dialog for turning an office ON.
 *
 * ONLY for ON. Turning off needs no confirmation — the safe direction is the
 * fast one, and a dialog in front of a kill switch is a dialog somebody reads
 * while a patient waits.
 */
function TurnOnDialog({
  office,
  busy,
  onCancel,
  onConfirm,
}: {
  office: HygOfficeSwitch | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={office !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="hyg-confirm">
        {office && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Turn hygiene on for {office.officeName}?
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2" data-testid="hyg-confirm-blast-radius">
                  <p>
                    Hygienists at <strong>{office.officeName}</strong> will start reading{" "}
                    <strong>real patient data</strong> from that practice&apos;s Open Dental —
                    names, medical alerts and premedication flags on today&apos;s schedule — on
                    their next request.
                  </p>
                  <p>
                    The morning warm will also begin running against that practice, pre-fetching
                    every patient on the day before the office opens. Both stop the moment you
                    turn this back off; turning off takes effect on the very next request and
                    needs no confirmation.
                  </p>
                  {office.blockedBy && (
                    <p className="text-amber-700 dark:text-amber-400">
                      Note: Open Dental is not usable for this office yet ({office.blockedBy.message}),
                      so turning this on will not make the day view work until that is fixed.
                    </p>
                  )}
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={busy} data-testid="hyg-confirm-accept">
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Turn on for {office.officeName}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function HygienePanel({ practices }: { practices: Practice[] | null }) {
  const [state, setState] = useState<HygSwitchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingOn, setPendingOn] = useState<HygOfficeSwitch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.getHygOffices());
      setError(null);
    } catch (e) {
      setError(loadError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Commit a flip. The response IS the new state, read back from the database —
   * never the value we sent, so a write that silently did nothing cannot look
   * like a success.
   */
  const commit = async (office: HygOfficeSwitch, enabled: boolean) => {
    setBusy(office.officeKey);
    try {
      setState(await api.setHygOfficeEnabled(office.officeKey, enabled));
      toast.success(
        enabled
          ? `Hygiene is on for ${office.officeName}`
          : `Hygiene is off for ${office.officeName}`,
      );
      setPendingOn(null);
    } catch (e) {
      toast.error(loadError(e));
      // Re-read rather than leaving the toggle where the click put it: the UI
      // must show the database, not an optimistic guess about it.
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (error && state === null) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (state === null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the hygiene switch…
      </div>
    );
  }

  const entitled = (practices ?? []).map((p) => ({
    practice: p,
    hyg: p.modules.find((m) => m.module === "hyg"),
  }));

  return (
    <div className="space-y-4" data-testid="hygiene-panel">
      {state.controlPlaneError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The control plane could not be read, so the switches below may be out of date:{" "}
            {state.controlPlaneError}
          </span>
        </div>
      )}

      {!state.setting.policyKnown && (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="hyg-policy-unknown"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The hygiene switch has never been readable since this server started, so{" "}
            <strong>every office is off</strong>. Nothing is being guessed — turning an office on
            here will fail until the control plane is reachable.
          </span>
        </div>
      )}

      {/* --- entitlement, read-only, as the OTHER axis --- */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            Did the practice buy hygiene?
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          The <code className="text-[11px]">hyg</code> module entitlement, per practice. This is a{" "}
          <strong>different question</strong> from the per-office switch below, and both must be
          on. Change it on {ENTITLEMENT_HOME}.
        </p>
        <div className="mt-3 space-y-1.5" data-testid="hyg-entitlements">
          {entitled.length === 0 && (
            <p className="text-xs text-muted-foreground">No practices loaded.</p>
          )}
          {entitled.map(({ practice, hyg }) => (
            <div
              key={practice.tenantId}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2"
            >
              <span className="text-sm text-foreground">{practice.displayName}</span>
              <Badge
                variant={hyg?.enabled ? "default" : "outline"}
                className="text-[11px]"
                data-testid={`hyg-entitlement-${practice.slug}`}
              >
                {hyg?.enabled ? "entitled" : "not entitled"}
              </Badge>
            </div>
          ))}
        </div>
      </section>

      {/* --- the per-office switch --- */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Is hygiene live at this office?</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Per office, and it takes effect on the very next request — no deploy, no restart. Turning
          an office <strong>off</strong> is immediate and needs no confirmation.
        </p>

        <div className="mt-3 space-y-2">
          {state.offices.map((office) => (
            <div
              key={office.officeKey}
              className="rounded-lg border border-border/70 px-3 py-2.5"
              data-testid={`hyg-office-${office.officeKey}`}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{office.officeName}</span>
                    <code className="text-[11px] text-muted-foreground">{office.officeKey}</code>
                    <Badge
                      variant="outline"
                      className="text-[11px]"
                      data-testid={`hyg-source-${office.officeKey}`}
                    >
                      {office.source}
                    </Badge>
                  </div>
                  <p
                    className="mt-0.5 text-xs text-muted-foreground"
                    data-testid={`hyg-blurb-${office.officeKey}`}
                  >
                    {sourceBlurb(office, state.setting)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {busy === office.officeKey && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  )}
                  <Switch
                    checked={office.enabled}
                    // ON opens the dialog and does not move the toggle; OFF
                    // commits straight away. The safe direction is the fast one.
                    onCheckedChange={(next) => {
                      if (next) setPendingOn(office);
                      else void commit(office, false);
                    }}
                    disabled={busy !== null}
                    aria-label={`Hygiene at ${office.officeName}`}
                    data-testid={`hyg-switch-${office.officeKey}`}
                  />
                </div>
              </div>

              {/* On, and still not working. The single most misleading state
                  this panel could render silently. */}
              {office.enabled && office.blockedBy && (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                  data-testid={`hyg-blocked-${office.officeKey}`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Switched on, but this office still cannot serve a day:{" "}
                    {office.blockedBy.message} ({office.blockedBy.code}).
                  </span>
                </p>
              )}

              {/* An app setting is holding this office off. It OVERRIDES this
                  console, so the toggle here cannot fix it, and somebody has to
                  be told where the real switch is before they keep clicking. */}
              {office.envEffect === "disables" && (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                  data-testid={`hyg-env-disables-${office.officeKey}`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <code>{office.envVar}</code> is set to <code>false</code>, which holds this
                    office <strong>off</strong> whatever this console says
                    {office.disagreesWithEnv && office.db ? " — and this console says on" : ""}.
                    Break-glass only ever turns an office off. Clear that app setting and restart
                    before the switch here can turn it back on.
                  </span>
                </p>
              )}

              {/* An app setting somebody set expecting an effect, that can never
                  have one. Silence here is the worse failure: they would be left
                  watching the module stay dark with no explanation anywhere. */}
              {office.envEffect === "inert" && (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                  data-testid={`hyg-env-inert-${office.officeKey}`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <code>{office.envVar}</code> is set to <code>true</code> and it is doing
                    nothing: an app setting can only turn an office <strong>off</strong>, never
                    on. Hygiene is {office.enabled ? "on here because this console says so" : "off here"}
                    . Use the switch on this page.
                  </span>
                </p>
              )}

              {/* An env var that is set to something that is not a boolean. It
                  did nothing, and silence would look like it had worked. */}
              {office.env === null && office.envRaw !== null && (
                <p
                  className="mt-2 text-xs text-amber-700 dark:text-amber-400"
                  data-testid={`hyg-env-unparseable-${office.officeKey}`}
                >
                  <code>{office.envVar}</code> is set to{" "}
                  <code>{office.envRaw}</code>, which is neither <code>true</code> nor{" "}
                  <code>false</code>, so it is being ignored.
                </p>
              )}
            </div>
          ))}
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          Stored as one row, <code>{state.setting.settingKey}</code>, so a change touching two
          offices cannot half-apply. Every flip is audited in both directions.
        </p>
      </section>

      <TurnOnDialog
        office={pendingOn}
        busy={busy !== null}
        onCancel={() => setPendingOn(null)}
        onConfirm={() => pendingOn && void commit(pendingOn, true)}
      />
    </div>
  );
}
