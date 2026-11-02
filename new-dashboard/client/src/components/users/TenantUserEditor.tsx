/**
 * The one user editor, rendered by both doors into app_user:
 *
 *   /admin/users                         a practice admin, their own practice
 *   /platform → Practices → People       a super_admin, any practice
 *
 * The page supplies a `door` (which API to call); this component owns
 * everything a person sees, so the two pages cannot drift apart. The server is
 * the guard for both — the four rules live once in
 * backend/services/tenantUsers.js. The UI disables the controls it knows will
 * be refused so the refusal is rare, and renders the server's message inline
 * when one happens anyway — it never pre-empts a decision the server hasn't
 * made.
 *
 * Adding a user is PRE-PROVISIONING. It creates the row that says what they may
 * do; Microsoft Entra still decides whether they are who they say.
 *
 * SIGNATURE ON NOTES. Each row has a collapsed panel for the name and licence a
 * hygiene note prints for that person — any role, since anyone may author a
 * note. It replaced the free-typed /admin/staff page: the sign-in the note
 * matches on is the person's own app_user email, taken by the server, so a
 * licence entered here cannot miss on a typo. The panel sends a name and a
 * licence and nothing else.
 */
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, PenLine, ShieldAlert, UserPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import type { TenantUser, TenantUserPatch, TenantUserRole, TenantUsersResponse } from "@/lib/api";
import type { UserSignatureInput, UserSignatureResponse } from "@shared/hyg/staff";

export type TenantOffice = TenantUsersResponse["offices"][number];

/** Which API a page writes through. Both doors answer with the same shapes. */
export interface UserDoor {
  list: () => Promise<TenantUsersResponse>;
  create: (input: { email: string; role: TenantUserRole; homeOffice?: string | null }) => Promise<TenantUser>;
  update: (email: string, patch: TenantUserPatch) => Promise<TenantUser>;
  /** The person's signature on notes. The server picks the sign-in and office. */
  getSignature: (email: string) => Promise<UserSignatureResponse>;
  saveSignature: (email: string, input: UserSignatureInput) => Promise<UserSignatureResponse>;
}

/** What each role means, in the words an office manager would use. */
const ROLE_BLURB: Record<TenantUserRole, string> = {
  admin: "Everything, including this page",
  office: "Everything except this page",
  tc: "Treatment Coordinator + read-only calls",
  hygiene: "Hygiene intake, submissions and inbox only",
  reviewer: "Read and work the RCM queue — cannot confirm a match or post",
  rcm_biller: "RCM end to end, except posting to a chart and the shadow-gate switch",
  doctor: "Sign off referrals — the Awaiting sign-off queue only",
};

const ROLE_ORDER: TenantUserRole[] = ["admin", "office", "tc", "hygiene", "reviewer", "rcm_biller", "doctor"];

/**
 * A short headline per server refusal code. The SERVER's message is always
 * shown after it, verbatim — this only says which rule answered, so the
 * reader knows whether to ask another admin, pick another address, or stop.
 */
const REFUSAL_HEADLINE: Record<string, string> = {
  LAST_ADMIN: "Last admin",
  SELF_ROLE_CHANGE: "That's you",
  SELF_DEACTIVATE: "That's you",
  PLATFORM_ADMIN_PROTECTED: "Platform administrator",
  USER_EXISTS: "Already added",
  USER_NOT_FOUND: "Not found",
  INVALID_EMAIL: "Check the address",
  INVALID_ROLE: "Unknown role",
  INVALID_HOME_OFFICE: "Unknown office",
  INVALID_BODY: "Check the signature",
  SIGNATURE_RETIRE_FAILED: "Signature not retired",
  SAVE_NOT_CONFIRMED: "Not confirmed",
};

/** A refusal the editor shows inline: which rule, and the server's own words. */
export interface Refusal {
  code: string | null;
  message: string;
}

function toRefusal(e: unknown): Refusal {
  if (e instanceof ApiError) return { code: e.code, message: e.message };
  return { code: null, message: e instanceof Error ? e.message : "Something went wrong" };
}

function RefusalNote({ refusal, testId }: { refusal: Refusal; testId: string }) {
  const headline = refusal.code ? REFUSAL_HEADLINE[refusal.code] : undefined;
  return (
    <p
      role="alert"
      className="mt-1.5 flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300"
      data-testid={testId}
      data-code={refusal.code ?? ""}
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>
        {headline && <strong className="font-semibold">{headline}. </strong>}
        {refusal.message}
      </span>
    </p>
  );
}

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

/**
 * Active / Disabled / Never signed in. Disabled wins: a disabled row that was
 * never used is still, first, an account that cannot sign in.
 */
function StatusChip({ user }: { user: TenantUser }) {
  if (user.status === "disabled") {
    return (
      <Badge variant="outline" className="text-[10px]" data-testid={`status-${user.email}`}>
        Disabled
      </Badge>
    );
  }
  if (user.lastLoginAt === null) {
    return (
      <Badge
        variant="outline"
        className="border-amber-300 text-[10px] text-amber-700 dark:border-amber-800 dark:text-amber-300"
        data-testid={`status-${user.email}`}
        title="Added, but they have not signed in yet"
      >
        Never signed in
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px]" data-testid={`status-${user.email}`}>
      Active
    </Badge>
  );
}

