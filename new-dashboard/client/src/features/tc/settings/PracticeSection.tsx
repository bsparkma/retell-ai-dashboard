/**
 * Settings → Practice. READ-ONLY.
 *
 * Legacy DentaFlow let the office edit its own name/address/phone because it
 * owned that record in a local JSON file. On the platform, practice identity
 * is the tenant record from the control-plane registry (delivered by
 * /auth/me) and the office list comes from platform office config. The TC
 * module has no write path to either, so this renders what we know and says
 * where to change it. No fake edit form.
 */
import { Building2, Landmark } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOffice } from "@/contexts/OfficeContext";
import type { OfficeId } from "@shared/tc/contract";
import { ReadOnlyRow, SettingsCard } from "./chrome";

export function PracticeSection({ office }: { office: OfficeId }) {
  const auth = useAuth();
  const { offices } = useOffice();

  const tenant = auth.status === "authenticated" ? auth.user.tenant : null;
  const selected = offices.find((o) => o.officeId === office) ?? null;

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Practice"
        icon={Building2}
        description="Your practice identity comes from the platform tenant record. It is shown here for reference and is not editable from the Treatment Coordinator module."
      >
        <div className="space-y-2">
          <ReadOnlyRow
            label="Practice name"
            value={tenant?.displayName ?? "Not available"}
          />
          <ReadOnlyRow
            label="Practice ID"
            value={tenant?.slug ?? "Not available"}
            hint="The tenant slug used across every CareIN module."
          />
          <ReadOnlyRow
            label="Enabled modules"
            value={
              tenant && tenant.modules.length > 0
                ? tenant.modules.join(", ")
                : "Not available"
            }
            hint="Module access is granted per tenant by the platform; the backend entitlement check is the source of truth."
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          To change practice name, branding, or module access, use platform
          settings — those values are shared by every module and are not owned
          by Treatment Coordinator.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Offices"
        icon={Landmark}
        description="Treatment Coordinator works one office at a time. Office records are managed in platform office config; switch offices with the picker in the top bar."
      >
        <div className="space-y-2">
          <ReadOnlyRow
            label="Current office"
            value={selected?.officeName ?? office}
            hint="Every library setting on this page is scoped to this office."
          />
          <ReadOnlyRow
            label="Offices in this practice"
            value={
              offices.length > 0
                ? offices.map((o) => o.officeName).join(", ")
                : "Not available"
            }
          />
        </div>
      </SettingsCard>
    </div>
  );
}
