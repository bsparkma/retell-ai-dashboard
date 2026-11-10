/**
 * The /admin settings hub's card map (SC-1).
 *
 * /admin is the PRACTICE's settings, for that practice's admin users. The
 * Developer Console (/platform) is for Beau and future developers. This file
 * is the list of cards /admin shows, in two groups, and the rule for which ones
 * a viewer sees.
 *
 * A CARD IS SHOWN ONLY IF IT WOULD OPEN. Two checks:
 *   - `module`: the practice is entitled to it (auth.user.tenant.modules). A
 *     practice without TC gets no TC cards, rather than cards that 403.
 *   - `canVisit` on the card's own href: the viewer passes that page's route
 *     permission, so a card never links somewhere the courtesy redirect would
 *     bounce them from.
 * Cards for pages under /admin's own admin.all gate set neither check: anyone
 * looking at this page already holds admin.all.
 *
 * UX ONLY, like every client permission. Each page behind a card is gated
 * server-side regardless.
 *
 * NOT HERE, ON PURPOSE:
 *   - Practice staff. #304 retired that page and folded it into Users (each
 *     person's "Signature on notes"), and nothing in the Developer Console
 *     replaced it, so there is no page to link to.
 *   - Hygiene. Its only setting is the per-office pilot switch, which is a
 *     Developer Console control, not a practice one.
 * The RCM cards are not links: they are RcmPostingSettingsCard and
 * RcmShadowComparisonCard, rendered in place by Admin.tsx, and each hides
 * itself without `rcm.settings`.
 */
import type { LucideIcon } from "lucide-react";
import { Bot, BookOpen, Building2, CalendarClock, Printer, Send, Stethoscope, Users } from "lucide-react";
import { canVisit } from "@/lib/permissions";
import { hasModule, type ModuleId } from "@/lib/modules";
import { tcSettingsHref } from "@/features/tc/settings/paths";

export type HubGroup = "practice" | "module";

export interface HubCard {
  /** Stable id, used for the `admin-link-<id>` test id. */
  id: string;
  group: HubGroup;
  /** Heading of the sub-group within "Module settings" (Treatment Coordinator, Voice). */
  subgroup?: string;
  href: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  /** The practice must be entitled to this module. */
  module?: ModuleId;
  /** Check the viewer may open `href` (its ROUTE_PERMISSIONS entry). */
  checkRoute?: boolean;
}

export const HUB_CARDS: readonly HubCard[] = [
  // ── Practice settings ──────────────────────────────────────────────────────
  // The first three are sections of the TC settings page today, so they open
  // it at the right section and carry its gate.
  {
    id: "practice-info",
    group: "practice",
    href: tcSettingsHref("practice"),
    icon: Building2,
    title: "Practice info & email identity",
    detail: "The practice record, and the reply-to, name and phone on outgoing email",
    module: "tc",
    checkRoute: true,
  },
  {
    id: "providers",
    group: "practice",
    href: tcSettingsHref("providers"),
    icon: Stethoscope,
    title: "Providers",
    detail: "Referring providers and pre-auth doctors, per office",
    module: "tc",
    checkRoute: true,
  },
  {
    id: "referrals",
    group: "practice",
    href: tcSettingsHref("referrals"),
    icon: Send,
    title: "Referrals",
    detail: "Specialists and referral policies (shown while referrals is on for the office)",
    module: "tc",
    checkRoute: true,
  },
  {
    id: "print-templates",
    group: "practice",
    href: "/admin/print-templates",
    icon: Printer,
    title: "Print templates",
    detail: "School/work excuses and appointment cards",
  },
  {
    id: "users",
    group: "practice",
    href: "/admin/users",
    icon: Users,
    title: "Users & roles",
    detail: "Who can sign in, what each role lets them do, and the name and licence their notes print",
  },
  // ── Module settings ────────────────────────────────────────────────────────
  {
    id: "tc-settings",
    group: "module",
    subgroup: "Treatment Coordinator",
    href: tcSettingsHref(),
    icon: BookOpen,
    title: "Treatment Coordinator settings",
    detail: "Pricing, financing, stages, the library, notifications and more",
    module: "tc",
    checkRoute: true,
  },
  {
    id: "agents",
    group: "module",
    subgroup: "Voice",
    href: "/agents",
    icon: Bot,
    title: "Agent Builder",
    detail: "The voice agent's persona, prompt and office knowledge",
    module: "voice",
    checkRoute: true,
  },
  {
    id: "scheduling",
    group: "module",
    subgroup: "Voice",
    href: "/scheduling",
    icon: CalendarClock,
    title: "Scheduling",
    detail: "The rules the voice agent schedules by, and the Open Dental calendar",
    module: "voice",
    checkRoute: true,
  },
];

/**
 * The cards this viewer sees, in registry order.
 * @param permissions the viewer's actions (auth.user.permissions)
 * @param tenantModules the practice's entitled modules (auth.user.tenant.modules)
 */
export function visibleHubCards(
  permissions: readonly string[] | undefined,
  tenantModules: readonly string[] | undefined,
): HubCard[] {
  return HUB_CARDS.filter(
    (c) =>
      (!c.module || hasModule(tenantModules, c.module)) &&
      (!c.checkRoute || canVisit(permissions, c.href.split("#")[0] ?? c.href)),
  );
}
