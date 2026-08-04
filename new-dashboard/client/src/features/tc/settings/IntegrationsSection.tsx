/**
 * Settings → Integrations. HONEST ADAPTATION, read-only.
 *
 * Legacy DentaFlow read /api/od/status and showed whether the office's
 * Open Dental API keys were present in the server .env. The platform has no
 * equivalent read entitled to the TC module: the only Open Dental signal
 * reachable from here is the per-office `odConnected` flag the platform office
 * registry already puts in OfficeContext. That flag describes the PLATFORM
 * connector, not Treatment Coordinator's own Open Dental linking — which
 * arrives in Slice 5 — so both facts are stated separately rather than
 * collapsed into one green check.
 *
 * Nothing in this section is configurable: no toggles, no connect buttons, no
 * claimed connections we did not actually read.
 */
import { HardDrive, Mail, Plug } from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import type { OfficeId } from "@shared/tc/contract";
import { DisabledFeatureNote } from "@/features/tc/components/TcShell";
import { IntegrationRow, SettingsCard, type IntegrationState } from "./chrome";

export function IntegrationsSection({ office }: { office: OfficeId }) {
  const { offices, loading } = useOffice();
  const selected = offices.find((o) => o.officeId === office) ?? null;

  // Three-valued on purpose: while the office registry is still loading (or
  // the office is missing from it) we say "unknown" rather than "disconnected".
  const odState: IntegrationState = loading || selected === null
    ? "unknown"
    : selected.odConnected
      ? "available"
      : "unavailable";

  const odDetail =
    odState === "unknown"
      ? "The platform office registry hasn't reported a status for this office yet."
      : odState === "available"
        ? "The platform reports an Open Dental connector for this office. That connection serves the platform; Treatment Coordinator does not read from or write to Open Dental yet."
        : "The platform does not report an Open Dental connector for this office.";

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Integrations"
        icon={Plug}
        description="Connections are provisioned by the platform, not from this page. This is a read-only view of what Treatment Coordinator can actually rely on for this office today."
      >
        <div className="space-y-2">
          <IntegrationRow
            label="Open Dental (platform connector)"
            state={odState}
            badgeLabel={
              odState === "available"
                ? "Connected"
                : odState === "unavailable"
                  ? "Not connected"
                  : undefined
            }
            detail={odDetail}
          >
            <DisabledFeatureNote reason="slice5_od" />
          </IntegrationRow>

          <IntegrationRow
            label="Email sending"
            state="unavailable"
            detail="Templates and communication history are live and editable, but no message can leave the system yet. Send controls stay visibly disabled everywhere in the module rather than failing silently."
          >
            <DisabledFeatureNote reason="platform_email" />
          </IntegrationRow>

          <IntegrationRow
            label="Media & document storage"
            state="available"
            detail="Gallery images and case documents are served through the module's entitlement-checked media proxy, scoped to this office. Where an environment has no blob store configured, the proxy returns an explicit error and images fall back to a labelled placeholder instead of appearing broken."
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Credentials"
        icon={HardDrive}
        description="Connection credentials are never entered or displayed in this application."
      >
        <p className="text-xs text-muted-foreground leading-relaxed">
          Every integration secret lives in the platform's managed
          configuration and is read by the backend only. There is nothing to
          paste here, and no key is ever sent to the browser.
        </p>
      </SettingsCard>

      <SettingsCard title="Reaching a person" icon={Mail}>
        <p className="text-xs text-muted-foreground leading-relaxed">
          If an integration above shows a status you don't expect, it is a
          platform-side provisioning question rather than something this page
          can fix. Raise it with your CareIN contact.
        </p>
      </SettingsCard>
    </div>
  );
}
