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
  "fees.read",
  "fees.write",
  "hyg.read",
  "hyg.write",
  "rcm.post",
  "rcm.queue",
  "rcm.read",
  "rcm.settings",
  "rcm.write",
  "tc.full",
  "tc.hygiene",
  "tc.notification_defaults",
  "tc.referral_signoff",
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
 * them to a module hub with one tile on it would be a click for nothing — and
 * an `rcm_biller` holds the same one surface, wider inside it, so she lands on
 * the same screen for the same reason.
 * office/admin keep the module hub they have today — they may hold several
 * modules, and picking one for them would be a regression.
 */
export const ROLE_HOME: Record<TenantRole, string> = {
  admin: "/home",
  office: "/home",
  tc: "/tc/dashboard",
  // The hygiene module's own day view, as of H1 slice 2. It used to be the TC
  // hygiene inbox, which was the best available landing page when /hyg did not
  // exist; a hygienist signing in now lands on today's schedule, which is the
  // screen she opens the app to look at.
  hygiene: "/hyg/day",
  reviewer: "/rcm/remittances",
  rcm_biller: "/rcm/remittances",
  // Item 53: a doctor holds exactly one surface, the referral sign-off queue —
  // since the sign-off-in-hub slice, the Referrals hub's sign-off view.
  doctor: "/tc/referrals?view=signoff",
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
 * LONGEST PREFIX WINS, so `/tc/inbox` is matched by its own entry rather than
 * by the broader `/tc`. Order in this object is irrelevant;
 * `requiredActionFor` sorts by specificity.
 *
 * A route absent from this map needs no permission — that is the honest default
 * for shells and error pages (`/home`, `/404`), and it costs nothing because
 * the data behind any real page is gated server-side regardless.
 */
export const ROUTE_PERMISSIONS: Record<string, PermissionAction | readonly PermissionAction[]> = {
  "/dashboard": "voice.read",
  "/calls": "voice.read",
  "/carein-calls": "voice.read",
  "/callbacks": "voice.read",
  "/agents": "voice.read",
  "/scheduling": "voice.read",
  "/analytics": "voice.read",
  "/admin": "admin.all",
  "/tc": "tc.full",
  // The TC Inbox: the ONE /tc page a hygienist may see (read-only — Claim and
  // the case page are tc.full). It moved here from /tc/hygiene/inbox in CO-2
  // with the same grant, so who can open it did not change.
  "/tc/inbox": "tc.hygiene",
  // CO-2: the old Hygiene pages' addresses, now only redirects (App.tsx). Kept
  // on the same grant so a hygienist's bookmark still resolves to a redirect
  // instead of bouncing home before it gets there.
  "/tc/hygiene": "tc.hygiene",
  // The Referrals hub: tc.full for the hub itself, OR tc.referral_signoff for
  // its sign-off view — the doctor's whole TC surface (item 53, moved into the
  // hub). Longest prefix wins, so this beats "/tc" (tc.full) for the hub and
  // for the old /tc/referrals/signoff path, which now only redirects here.
  // Which view, and which buttons, a person gets is the page's decision; every
  // route behind it keeps its own server gate.
  "/tc/referrals": ["tc.full", "tc.referral_signoff"],
  // RCM is read-gated at the route. Its tiers (rcm.read / rcm.queue / rcm.write,
  // decision D-9, plus rcm.post and rcm.settings from the shadow gate) are
  // enforced server-side per route; a page renders the same for a reviewer, a
  // biller and an approver, and the buttons a role may not press refuse
  // honestly rather than being hidden.
  "/rcm": "rcm.read",
  // Hygiene. Read-gated at the route; the module has no mutation yet, and
  // when slice 2 adds one it demands hyg.write server-side at the mount.
  // A page renders the same for everyone who can open it.
  "/hyg": "hyg.read",
  // Fee schedules. Read-gated at the route, which covers the import list and
  // every import's preview. The UPLOAD demands fees.write server-side at the
  // mount (requireReadWrite applies by HTTP method), so a reader who cannot
  // import still opens the same page and is refused by the server if they try —
  // the same shape RCM uses, and for the same reason: a button that is hidden
  // teaches nobody why they cannot press it.
  "/fees": "fees.read",
};

/**
 * The action a path requires — or, where a page serves two roles, the actions
 * any ONE of which opens it — or null if it is unrestricted. A query string is
 * not part of the path ("/tc/referrals?view=signoff" is "/tc/referrals").
 */
export function requiredActionFor(path: string): PermissionAction | readonly PermissionAction[] | null {
  const pathname = path.split("?")[0] ?? path;
  let best: { prefix: string; action: PermissionAction | readonly PermissionAction[] } | null = null;
  for (const [prefix, action] of Object.entries(ROUTE_PERMISSIONS)) {
    const matches = pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (!matches) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, action };
  }
  return best ? best.action : null;
}

/** May this user open `path`? Unrestricted paths are always allowed. */
export function canVisit(permissions: readonly string[] | undefined, path: string): boolean {
  const action = requiredActionFor(path);
  if (action === null) return true;
  return typeof action === "string" ? can(permissions, action) : action.some((a) => can(permissions, a));
}
