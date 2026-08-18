/**
 * Client-side permission map (Roles PR B).
 *
 * ⚠️ UX ONLY. Everything here decides what to SHOW. The security boundary is
 * the server's `requirePermission` (Roles PR A) — a user who edits this bundle,
 * types a URL, or calls the API directly gains nothing. If you ever find
 * yourself weakening a server gate to make a screen easier, the screen is
 * wrong, not the gate.
 *
 * Action names mirror `backend/config/permissions.js` exactly. Divergence shows
 * up as a nav item that 403s on click, so `tests/role-nav.test.ts` asserts the
 * two lists agree.
 */

import type { TenantRole } from "@/lib/auth";

/** Every action the backend map defines. Keep sorted, keep in sync. */
export const ACTIONS = [
  "admin.all",
  "rcm.queue",
  "rcm.read",
  "rcm.write",
  "tc.full",
  "tc.hygiene",
  "voice.chart_write",
  "voice.read",
  "voice.send_to_tc",
  "voice.sync",
  "voice.transcribe",
  "voice.write",
] as const;

export type PermissionAction = (typeof ACTIONS)[number];

/** Does this user hold `action`? A super_admin holds everything. */
export function can(
  permissions: readonly string[] | undefined,
  action: PermissionAction,
): boolean {
  return Array.isArray(permissions) && permissions.includes(action);
}

/**
 * Where a role lands after sign-in, and where an unauthorized deep link sends
 * them.
 *
 * A hygienist's home is the inbox, not a dashboard they cannot read. `tc` gets
 * the TC dashboard. A `reviewer` holds exactly one surface, so sending
 * them to a module hub with one tile on it would be a click for nothing.
 * office/admin keep the module hub they have today — they may hold several
 * modules, and picking one for them would be a regression.
 */
export const ROLE_HOME: Record<TenantRole, string> = {
  admin: "/home",
  office: "/home",
  tc: "/tc/dashboard",
  hygiene: "/tc/hygiene/inbox",
  reviewer: "/rcm/remittances",
};

/** The fallback home for a user whose role we could not resolve. */
export const DEFAULT_HOME = "/home";

/**
 * The signed-in user's home route.
 *
 * A super_admin follows their TENANT role: the platform tier is about what you
 * may do, not about where you work. A super_admin whose tenant role is hygiene
 * still lands on the inbox and can navigate anywhere from there.
 */
export function homeForRole(role: TenantRole | null): string {
  return role ? ROLE_HOME[role] : DEFAULT_HOME;
}

/**
 * Route prefix → the action needed to see it.
 *
 * LONGEST PREFIX WINS, so `/tc/hygiene/inbox` is matched by the `/tc/hygiene`
 * entry rather than by the broader `/tc`. Order in this object is irrelevant;
 * `requiredActionFor` sorts by specificity.
 *
 * A route absent from this map needs no permission — that is the honest default
 * for shells and error pages (`/home`, `/404`), and it costs nothing because
 * the data behind any real page is gated server-side regardless.
 */
export const ROUTE_PERMISSIONS: Record<string, PermissionAction> = {
  "/dashboard": "voice.read",
  "/calls": "voice.read",
  "/carein-calls": "voice.read",
  "/callbacks": "voice.read",
  "/agents": "voice.read",
  "/scheduling": "voice.read",
  "/analytics": "voice.read",
  "/admin": "admin.all",
  "/tc": "tc.full",
  // The three Hygiene-nav pages are the ONLY /tc routes a hygienist may see.
  "/tc/hygiene": "tc.hygiene",
  // RCM is read-gated at the route. Its three tiers (rcm.read / rcm.queue /
  // rcm.write, decision D-9) are enforced server-side per route; a page renders
  // the same for a reviewer and an approver, and the buttons a reviewer may not
  // press refuse honestly rather than being hidden.
  "/rcm": "rcm.read",
};

/** The action a path requires, or null if it is unrestricted. */
export function requiredActionFor(path: string): PermissionAction | null {
  let best: { prefix: string; action: PermissionAction } | null = null;
  for (const [prefix, action] of Object.entries(ROUTE_PERMISSIONS)) {
    const matches = path === prefix || path.startsWith(`${prefix}/`);
    if (!matches) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, action };
  }
  return best ? best.action : null;
}

/** May this user open `path`? Unrestricted paths are always allowed. */
export function canVisit(permissions: readonly string[] | undefined, path: string): boolean {
  const action = requiredActionFor(path);
  return action === null || can(permissions, action);
}
