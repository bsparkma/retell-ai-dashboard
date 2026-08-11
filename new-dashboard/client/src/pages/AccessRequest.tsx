/**
 * The dead-end for a signed-in user who holds nothing (Roles PR B).
 *
 * Two ways to land here, and they look the same to the person:
 *   - their `app_user` row is `disabled`;
 *   - they have no row at all and `ROLES_BOOTSTRAP_FALLBACK=off` (the lockdown).
 *
 * Deliberately inert: no nav, no data fetches, no retry loop. Every API call
 * this user could make would 403, so making them would only produce noise in
 * the logs and a spinner that never resolves. The screen's whole job is to be
 * honest about the situation and give the admin something to act on.
 *
 * The signed-in address is shown BECAUSE it is the thing the admin needs: the
 * usual cause is a roster typo, and "add raegan@carein.ai" is actionable in a
 * way that "Raegan can't get in" is not.
 */
import { ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/auth";

export default function AccessRequest({ email }: { email: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <ShieldQuestion className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        </div>

        <h1 className="text-xl font-semibold text-foreground">Your account isn&apos;t set up yet</h1>

        <p className="mt-3 text-sm text-muted-foreground">
          You&apos;re signed in, but nobody has given this account access to the practice yet. Ask
          an admin to add you.
        </p>

        <div className="mt-5 rounded-lg bg-muted/60 px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Signed in as
          </p>
          <p className="mt-0.5 break-all font-mono text-sm text-foreground" data-testid="access-request-email">
            {email}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Send them this address — it&apos;s what they need to add.
          </p>
        </div>

        <Button variant="outline" className="mt-6 w-full" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