function OfficeOptions({ offices }: { offices: TenantOffice[] }) {
  return (
    <>
      {/* "None" is a real choice, not a placeholder — a shared temp login is
          meant to have no home office. */}
      <option value="">—</option>
      {offices.map((o) => (
        <option key={o.officeId} value={o.officeId}>
          {o.officeName}
        </option>
      ))}
    </>
  );
}

function AddUserForm({
  door,
  roles,
  offices,
  signInDomain,
  offerHomeOffice,
  placeholder,
  onAdded,
}: {
  door: UserDoor;
  roles: TenantUserRole[];
  offices: TenantOffice[];
  signInDomain: string | null;
  offerHomeOffice: boolean;
  placeholder: string;
  onAdded: (user: TenantUser) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantUserRole>("office");
  const [homeOffice, setHomeOffice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const normalized = email.trim().toLowerCase();
  // A WARNING, not a block. Practices hire people whose address doesn't match
  // the pattern we expect, and refusing to add them would be the tool telling
  // the owner they're wrong about their own team.
  const domainMismatch =
    normalized.includes("@") && signInDomain !== null && !normalized.endsWith(signInDomain);

  const submit = async () => {
    if (!normalized) return;
    setBusy(true);
    setRefusal(null);
    try {
      const user = await door.create(
        offerHomeOffice
          ? { email: normalized, role, homeOffice: homeOffice === "" ? null : homeOffice }
          : { email: normalized, role },
      );
      onAdded(user);
      setEmail("");
      toast.success(`Added ${user.email} as ${user.role}`);
    } catch (e) {
      const r = toRefusal(e);
      setRefusal(r);
      toast.error(r.message);
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
            placeholder={placeholder}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setRefusal(null);
            }}
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
          {refusal && <RefusalNote refusal={refusal} testId="add-user-refusal" />}
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

        {offerHomeOffice && (
          <select
            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
            value={homeOffice}
            onChange={(e) => setHomeOffice(e.target.value)}
            aria-label="Home office"
            data-testid="add-user-home-office"
          >
            <OfficeOptions offices={offices} />
          </select>
        )}

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

/**
 * "Signature on notes" for one person. Loads when opened, never before — the
 * roster itself stays one control-plane read.
 *
 * Blank licence means the name prints alone; the page never invents a
 * placeholder. Removing it (both fields blank) deactivates the stored row.
 */
function SignaturePanel({
  door,
  user,
  offices,
}: {
  door: UserDoor;
  user: TenantUser;
  offices: TenantOffice[];
}) {
  const [loaded, setLoaded] = useState<UserSignatureResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [license, setLicense] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const apply = useCallback((data: UserSignatureResponse) => {
    setLoaded(data);
    setFullName(data.signature?.fullName ?? "");
    setLicense(data.signature?.license ?? "");
  }, []);

  useEffect(() => {
    let live = true;
    door
      .getSignature(user.email)
      .then((data) => {
        if (live) apply(data);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(toRefusal(e).message);
      });
    return () => {
      live = false;
    };
  }, [door, user.email, apply]);

  const save = async (input: UserSignatureInput) => {
    setBusy(true);
    setRefusal(null);
    try {
      const data = await door.saveSignature(user.email, input);
      apply(data);
      toast.success(data.signature ? "Signature saved" : "Signature removed");
    } catch (e) {
      const r = toRefusal(e);
      setRefusal(r);
      toast.error(r.message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return <RefusalNote refusal={{ code: null, message: loadError }} testId={`signature-error-${user.email}`} />;
  }
  if (!loaded) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading signature…
      </div>
    );
  }

  const officeName = offices.find((o) => o.officeId === loaded.office)?.officeName ?? loaded.office;
  const disabled = user.status === "disabled";
  const name = fullName.replace(/\s+/g, " ").trim();
  const lic = license.trim();
  const unchanged = name === (loaded.signature?.fullName ?? "") && lic === (loaded.signature?.license ?? "");
  const orphanLicence = !name && lic !== "";

  let hint: ReactNode;
  if (disabled) hint = "This account is disabled, so nothing prints for it.";
  else if (orphanLicence) hint = "Enter the name this licence belongs to.";
  else if (name) {
    hint = (
      <>
        Prints as <span className="font-medium text-foreground">{name}</span>
        {lic ? <> with licence #{lic}</> : <> — no licence on file, so the name prints alone</>}.
      </>
    );
  } else hint = "Nothing set — notes print the name they signed in with.";

  return (
    <div className="space-y-2 py-1" data-testid={`signature-panel-${user.email}`}>
      <p className="text-xs text-muted-foreground">
        For {officeName} notes written while signed in as <span className="font-mono">{user.email}</span>.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          className="sm:max-w-xs"
          placeholder="Full name, as it prints"
          value={fullName}
          disabled={busy || disabled}
          onChange={(e) => {
            setFullName(e.target.value);
            setRefusal(null);
          }}
          aria-label={`Prints on notes as, for ${user.email}`}
          data-testid={`signature-name-${user.email}`}
        />
        <Input
          className="sm:max-w-[10rem]"
          placeholder="Licence # (optional)"
          value={license}
          disabled={busy || disabled}
          onChange={(e) => {
            setLicense(e.target.value);
            setRefusal(null);
          }}
          aria-label={`Licence number for ${user.email}`}
          data-testid={`signature-license-${user.email}`}
        />
        <Button
          size="sm"
          disabled={busy || disabled || unchanged || orphanLicence}
          onClick={() => void save({ fullName: name || null, license: lic || null })}
          data-testid={`signature-save-${user.email}`}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
        {loaded.signature && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => void save({ fullName: null, license: null })}
            data-testid={`signature-remove-${user.email}`}
          >
            Remove
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid={`signature-hint-${user.email}`}>
        {hint}
      </p>
      {refusal && <RefusalNote refusal={refusal} testId={`signature-refusal-${user.email}`} />}
    </div>
  );
}

function UserRow({
  door,
  user,
  isSelf,
  roles,
  offices,
  onChanged,
}: {
  door: UserDoor;
  user: TenantUser;
  isSelf: boolean;
  roles: TenantUserRole[];
  offices: TenantOffice[];
  onChanged: (user: TenantUser) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Collapsed by default; opening it is what loads the signature.
  const [signatureOpen, setSignatureOpen] = useState(false);

  const patch = async (body: TenantUserPatch) => {
    setBusy(true);
    setRefusal(null);
    try {
      const updated = await door.update(user.email, body);
      onChanged(updated);
      toast.success("Saved — takes effect within a minute", {
        description: "Roles are cached briefly, so it may take up to 60 seconds to apply.",
      });
    } catch (e) {
      const r = toRefusal(e);
      setRefusal(r);
      toast.error(r.message);
    } finally {
      setBusy(false);
    }
  };

  const disabled = user.status === "disabled";

  return (
    <Fragment>
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
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={signatureOpen}
          onClick={() => setSignatureOpen((v) => !v)}
          data-testid={`signature-toggle-${user.email}`}
        >
          {signatureOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <PenLine className="h-3 w-3" /> Signature on notes
        </button>
        {refusal && <RefusalNote refusal={refusal} testId={`refusal-${user.email}`} />}
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
          <OfficeOptions offices={offices} />
        </select>
      </td>

      <td className="px-3 py-2.5 align-middle text-sm text-muted-foreground">
        {formatLastLogin(user.lastLoginAt)}
      </td>

      <td className="px-3 py-2.5 align-middle">
        <StatusChip user={user} />
      </td>

      <td className="px-3 py-2.5 align-middle text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || isSelf}
          title={isSelf ? "You can't disable your own account" : undefined}
          onClick={() => void patch({ status: disabled ? "active" : "disabled" })}
          data-testid={`toggle-${user.email}`}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : disabled ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" /> Re-enable
            </>
          ) : (
            <>
              <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Disable
            </>
          )}
        </Button>
      </td>
    </tr>
    {signatureOpen && (
      <tr className="bg-muted/30" data-testid={`signature-row-${user.email}`}>
        <td colSpan={6} className="px-3 pb-3 pt-1">
          <SignaturePanel door={door} user={user} offices={offices} />
        </td>
      </tr>
    )}
    </Fragment>
  );
}

/**
 * The whole editor: add form, roster, loading and error states. Remount it
 * (change its `key`) to reload.
 */
export function TenantUserEditor({
  door,
  signInDomain = null,
  offerHomeOfficeOnAdd = false,
  placeholder = "name@carein.ai",
  emptyText = "Nobody here yet.",
}: {
  door: UserDoor;
  /** Warn (never block) on an address outside this domain. null = no warning. */
  signInDomain?: string | null;
  /** Offer a home office in the add form — only where the door accepts one. */
  offerHomeOfficeOnAdd?: boolean;
  placeholder?: string;
  emptyText?: string;
}) {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [roles, setRoles] = useState<TenantUserRole[]>(ROLE_ORDER);
  // Starts EMPTY, not with a guessed pair. The office list is server config;
  // rendering a hardcoded one would quietly omit a newly-opened office.
  const [offices, setOffices] = useState<TenantOffice[]>([]);
  const [actor, setActor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await door.list();
      setUsers(data.users);
      if (data.roles.length > 0) setRoles(data.roles);
      setOffices(data.offices ?? []);
      setActor(data.actor);
    } catch (e) {
      setUsers([]);
      setError(toRefusal(e).message);
    } finally {
      setLoading(false);
    }
  }, [door]);

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
    <>
      <div className="mb-5">
        <AddUserForm
          door={door}
          roles={roles}
          offices={offices}
          signInDomain={signInDomain}
          offerHomeOffice={offerHomeOfficeOnAdd}
          placeholder={placeholder}
          onAdded={add}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : error ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          data-testid="users-error"
        >
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
                  door={door}
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
                    {emptyText}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
