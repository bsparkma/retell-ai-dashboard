/**
 * Admin → Offices → "RCM posting" — the shadow gate's switch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SWITCH IS
 * ─────────────────────────────────────────────────────────────────────────────
 * Roland goes live in SHADOW MODE: a biller works real EOBs end to end — upload,
 * match, confirm, review, approve — while a chart write stays impossible. This
 * is the control that ends that, per practice, and it is the only way to end it.
 * There is no env var, and there is nothing a request can send that opens a
 * practice the code ceiling has not validated.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO CONDITIONS, AND ONLY ONE OF THEM IS A TOGGLE
 * ─────────────────────────────────────────────────────────────────────────────
 * A drain needs BOTH. `postingEnabled` is D-7's code ceiling — the practice's
 * DefNums read from its own Open Dental, its key's write groups proven, its
 * end-to-end run — and it changes only in a diff. `drainEnabled` is this
 * switch. An office that fails the ceiling shows the toggle DISABLED with the
 * reason beside it, rather than offering a control that would silently not
 * work: a switch you can flip that changes nothing is worse than one you
 * cannot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADMIN ONLY, AND HIDDEN RATHER THAN DISABLED
 * ─────────────────────────────────────────────────────────────────────────────
 * `rcm.settings` is `admin` and nothing else — narrower than the `rcm.post`
 * that presses Drain. The card renders nothing at all for anyone else, because
 * the server refuses even the READ: a card that showed the state to a role that
 * cannot change it would be a status line pretending to be a control, and the
 * Posting page already tells every role what they need to know ("Shadow").
 *
 * The reason a disabled control is rendered for the CEILING and no control at
 * all for permission is that they are different answers: "this cannot be
 * switched on yet, and here is why" is information an admin acts on, while
 * "you are not an admin" is not.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import {
  getRcmOfficeSettings,
  setRcmOfficeSettings,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type RcmOfficeId,
  type RcmOfficeSettings,
} from "@/features/rcm/api";

/** When the switch was last moved, in words rather than an ISO string. */
function lastChanged(settings: RcmOfficeSettings): string {
  if (!settings.updatedAt) return "Never switched.";
  const when = new Date(settings.updatedAt);
  const stamp = Number.isNaN(when.getTime()) ? settings.updatedAt : when.toLocaleString();
  // The crosswalk KEY, not an email: it is what the audit trail carries, and
  // inventing a display name here would be a name nothing else agrees with.
  return settings.updatedBy ? `Last changed ${stamp} by ${settings.updatedBy}.` : `Last changed ${stamp}.`;
}

