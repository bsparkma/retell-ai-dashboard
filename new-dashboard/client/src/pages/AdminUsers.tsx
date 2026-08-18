/**
 * /admin/users — who works here and what they can do (Roles PR B).
 *
 * Every rule this page appears to enforce is actually enforced by /api/users:
 * the last-admin guard, the platform-admin protection, and the self-change
 * refusal all live server-side. The UI disables the controls it knows will be
 * refused so the refusal is rare, and renders the server's message when one
 * happens anyway — it never pre-empts a decision the server hasn't made.
 *
 * Adding a user here is PRE-PROVISIONING. It creates the row that says what
 * they may do; Microsoft Entra still decides whether they are who they say.
 * A row with no matching Entra account is inert, and an Entra account with no
 * row is exactly what the access-request screen is for.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UserPlus,
  Users as UsersIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import type { TenantUser, TenantUserRole, TenantUserStatus, TenantUsersResponse } from "@/lib/api";

type TenantOffice = TenantUsersResponse["offices"][number];
import { useAuth } from "@/contexts/AuthContext";

/** What each role means, in the words an office manager would use. */
const ROLE_BLURB: Record<TenantUserRole, string> = {
  admin: "Everything, including this page",
  office: "Everything except this page",
  tc: "Treatment Coordinator + read-only calls",
  hygiene: "Hygiene intake, submissions and inbox only",
  reviewer: "Read and work the RCM queue — cannot confirm a match or post",
};

const ROLE_ORDER: TenantUserRole[] = ["admin", "office", "tc", "hygiene", "reviewer"];

function formatLastLogin(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The message to show for a failed write — the server's, whenever it sent one. */
function writeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong";
}

