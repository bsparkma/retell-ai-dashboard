/**
 * /tc/settings: the TC settings page's address before SC-1, now a redirect.
 *
 * Replaces history rather than pushing, so Back does not bounce someone into
 * the redirect again. A section hash is carried across; see
 * features/tc/settings/paths.ts.
 */
import { Redirect } from "wouter";
import { legacyTcSettingsRedirectTarget } from "@/features/tc/settings/paths";

export default function TcSettingsRedirect() {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  return <Redirect to={legacyTcSettingsRedirectTarget(hash)} replace />;
}
