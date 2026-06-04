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
}

export interface AuthUser {
  name: string;
  email: string;
  tenantId: string;
  /** Resolved practice, or null if not mapped / control DB unreachable. */
  tenant: TenantInfo | null;
}

/** Narrow an unknown `tenant` object into TenantInfo (or null). No `any`. */
function parseTenant(value: unknown): TenantInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.slug === "string" && typeof t.displayName === "string") {
    return { slug: t.slug, displayName: t.displayName };
  }
  return null;
}

/** Narrow an unknown `/auth/me` body into an AuthUser (or null). No `any`. */
function parseAuthUser(value: unknown): AuthUser | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.authenticated !== true) return null;
  const user = body.user;
  if (typeof user !== "object" || user === null) return null;
  const u = user as Record<string, unknown>;
  if (typeof u.name === "string" && typeof u.email === "string" && typeof u.tenantId === "string") {
    return { name: u.name, email: u.email, tenantId: u.tenantId, tenant: parseTenant(body.tenant) };
  }
  return null;
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

/** Clear the session cookie and return to the sign-in screen. */
export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // Ignore network errors — we still drop the client state below.
  }
  window.location.reload();
}