function AddUserForm({
  roles,
  signInDomain,
  onAdded,
}: {
  roles: TenantUserRole[];
  signInDomain: string | null;
  onAdded: (user: TenantUser) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantUserRole>("office");
  const [busy, setBusy] = useState(false);

  const normalized = email.trim().toLowerCase();
  // A WARNING, not a block. Practices hire people whose address doesn't match
  // the pattern we expect, and refusing to add them would be the tool telling
  // the owner they're wrong about their own team.
  const domainMismatch =
    normalized.includes("@") && signInDomain !== null && !normalized.endsWith(signInDomain);

  const submit = async () => {
    if (!normalized) return;
    setBusy(true);
    try {
      const user = await api.createUser(normalized, role);
      onAdded(user);
      setEmail("");
      toast.success(`Added ${user.email} as ${user.role}`);
    } catch (e) {
      toast.error(writeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Add someone</h2>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <Input
            type="email"
            placeholder="name@carein.ai"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            aria-label="Email address"
            data-testid="add-user-email"
          />
          {domainMismatch && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              That isn&apos;t a {signInDomain} address — they won&apos;t be able to sign in unless
              they have an account in your Microsoft tenant.
            </p>
          )}
        </div>

        <select
          className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
          value={role}
          onChange={(e) => setRole(e.target.value as TenantUserRole)}
          aria-label="Role"
          data-testid="add-user-role"
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <Button onClick={() => void submit()} disabled={busy || !normalized} className="gap-1.5">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          Add
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        This sets what they can do. Microsoft still handles signing in — if they don&apos;t have an
        account yet, create one first.
      </p>
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  roles,
  offices,
  onChanged,
}: {
  user: TenantUser;
  isSelf: boolean;
  roles: TenantUserRole[];
  offices: TenantOffice[];
  onChanged: (user: TenantUser) => void;
}) {
  const [busy, setBusy] = useState(false);

  const patch = async (body: {
    role?: TenantUserRole;
    status?: TenantUserStatus;
    homeOffice?: string | null;
  }) => {
    setBusy(true);
    try {
      const updated = await api.updateUser(user.email, body);
      onChanged(updated);
      toast.success("Saved — takes effect within a minute", {
        description: "Roles are cached briefly, so it may take up to 60 seconds to apply.",
      });
    } catch (e) {
      toast.error(writeError(e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = user.status === "disabled";

  return (
    <tr className={disabled ? "opacity-60" : undefined} data-testid={`user-row-${user.email}`}>
      <td className="px-3 py-2.5 align-middle">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-foreground">{user.email}</span>
          {isSelf && (
            <Badge variant="secondary" className="text-[10px]">
              You
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{ROLE_BLURB[user.role]}</p>
      </td>

      <td className="px-3 py-2.5 align-middle">
        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          value={user.role}
          disabled={busy || isSelf}
          // Self-change is refused server-side; disabling it here just spares
          // the round trip and explains itself in the title.
          title={isSelf ? "You can't change your own role — ask another admin" : undefined}
          onChange={(e) => void patch({ role: e.target.value as TenantUserRole })}
          aria-label={`Role for ${user.email}`}
          data-testid={`role-select-${user.email}`}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>

      <td className="px-3 py-2.5 align-middle">
        {/* A DEFAULT for their office picker, not a restriction: every office
            stays reachable from every surface, because staff float between
            locations. Editable on your OWN row too — unlike role and status,
            this cannot lock anybody out of anything. */}
        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          value={user.homeOffice ?? ""}
          disabled={busy}
          onChange={(e) => void patch({ homeOffice: e.target.value === "" ? null : e.target.value })}
          aria-label={`Home office for ${user.email}`}
          data-testid={`home-office-${user.email}`}
        >
          {/* "None" is a real choice, not a placeholder — a shared temp login
              is meant to have no home office. */}
          <option value="">—</option>
          {offices.map((o) => (
            <option key={o.officeId} value={o.officeId}>
              {o.officeName}
            </option>
          ))}
        </select>
      </td>

      <td className="px-3 py-2.5 align-middle text-sm text-muted-foreground">
        {formatLastLogin(user.lastLoginAt)}
      </td>

      <td className="px-3 py-2.5 align-middle">
        <Badge variant={disabled ? "outline" : "secondary"} className="text-[10px]">
          {disabled ? "Disabled" : "Active"}
        </Badge>
      </td>

      <td className="px-3 py-2.5 align-middle text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || isSelf}
          title={isSelf ? "You can't deactivate your own account" : undefined}
          onClick={() => void patch({ status: disabled ? "active" : "disabled" })}
          data-testid={`toggle-${user.email}`}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : disabled ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" /> Reactivate
            </>
          ) : (
            <>
              <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Deactivate
            </>
          )}
        </Button>
      </td>
    </tr>
  );
}

export default function AdminUsers() {
  const auth = useAuth();
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [roles, setRoles] = useState<TenantUserRole[]>(ROLE_ORDER);
  // Starts EMPTY, not with a guessed pair. The office list is server config;
  // rendering a hardcoded one would quietly omit a newly-opened office.
  const [offices, setOffices] = useState<TenantOffice[]>([]);
  const [actor, setActor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** The tenant's sign-in domain, inferred from the signed-in admin's address. */
  const signInDomain = useMemo(() => {
    const email = auth.status === "authenticated" ? auth.user.email : "";
    const at = email.lastIndexOf("@");
    return at === -1 ? null : email.slice(at);
  }, [auth]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listUsers();
      setUsers(data.users);
      if (data.roles.length > 0) setRoles(data.roles);
      setOffices(data.offices ?? []);
      setActor(data.actor);
    } catch (e) {
      setUsers([]);
      setError(writeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = useCallback((updated: TenantUser) => {
    setUsers((prev) => prev.map((u) => (u.email === updated.email ? updated : u)));
  }, []);

  const add = useCallback((created: TenantUser) => {
    setUsers((prev) => [...prev, created].sort((a, b) => a.email.localeCompare(b.email)));
  }, []);

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
        <Button size="sm" variant="ghost" onClick={() => void load()} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      <div className="mb-5">
        <AddUserForm roles={roles} signInDomain={signInDomain} onAdded={add} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[42rem] text-left">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Home office</th>
                <th className="px-3 py-2 font-medium">Last signed in</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <UserRow
                  key={u.email}
                  user={u}
                  isSelf={u.email.toLowerCase() === actor.toLowerCase()}
                  roles={roles}
                  offices={offices}
                  onChanged={replace}
                />
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    Nobody here yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
