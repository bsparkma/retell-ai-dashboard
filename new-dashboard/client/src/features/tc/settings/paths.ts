/**
 * Where the TC settings page lives (SC-1).
 *
 * It moved from /tc/settings to /admin/tc/settings: /admin is the practice's
 * settings hub now. The old address still works. App.tsx renders a redirect
 * there that carries a known section hash across (/tc/settings#pricing →
 * /admin/tc/settings#pricing), so bookmarks and muscle memory land where they
 * used to.
 *
 * WHO MAY OPEN IT DID NOT CHANGE. The page needed `tc.full` (inherited from the
 * `/tc` prefix) and still needs exactly that, through its own ROUTE_PERMISSIONS
 * entry, which beats `/admin`'s admin.all by the longest-prefix rule.
 */
import { TC_SETTINGS_SECTIONS, type TcSettingsSectionKey } from "./sections";

/** The page's address. */
export const TC_SETTINGS_PATH = "/admin/tc/settings";

/** Its address before SC-1. Now only a redirect. */
export const LEGACY_TC_SETTINGS_PATH = "/tc/settings";

/** A link to the page, optionally opened at one section. */
export function tcSettingsHref(section?: TcSettingsSectionKey): string {
  return section ? `${TC_SETTINGS_PATH}#${section}` : TC_SETTINGS_PATH;
}

/**
 * Where a visit to the old address goes. A hash naming a real section is
 * carried across; anything else is dropped rather than forwarded, so the
 * redirect never echoes arbitrary text into the new URL.
 */
export function legacyTcSettingsRedirectTarget(hash: string): string {
  const raw = hash.replace(/^#/, "");
  const known = TC_SETTINGS_SECTIONS.find((s) => s.key === raw);
  return tcSettingsHref(known ? known.key : undefined);
}
