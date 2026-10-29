/**
 * `/tc/referrals/signoff` — A ROUTE THAT OUTLIVED ITS PAGE.
 *
 * Sign-off moved into the Referrals hub (Beau's ruling), so the separate
 * "Awaiting sign-off" page is gone. The PATH stays: it was the doctor's home,
 * every sign-off alert sent before this change links to it, and it is in
 * bookmarks. So it redirects to the hub's sign-off view, carrying the alert's
 * `?office=&referral=` across so the doctor lands ON that referral. The office
 * is not trusted here — the sign-off view opens it only for an office in the
 * viewer's scope, as the old page did (F5).
 *
 * `replace`, not a push: a pushed redirect leaves the dead path in history and
 * Back bounces forward again (see pages/rcm/BringInRedirect).
 */
import { Redirect, useSearch } from "wouter";

import { signoffViewHref } from "@/features/tc/referrals/hubActions";
import { OfficeId } from "@shared/tc/contract";

/** Where an old sign-off link goes. Pure. */
export function signoffRedirectTarget(search: string): string {
  const q = new URLSearchParams(search);
  const office = OfficeId.safeParse(q.get("office"));
  return signoffViewHref(office.success ? office.data : null, q.get("referral"));
}

export default function TcReferralSignoffRedirect() {
  const search = useSearch();
  return <Redirect to={signoffRedirectTarget(search)} replace />;
}
