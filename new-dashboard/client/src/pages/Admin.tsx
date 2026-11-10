/**
 * /admin — the practice's settings hub (SC-1).
 *
 * Beau's ratified model: /admin is PRACTICE-level settings, for that practice's
 * admin users. The Developer Console (/platform) is for Beau and future
 * developers only. So this page is a card map in two groups:
 *
 *   Practice settings  Practice info & email identity, Providers, Referrals
 *                      (sections of the TC settings page), Print templates,
 *                      Users & roles
 *   Module settings    Treatment Coordinator (the TC settings page, moved to
 *                      /admin/tc/settings), Voice (Agent Builder, Scheduling,
 *                      and the call-notification toggles), RCM (the posting
 *                      switch and its shadow comparison)
 *
 * The cards are data, in ./admin/settingsHub.ts, which also holds the rule for
 * which cards a viewer sees.
 *
 * WHAT LEFT THIS PAGE. The voice operations widgets (service health and
 * connection tests, the Mango sync controls and history, the configuration
 * readout, usage and costs, the processing queues, recent sync errors) moved
 * to the Developer Console's Operations tab. They still call the same
 * /api/admin/* endpoints, which SC-1 did not touch. The Users tab's "coming
 * soon" placeholder is gone: the Users & roles card is the real thing.
 *
 * GATING. /admin itself demands admin.all (ROUTE_PERMISSIONS), unchanged. A card
 * a viewer could not open is not shown (see settingsHub.ts). No nav tab was
 * added: the "admin sub-pages get a card on /admin, never a nav item" ruling
 * stands.
 */
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { hasModule } from "@/lib/modules";
import RcmPostingSettingsCard from "./admin/RcmPostingSettingsCard";
import RcmShadowComparisonCard from "./admin/RcmShadowComparisonCard";
import VoiceNotificationsCard from "./admin/VoiceNotificationsCard";
import { visibleHubCards, type HubCard } from "./admin/settingsHub";

function HubLink({ card }: { card: HubCard }) {
  const Icon = card.icon;
  return (
    <Link href={card.href} className="block" data-testid={`admin-link-${card.id}`}>
      <Card className="hover:shadow-md transition-shadow h-full">
        <CardContent className="p-5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Icon size={18} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-foreground">{card.title}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{card.detail}</div>
          </div>
          <ChevronRight size={16} className="text-muted-foreground flex-shrink-0" />
        </CardContent>
      </Card>
    </Link>
  );
}

function CardGrid({ cards }: { cards: HubCard[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-6xl">
      {cards.map((c) => (
        <HubLink key={c.id} card={c} />
      ))}
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-foreground">{children}</h3>;
}

export default function Admin() {
  const auth = useAuth();
  const user = auth.status === "authenticated" ? auth.user : null;
  const tenantModules = user?.tenant?.modules;
  const cards = visibleHubCards(user?.permissions, tenantModules);

  const practiceCards = cards.filter((c) => c.group === "practice");
  const tcCards = cards.filter((c) => c.group === "module" && c.subgroup === "Treatment Coordinator");
  const voiceCards = cards.filter((c) => c.group === "module" && c.subgroup === "Voice");
  const voiceEntitled = hasModule(tenantModules, "voice");

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
          Admin
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Settings for your practice and its modules</p>
      </div>

      <section className="space-y-3" data-testid="admin-practice-settings" aria-labelledby="admin-practice-heading">
        <h2 id="admin-practice-heading" className="text-base font-semibold text-foreground">
          Practice settings
        </h2>
        <CardGrid cards={practiceCards} />
      </section>

      <section className="space-y-5" data-testid="admin-module-settings" aria-labelledby="admin-module-heading">
        <h2 id="admin-module-heading" className="text-base font-semibold text-foreground">
          Module settings
        </h2>

        {tcCards.length > 0 && (
          <div className="space-y-3" data-testid="admin-module-tc">
            <SubHeading>Treatment Coordinator</SubHeading>
            <CardGrid cards={tcCards} />
          </div>
        )}

        {voiceEntitled && (
          <div className="space-y-3" data-testid="admin-module-voice">
            <SubHeading>Voice</SubHeading>
            {voiceCards.length > 0 && <CardGrid cards={voiceCards} />}
            <div className="max-w-2xl">
              <VoiceNotificationsCard />
            </div>
          </div>
        )}

        {/* RCM: the shadow gate's switch and the evidence it should be decided
            from, together on purpose (see each card). Each renders nothing
            without `rcm.settings`, or for a practice with no RCM offices, so
            the sub-heading is shown only to someone who can hold that switch. */}
        {hasModule(tenantModules, "rcm") && user !== null && user.permissions.includes("rcm.settings") && (
          <div className="space-y-3 max-w-4xl" data-testid="admin-module-rcm">
            <SubHeading>Revenue Cycle</SubHeading>
            <RcmPostingSettingsCard />
            <RcmShadowComparisonCard />
          </div>
        )}
      </section>
    </div>
  );
}
