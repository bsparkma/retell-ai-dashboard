/**
 * CareIN dashboard auth client (Microsoft Entra SSO).
 *
 * Sign-in is handled entirely by the backend (MSAL auth-code flow). The browser
 * never sees Microsoft tokens — after a successful sign-in the backend sets an
 * HttpOnly session cookie. This module just:
 *   - asks the backend who we are (`/auth/me`, sent with credentials),
 *   - kicks off sign-in by navigating to `/auth/login`,
 *   - signs out via `/auth/logout`.
 *
 * The auth routes live at the API ORIGIN (without the trailing `/api`). We
 * derive that from VITE_API_URL, or use VITE_AUTH_BASE if explicitly set.
 */

const API_BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:5000/api").trim().replace(/\/+$/, "");
const AUTH_BASE = (
  (import.meta.env.VITE_AUTH_BASE as string | undefined)?.trim() || API_BASE.replace(/\/api$/, "")
).replace(/\/+$/, "");

/** The signed-in user's tenant (practice), from the control-plane registry. */
export interface TenantInfo {
  slug: string;
  displayName: string;
  /**
   * Enabled module ids from tenant_module ('voice' | 'rcm' | 'tc' |
   * 'scheduling'). Drives which product shells the SPA renders — UI hiding
   * only; the backend requireModule() 403 is the source of truth.
   */
  modules: string[];
}

/**
 * The signed-in user's tenant role (app_user.role), locked 2026-08-11:
 *   admin    everything, including the Admin page
 *   office   everything except the Admin page
 *   tc       TC module + read-only voice
 *   hygiene  hygiene intake/submissions/inbox only
 *
 * `null` means no role resolved — a disabled account, or the control plane was
 * unreachable when /auth/me answered.
 */
export type TenantRole = "admin" | "office" | "tc" | "hygiene";

const TENANT_ROLES: readonly string[] = ["admin", "office", "tc", "hygiene"];

export interface AuthUser {
  name: string;
  email: string;
  tenantId: string;
  /** Resolved practice, or null if not mapped / control DB unreachable. */
  tenant: TenantInfo | null;
  /** Tenant role, or null if none resolved. */
  role: TenantRole | null;
  /** Platform tier — acts as `admin` in every tenant. */
  isSuperAdmin: boolean;
  /**
   * Action names this user holds (e.g. "voice.sync", "tc.hygiene"), from the
   * server's permission map. UI HIDING ONLY — the backend 403 is the source of
   * truth, and an empty list means "hide everything" rather than "allow".
   *
   * PR A ships the type; PR B is what consumes it in the nav.
   */
  permissions: string[];
  /**
   * The office this person usually works at (app_user.home_office), or null.
   *
   * A DEFAULT, not a restriction: it seeds the office picker and nothing else.
   * Every office stays reachable, because staff float between locations (see
   * contexts/OfficeContext.tsx). Shared accounts — temp@ — deliberately have
   * none, which makes the picker their "which office are you at today?" prompt.
   */
  homeOffice: string | null;
}

/** Narrow an unknown `tenant` object into TenantInfo (or null). No `any`. */
export function parseTenant(value: unknown): TenantInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.slug === "string" && typeof t.displayName === "string") {
    // Older backends omit `modules`; anything non-string is dropped.
    const modules = Array.isArray(t.modules)
      ? t.modules.filter((m): m is string => typeof m === "string")
      : [];
    return { slug: t.slug, displayName: t.displayName, modules };
  }
  return null;
}

/** Narrow an unknown `/auth/me` body into an AuthUser (or null). No `any`. */
export function parseAuthUser(value: unknown): AuthUser | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.authenticated !== true) return null;
  const user = body.user;
  if (typeof user !== "object" || user === null) return null;
  const u = user as Record<string, unknown>;
  if (typeof u.name === "string" && typeof u.email === "string" && typeof u.tenantId === "string") {
    return {
      name: u.name,
      email: u.email,
      tenantId: u.tenantId,
      tenant: parseTenant(body.tenant),
      // A backend that predates Roles PR A sends none of these three. Absent
      // reads as "no role, no permissions" — the hiding direction, never the
      // granting one.
      role: parseRole(body.role),
      isSuperAdmin: body.isSuperAdmin === true,
      permissions: Array.isArray(body.permissions)
        ? body.permissions.filter((p): p is string => typeof p === "string")
        : [],
      // Absent (older backend) or blank reads as "no home office" — which means
      // "all offices", the widest default. Nothing is denied either way.
      homeOffice: typeof body.homeOffice === "string" && body.homeOffice !== "" ? body.homeOffice : null,
    };
  }
  return null;
}

/** Narrow an unknown `role` into TenantRole (or null). No `any`. */
export function parseRole(value: unknown): TenantRole | null {
  return typeof value === "string" && TENANT_ROLES.includes(value) ? (value as TenantRole) : null;
}

/** Returns the signed-in user, or null if the session is missing/expired. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${AUTH_BASE}/auth/me`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return parseAuthUser(data);
  } catch {
    return null;
  }
}

/** Start the Microsoft sign-in flow (full-page redirect to the backend). */
export function login(): void {
  window.location.href = `${AUTH_BASE}/auth/login`;
}

/** Clear the session cookie, then hard-redirect to the root (sign-in). */
export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // Ignore network errors — we still drop the client state below.
  }
  window.location.href = "/";
}
