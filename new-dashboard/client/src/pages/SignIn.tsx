import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchProviders, login, loginExternal } from "@/lib/auth";

/**
 * Sign-in screen shown when there is no valid session. The button redirects to
 * the backend `/auth/login`, which starts the Microsoft Entra sign-in flow.
 * Only careindent-tenant @carein.ai accounts are accepted by the backend.
 *
 * A second button — Google or an email one-time code, via Entra External ID —
 * appears ONLY when `/auth/providers` says the server has that door switched
 * on. Until then this screen is exactly the Microsoft-only screen it always
 * was. On that door the person's app_user row is the only gate; the backend
 * says so in plain words if they have none.
 */
export default function SignIn() {
  const [redirecting, setRedirecting] = useState<"microsoft" | "external" | null>(null);
  const [externalEnabled, setExternalEnabled] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchProviders().then((p) => {
      if (live) setExternalEnabled(p.external);
    });
    return () => {
      live = false;
    };
  }, []);

  function handleSignIn() {
    setRedirecting("microsoft");
    login();
  }

  function handleExternalSignIn() {
    setRedirecting("external");
    loginExternal();
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

          <Button className="mt-6 w-full" onClick={handleSignIn} disabled={redirecting !== null}>
            {redirecting === "microsoft" ? "Redirecting…" : "Sign in with Microsoft"}
          </Button>

          {externalEnabled && (
            <>
              <div className="my-4 flex w-full items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={handleExternalSignIn}
                disabled={redirecting !== null}
                data-testid="sign-in-external"
              >
                {redirecting === "external" ? "Redirecting…" : "Sign in with Google or email code"}
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                For practice staff your administrator has added.
              </p>
            </>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            Access is restricted to the CareIN organization.
          </p>
        </div>
      </div>
    </div>
  );
}
