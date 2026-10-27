/**
 * /admin/users — who works here and what they can do (Roles PR B).
 *
 * Every rule this page appears to enforce is actually enforced by /api/users:
 * the last-admin guard, the platform-admin protection, and the self-change
 * refusal all live server-side (backend/services/tenantUsers.js). The editor
 * itself is shared with the Developer Console's per-practice People tab
 * (components/users/TenantUserEditor), so the two pages look and behave the
 * same; this page only says which door to write through.
 *
 * Adding a user here is PRE-PROVISIONING. It creates the row that says what
 * they may do; Microsoft Entra still decides whether they are who they say.
 * A row with no matching Entra account is inert, and an Entra account with no
 * row is exactly what the access-request screen is for.
 */
import { useMemo, useState } from "react";
import { RefreshCw, Users as UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TenantUserEditor, type UserDoor } from "@/components/users/TenantUserEditor";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

/** This practice's own door: /api/users, scoped server-side by the session. */
const OWN_PRACTICE_DOOR: UserDoor = {
  list: () => api.listUsers(),
  // /api/users has never taken a home office at create time; the editor is
  // told not to offer one here, so nothing new is sent.
  create: ({ email, role }) => api.createUser(email, role),
  update: (email, patch) => api.updateUser(email, patch),
};

export default function AdminUsers() {
  const auth = useAuth();
  // Bumped by Refresh; remounting the editor is its reload.
  const [generation, setGeneration] = useState(0);

  /** The tenant's sign-in domain, inferred from the signed-in admin's address. */
  const signInDomain = useMemo(() => {
    const email = auth.status === "authenticated" ? auth.user.email : "";
    const at = email.lastIndexOf("@");
    return at === -1 ? null : email.slice(at);
  }, [auth]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <UsersIcon className="h-5 w-5 text-muted-foreground" /> Users
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who works here and what they can do. Changes apply within a minute.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setGeneration((n) => n + 1)}
          className="gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      <TenantUserEditor key={generation} door={OWN_PRACTICE_DOOR} signInDomain={signInDomain} />
    </div>
  );
}
