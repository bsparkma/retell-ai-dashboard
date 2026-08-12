import { type ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import SignIn from "@/pages/SignIn";
import AccessRequest from "@/pages/AccessRequest";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Gates the app behind a valid Entra SSO session (state from AuthProvider).
 * While checking it shows a spinner; if there is no session it renders the
 * sign-in screen; otherwise it renders the protected app.
 *
 * Roles PR B adds a third outcome between those two: a valid session that holds
 * NO role. That is not anonymity — signing in again would land in exactly the
 * same place — so it gets its own screen rather than a sign-in loop.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const state = useAuth();

  if (state.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (state.status === "anonymous") {
    return <SignIn />;
  }

  // No tenant role and not a platform admin → nothing in the app is reachable.
  // Short-circuit HERE, above the layout, so no page mounts and no request is
  // fired that would only 403.
  if (state.user.role === null && !state.user.isSuperAdmin) {
    return <AccessRequest email={state.user.email} />;
  }

  return <>{children}</>;
}