function OfficeRow({ office }: { office: RcmOfficeId }) {
  const [settings, setSettings] = useState<RcmOfficeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    getRcmOfficeSettings(office)
      .then((s) => {
        if (!cancelled) {
          setSettings(s);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // The server's own sentence — a tenant without the RCM module says
        // exactly that rather than this card inventing "something went wrong".
        setError(e instanceof RcmApiError ? e.message : "Could not read this practice's posting setting.");
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  useEffect(load, [load]);

  const flip = useCallback(
    async (next: boolean) => {
      setSaving(true);
      try {
        const saved = await setRcmOfficeSettings(office, next);
        setSettings(saved);
        setError(null);
        toast.success(
          next
            ? `Posting switched ON for ${RCM_OFFICE_LABELS[office]}. Draining will now write to Open Dental.`
            : `Posting switched OFF for ${RCM_OFFICE_LABELS[office]}. Approved plans will wait.`,
        );
      } catch (e: unknown) {
        // The switch did NOT move, and the screen must not pretend it did —
        // re-read rather than assuming the value we sent.
        toast.error(e instanceof RcmApiError ? e.message : "The setting could not be changed.");
        load();
      } finally {
        setSaving(false);
      }
    },
    [office, load],
  );

  if (error) {
    return (
      <div
        className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
        data-testid={`rcm-posting-setting-error-${office}`}
      >
        <span className="font-medium text-foreground">{RCM_OFFICE_LABELS[office]}</span>
        <span>{error}</span>
      </div>
    );
  }

  if (!settings) {
    return (
      <div
        className="flex items-center gap-2 p-3 text-sm text-muted-foreground"
        data-testid={`rcm-posting-setting-loading-${office}`}
      >
        <Loader2 size={14} className="animate-spin" />
        {RCM_OFFICE_LABELS[office]}
      </div>
    );
  }

  const blockedByCeiling = !settings.postingEnabled;
  const disabled = saving || blockedByCeiling || settings.rowMissing;

  return (
    <div
      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
      data-testid={`rcm-posting-setting-${office}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {settings.drainEnabled ? (
            <ShieldCheck size={16} className="text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ShieldOff size={16} className="text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">{RCM_OFFICE_LABELS[office]}</span>
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            data-testid={`rcm-posting-state-${office}`}
          >
            {settings.drainEnabled ? "Posting on" : "Shadow"}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`rcm-posting-changed-${office}`}>
          {lastChanged(settings)}
        </p>
        {/* THE REASON IS RENDERED, NOT HOVERED — §15.2, finding 4. A disabled
            control with no visible reason reads as a broken one. */}
        {blockedByCeiling && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid={`rcm-posting-ceiling-${office}`}>
            This practice has not been validated for posting yet — its own payment-type numbers
            have to be read from its own Open Dental, its key&apos;s write access proven, and a
            test-patient run completed. That is a code change, not a setting.
          </p>
        )}
        {settings.rowMissing && (
          <p className="mt-1 text-xs text-destructive" data-testid={`rcm-posting-missing-${office}`}>
            There is no posting-settings row for this practice. Run the tenant migrations; posting
            stays switched off until it exists.
          </p>
        )}

        {/*
          ── HOW THIS PRACTICE BOOKS A WRITE-OFF IT CHOSE — READ-ONLY (Stage B1)
          ────────────────────────────────────────────────────────────────────
          Shown here because it belongs beside the other posting settings and an
          admin needs to be able to READ it: it decides which Open Dental call a
          write-off becomes, and under the adjustment mode a missing type name
          refuses the claim outright.

          It is NOT editable from this card, deliberately. The endpoint exists
          and is admin-only; the control for it is a later slice's, alongside
          per-office editing of the reasons themselves. A half-built editor here
          would be a second place to change this, disagreeing with the first.
        */}
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`rcm-writeoff-mode-${office}`}>
          {settings.writeoffMode === "writeoff_field"
            ? "A write-off this practice chooses goes into the claim line's own write-off field, with a note. No adjustment type is used."
            : `A write-off this practice chooses is booked as an adjustment of type “${settings.writeoffAdjTypeName ?? "— none named —"}”, looked up by name in this practice's own Open Dental.`}
        </p>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => flip(!settings.drainEnabled)}
        data-testid={`rcm-posting-toggle-${office}`}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
          disabled
            ? "cursor-not-allowed bg-muted text-muted-foreground"
            : settings.drainEnabled
              ? "border border-border text-foreground hover:bg-muted"
              : "bg-foreground text-background hover:opacity-90"
        }`}
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        {settings.drainEnabled ? "Switch posting off" : "Switch posting on"}
      </button>
    </div>
  );
}

export default function RcmPostingSettingsCard() {
  const auth = useAuth();
  const scope = useRcmOfficeScope();

  const permissions = auth.status === "authenticated" ? auth.user.permissions : undefined;
  // Not merely "don't render" — don't ASK. Firing a request per office that we
  // know will 403 would fill the audit trail and the console with noise on
  // every visit by somebody who is not an admin.
  if (!can(permissions, "rcm.settings")) return null;
  if (scope.loading || scope.offices.length === 0) return null;

  return (
    <Card data-testid="rcm-posting-settings">
      <CardContent className="p-5">
        <div className="text-sm font-semibold text-foreground">RCM posting</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Whether draining an approved remittance may write to a practice&apos;s Open Dental. While
          this is off, billers work remittances all the way to approved and the plans wait — nothing
          reaches a chart.
        </p>
        <div className="mt-4 space-y-2">
          {scope.offices.map((office) => (
            <OfficeRow key={office} office={office} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
