/**
 * Settings → Email identity (R5c).
 *
 * What every email from this office says about who sent it: the reply-to
 * address, the practice name it signs with, and the practice phone. ONE
 * identity per office, used by patient emails and referral letters alike.
 *
 *   - A value saved here beats the app setting; an empty box clears the saved
 *     value and the app setting (if there is one) applies again.
 *   - The From address is shown, never editable: it is tied to the verified
 *     sending domain and the platform manages it.
 *   - (R6.3) "Send a copy to (BCC)": an optional inbox every referral letter
 *     is blind-copied to. Saved here only (no app-setting fallback); empty =
 *     no copy.
 *
 * Shown to admin and office (tc.notification_defaults); the server enforces
 * the same. Every value shown is the server's answer after the save, never
 * what was typed.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Lock, Mail, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tcErrorMessage } from "@/features/tc/api";
import { getEmailIdentity, saveEmailIdentity } from "@/features/tc/emailIdentity/emailIdentityApi";
import {
  EMAIL_IDENTITY_LIMITS,
  TC_EMAIL_IDENTITY_FIELD_LABELS,
  TcEmailIdentityField,
  type TcEmailIdentityFieldState,
  type TcEmailIdentityResponse,
} from "@shared/tc/emailIdentity";
import type { OfficeId } from "@shared/tc/contract";

const FIELDS = TcEmailIdentityField.options;

/** The three identity fields plus (R6.3) the referral copy inbox. */
type Drafts = Record<TcEmailIdentityField, string> & { referralBcc: string };

const BCC_ID = "tc-email-identity-referralBcc";

const HINTS: Record<TcEmailIdentityField, string> = {
  replyTo: "Where a reply lands. Referral letters need one: the specialist replies with findings.",
  practiceName: "The name emails sign with, e.g. in the footer and a referral letter's signature.",
  practicePhone: "Shown in the footer and wherever a template says {{practice.phone}}.",
};

function draftsOf(state: TcEmailIdentityResponse): Drafts {
  return {
    replyTo: state.fields.replyTo.stored ?? "",
    practiceName: state.fields.practiceName.stored ?? "",
    practicePhone: state.fields.practicePhone.stored ?? "",
    referralBcc: state.referralBcc ?? "",
  };
}

function inUseLine(f: TcEmailIdentityFieldState): string {
  if (f.source === "stored") return `In use: ${f.value} (saved here)`;
  if (f.source === "env") return `In use: ${f.value} (from the app setting ${f.fallbackSetting})`;
  return "Not set";
}

export function EmailIdentitySection({ office }: { office: OfficeId }) {
  const [state, setState] = useState<TcEmailIdentityResponse | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await getEmailIdentity(office);
      setState(next);
      setDrafts(draftsOf(next));
    } catch (e) {
      setError(tcErrorMessage(e));
    }
  }, [office]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!drafts) return;
    const value = (s: string) => (s.trim() === "" ? null : s.trim());
    setSaving(true);
    try {
      const next = await saveEmailIdentity(office, {
        replyTo: value(drafts.replyTo),
        practiceName: value(drafts.practiceName),
        practicePhone: value(drafts.practicePhone),
        referralBcc: value(drafts.referralBcc),
      });
      setState(next);
      setDrafts(draftsOf(next));
      toast.success("Saved");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
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
  if (!state || !drafts) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
        <span className="text-sm">Loading email identity…</span>
      </div>
    );
  }

  const savedBcc = state.referralBcc ?? "";
  const dirty =
    FIELDS.some((f) => drafts[f].trim() !== (state.fields[f].stored ?? "")) || drafts.referralBcc.trim() !== savedBcc;

  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-sm space-y-4" data-testid="tc-email-identity-section">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Mail className="w-4 h-4" aria-hidden /> Email identity
        </h2>
        <p className="text-sm text-muted-foreground">
          How every email from this office presents itself, patient emails and referral letters alike. A value saved
          here replaces the app setting. Leave a box empty to use the app setting instead.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1" data-testid="tc-email-identity-from">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Lock className="w-3.5 h-3.5" aria-hidden /> From address
        </p>
        <p className="text-sm text-foreground break-all" data-testid="tc-email-identity-from-patient">
          {state.from.patientEmail ?? "Not set up yet"}
        </p>
        {state.from.referral !== state.from.patientEmail ? (
          <p className="text-xs text-muted-foreground break-all" data-testid="tc-email-identity-from-referral">
            Referral letters: {state.from.referral ?? "no sending address for this office yet"}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Managed by the platform: it is tied to the verified sending domain, so it can't be changed here.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        {FIELDS.map((f) => {
          const id = `tc-email-identity-${f}`;
          return (
            <div key={f} className="space-y-1">
              <Label htmlFor={id}>{TC_EMAIL_IDENTITY_FIELD_LABELS[f]}</Label>
              <Input
                id={id}
                data-testid={id}
                type={f === "replyTo" ? "email" : f === "practicePhone" ? "tel" : "text"}
                value={drafts[f]}
                maxLength={EMAIL_IDENTITY_LIMITS[f]}
                placeholder={state.fields[f].fallback ?? ""}
                disabled={saving}
                onChange={(ev) => setDrafts({ ...drafts, [f]: ev.target.value })}
              />
              <p className="text-xs text-muted-foreground">{HINTS[f]}</p>
              <p className="text-xs text-foreground break-all" data-testid={`${id}-in-use`}>
                {inUseLine(state.fields[f])}
              </p>
            </div>
          );
        })}
        {/* R6.3: the referral copy inbox. Saved here or not at all — no app-setting fallback. */}
        <div className="space-y-1 border-t border-border pt-4">
          <Label htmlFor={BCC_ID}>Send a copy to (BCC)</Label>
          <Input
            id={BCC_ID}
            data-testid={BCC_ID}
            type="email"
            value={drafts.referralBcc}
            maxLength={EMAIL_IDENTITY_LIMITS.referralBcc}
            placeholder="Optional"
            disabled={saving}
            onChange={(ev) => setDrafts({ ...drafts, referralBcc: ev.target.value })}
          />
          <p className="text-xs text-muted-foreground" data-testid={`${BCC_ID}-hint`}>
            Every referral letter from this office is blind-copied here; the specialist never sees it. Use a mailbox the
            practice controls, such as a shared office inbox, not a personal address. Leave it empty for no copy.
          </p>
          <p className="text-xs text-foreground break-all" data-testid={`${BCC_ID}-in-use`}>
            {state.referralBcc ? `In use: ${state.referralBcc}` : "No copy is sent"}
          </p>
        </div>
        <Button type="submit" size="sm" disabled={saving || !dirty} data-testid="tc-email-identity-save">
          {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden /> : null}
          Save
        </Button>
        {!state.policyKnown ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            The saved values could not be read just now, so the app settings are being used. Retry in a minute.
          </p>
        ) : null}
      </form>
    </div>
  );
}
