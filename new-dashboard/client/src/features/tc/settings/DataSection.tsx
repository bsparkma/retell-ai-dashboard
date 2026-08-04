/**
 * Settings → Data & Backup. EXPLANATORY, read-only.
 *
 * Legacy DentaFlow offered a "Export Settings (JSON)" download and told the
 * office to copy server/data to back up, because its data really did live in
 * loose JSON files next to the app. On the platform, Treatment Coordinator
 * data is in the practice's Postgres tenant database with platform-managed
 * backups.
 *
 * Deliberately NOT built here: an export endpoint, a backup button, or a
 * restore flow. None of those exist on the platform, and a button that
 * implies a backup you do not have is worse than no button. There is also no
 * Treatment Coordinator CSV export to link to yet, so this section renders no
 * controls at all.
 */
import { Database, DownloadCloud, ShieldCheck } from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import type { OfficeId } from "@shared/tc/contract";
import { ReadOnlyRow, RetiredNote, SettingsCard } from "./chrome";

export function DataSection({ office }: { office: OfficeId }) {
  const { offices } = useOffice();
  const selected = offices.find((o) => o.officeId === office) ?? null;

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Where your data lives"
        icon={Database}
        description="Everything Treatment Coordinator records — cases, follow-ups, preauths, templates, and this office's library — is stored in your practice's database on the platform."
      >
        <div className="space-y-2">
          <ReadOnlyRow
            label="Storage"
            value="Platform tenant database"
            hint="A managed PostgreSQL database dedicated to your practice. Every row is scoped to one office."
          />
          <ReadOnlyRow
            label="Scope of this page"
            value={selected?.officeName ?? office}
            hint="Library settings are per-office. Other offices in this practice have their own."
          />
          <ReadOnlyRow
            label="Images & documents"
            value="Platform blob storage"
            hint="Served only through the module's entitlement-checked media proxy."
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Backups"
        icon={ShieldCheck}
        description="Backups are managed by the platform at the database level, on the same schedule and retention as every other CareIN module."
      >
        <p className="text-xs text-muted-foreground leading-relaxed">
          There is nothing for the office to run, remember, or store locally,
          and no backup action to take from this page. Restores are a platform
          operation — contact your CareIN contact if you ever need one.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Export"
        icon={DownloadCloud}
        description="Retired."
      >
        <RetiredNote>
          The legacy "Export Settings (JSON)" download existed because the old
          app kept practice data in browser storage and loose files on the
          office's own machine — the export was the only real backup. That is
          no longer how the data is stored, so the download has been retired
          rather than reimplemented. Treatment Coordinator has no data export
          yet; when one ships it will be a real, supported export rather than a
          snapshot of a browser.
        </RetiredNote>
      </SettingsCard>
    </div>
  );
}
