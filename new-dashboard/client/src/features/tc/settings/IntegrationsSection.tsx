/**
 * Settings → Integrations. HONEST ADAPTATION, read-only.
 *
 * Legacy DentaFlow read /api/od/status and showed whether the office's Open
 * Dental API keys were present in the server .env. Slice 5 gives Treatment
 * Coordinator its own equivalent — GET /api/tc/od/status — so this row now
 * reports what the module ACTUALLY managed to do for this office (a live probe),
 * not just the platform registry's `odConnected` flag.
 *
 * The two facts stay separate, because they can disagree: an office can be
 * marked connected in the registry while the OD API itself is unreachable, and
 * that difference is exactly what someone reads this page to find out.
 *
 * Reads only. Treatment Coordinator writes nothing to Open Dental in this slice;
 * the chart note write arrives with Slice 6, and the row says so rather than
 * implying a two-way connection.
 *
 * Nothing in this section is configurable: no toggles, no connect buttons, no
 * claimed connections we did not actually read.
 */
import { useEffect, useState } from "react";
import { HardDrive, Mail, Plug } from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import type { OfficeId } from "@shared/tc/contract";
import { DisabledFeatureNote } from "@/features/tc/components/TcShell";
import { isOdNotConnected, odStatus, type OdStatus } from "@/features/tc/api";
import { IntegrationRow, SettingsCard, type IntegrationState } from "./chrome";

export function IntegrationsSection({ office }: { office: OfficeId }) {
  const { offices, loading } = useOffice();
  const selected = offices.find((o) => o.officeId === office) ?? null;

  /** null while probing; `false` once we know the office has no OD connection. */
  const [probe, setProbe] = useState<OdStatus | null | false>(null);
  useEffect(() => {
    let live = true;
    setProbe(null);
    odStatus(office)
      .then((s) => live && setProbe(s))
      .catch((e: unknown) => {
        if (!live) return;
        // A refusal is an answer ("not connected"); anything else is unknown.
        setProbe(isOdNotConnected(e) ? false : null);
      });
    return () => {
      live = false;
    };
  }, [office]);

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
        ? "The platform reports an Open Dental connector for this office."
        : "The platform does not report an Open Dental connector for this office.";

  const tcOdDetail =
    probe === false
      ? "Treatment Coordinator cannot read Open Dental for this office yet. Patient search, treatment-plan pull and the COB pull are unavailable here."
      : probe === null
        ? "Checking whether Treatment Coordinator can reach Open Dental for this office…"
        : probe.reachable
          ? "Treatment Coordinator can read Open Dental for this office: patient search, treatment plans, coordination-of-benefits data and the next appointment. It writes nothing back — chart notes arrive in a later slice."
          : `Treatment Coordinator is configured for this office but could not reach Open Dental just now${probe.detail ? ` (${probe.detail})` : ""}.`;

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
          />

          <IntegrationRow
            label="Open Dental (Treatment Coordinator reads)"
            state={probe === false ? "unavailable" : probe === null ? "unknown" : probe.reachable ? "available" : "unavailable"}
            badgeLabel={
              probe === false
                ? "Not connected"
                : probe === null
                  ? undefined
                  : probe.reachable
                    ? "Reading"
                    : "Unreachable"
            }
            detail={tcOdDetail}
          />

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
