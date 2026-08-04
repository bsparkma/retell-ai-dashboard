/**
 * Settings → Team. EXPLANATORY, read-only.
 *
 * Legacy DentaFlow kept its own staff roster with per-user PINs and TC-local
 * roles, because it had no identity provider. The platform signs users in
 * through Microsoft Entra SSO: there is no TC-managed roster to edit, and the
 * session does not carry roles (a known platform gap — see the report).
 *
 * So: no invented roster, no PIN editor, no role dropdowns. We show the one
 * thing we genuinely know — the signed-in user — and name where membership is
 * actually administered.
 */
import { KeyRound, UserCircle, Users } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ReadOnlyRow, RetiredNote, SettingsCard } from "./chrome";

export function TeamSection() {
  const auth = useAuth();
  const user = auth.status === "authenticated" ? auth.user : null;

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Team access"
        icon={Users}
        description="Team membership is managed in the platform, not in Treatment Coordinator. Everyone signs in with their Microsoft work account (Entra SSO), and access to this module is granted per practice by the platform's module entitlement."
      >
        <p className="text-xs text-muted-foreground leading-relaxed">
          To add or remove someone, change their Microsoft account in your
          organization's directory. There is no separate Treatment Coordinator
          roster to keep in sync — anyone who can sign in to this practice and
          has the module enabled sees the same cases.
        </p>
        <RetiredNote>
          Treatment Coordinator does not yet distinguish roles or permissions
          within a practice. Every signed-in user of this practice has the same
          access to cases, the library, and reports. Per-user roles are a known
          gap and are not simulated here.
        </RetiredNote>
      </SettingsCard>

      <SettingsCard
        title="Signed in as"
        icon={UserCircle}
        description="The only account details this module can see come from your current session."
      >
        <div className="space-y-2">
          <ReadOnlyRow label="Name" value={user?.name ?? "Not available"} />
          <ReadOnlyRow label="Email" value={user?.email ?? "Not available"} />
          <ReadOnlyRow
            label="Practice"
            value={user?.tenant?.displayName ?? "Not available"}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Staff PINs"
        icon={KeyRound}
        description="Retired."
      >
        <RetiredNote>
          The legacy per-user PIN prompt has been removed. Identity is
          established by Microsoft sign-in before the app loads, so a second
          in-app credential would add no security — it would only add something
          else to forget.
        </RetiredNote>
      </SettingsCard>
    </div>
  );
}
