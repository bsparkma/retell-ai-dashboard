import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { login } from "@/lib/auth";

/**
 * Sign-in screen shown when there is no valid session. The button redirects to
 * the backend `/auth/login`, which starts the Microsoft Entra sign-in flow.
 * Only careindent-tenant @carein.ai accounts are accepted by the backend.
 */
export default function SignIn() {
  const [redirecting, setRedirecting] = useState(false);

  function handleSignIn() {
    setRedirecting(true);
    login();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">CareIN Dashboard</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in with your <span className="font-medium">carein.ai</span> Microsoft account to
            continue.
          </p>

          <Button className="mt-6 w-full" onClick={handleSignIn} disabled={redirecting}>
            {redirecting ? "Redirecting…" : "Sign in with Microsoft"}
          </Button>

          <p className="mt-4 text-xs text-muted-foreground">
            Access is restricted to the CareIN organization.
          </p>
        </div>
      </div>
    </div>
  );
}
