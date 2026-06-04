import { type ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import SignIn from "@/pages/SignIn";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Gates the app behind a valid Entra SSO session (state from AuthProvider).
 * While checking it shows a spinner; if there is no session it renders the
 * sign-in screen; otherwise it renders the protected app.
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

  return <>{children}</>;
}
