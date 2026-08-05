/**
 * /tc/settings — the Settings shell.
 *
 * This is DentaFlow's Settings ARRANGEMENT over the platform's existing
 * capabilities: a sticky left section nav with hash deep links
 * (/tc/settings#pricing), the same eight sections in the same order.
 *
 * What is behind each section is platform reality, not a port:
 *  - Pricing / Financing / Stages / Library reuse the existing office-library
 *    editors, which own the only write path to that data;
 *  - Practice is read-only from the tenant record;
 *  - Team, Integrations, and Data & Backup explain what the platform owns
 *    elsewhere and render no controls, rather than faking capabilities.
 *
 * Library data is per-office, so the office gate applies to the whole page.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import {
  getLibrary,
  tcErrorMessage,
  type TcLibrary,
} from "@/features/tc/api";
import {
  TcOfficeGate,
  TcPageHeader,
  useTcOffice,
} from "@/features/tc/components/TcShell";
import { DataSection } from "@/features/tc/settings/DataSection";
import { IntegrationsSection } from "@/features/tc/settings/IntegrationsSection";
import {
  FinancingSection,
  LibraryListsSection,
  PricingSection,
  StagesSection,
} from "@/features/tc/settings/LibrarySections";
import { PracticeSection } from "@/features/tc/settings/PracticeSection";
import { TeamSection } from "@/features/tc/settings/TeamSection";
import {
  TC_SETTINGS_SECTIONS,
  currentSectionFromLocation,
  sectionMeta,
  type TcSettingsSectionKey,
} from "@/features/tc/settings/sections";

export default function TcSettings() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }
  // Keyed by office so switching offices remounts the library editors with
  // fresh drafts — a half-typed fee must never follow you to another office.
  return <SettingsInner key={office} office={office} />;
}

function SettingsInner({ office }: { office: OfficeId }) {
  const [active, setActive] = useState<TcSettingsSectionKey>(() =>
    currentSectionFromLocation(),
  );
  const [library, setLibrary] = useState<TcLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Deep links: /tc/settings#pricing opens Pricing, and Back/Forward between
  // sections works because picking one writes the hash.
  useEffect(() => {
    function onHash() {
      setActive(currentSectionFromLocation());
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getLibrary(office)
      .then(setLibrary)
      .catch((e: unknown) => setError(tcErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [office]);

  useEffect(() => {
    load();
  }, [load]);

  function pick(key: TcSettingsSectionKey) {
    setActive(key);
    if (typeof window !== "undefined") window.location.hash = key;
  }

  const meta = sectionMeta(active);

  function patchLibrary(patch: TcLibrary) {
    setLibrary((prev) => ({ ...(prev ?? {}), ...patch }));
  }

  return (
    <div className="p-6">
      <TcPageHeader
        title="Settings"
        subtitle="Practice configuration and preferences for the Treatment Coordinator module"
      />

      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 items-start">
        <nav
          aria-label="Settings sections"
          className="bg-card rounded-xl border border-border p-2 shadow-sm md:sticky md:top-4"
        >
          <ul className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
            {TC_SETTINGS_SECTIONS.map(({ key, label, icon: Icon }) => {
              const isActive = key === active;
              return (
                <li key={key} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => pick(key)}
                    aria-current={isActive ? "page" : undefined}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left whitespace-nowrap transition-colors ${
                      isActive
                        ? "bg-primary/10 text-primary font-semibold"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section
          role="region"
          aria-label={meta.label}
          className="min-w-0 w-full space-y-4"
        >
          {meta.needsLibrary ? (
            loading ? (
              <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
                <span className="text-sm">Loading settings…</span>
              </div>
            ) : error !== null || library === null ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  {error ?? "Couldn't load this office's settings."}
                </p>
                <Button variant="outline" size="sm" onClick={load}>
                  <RefreshCw className="w-4 h-4 mr-1" aria-hidden /> Retry
                </Button>
              </div>
            ) : (
              renderLibrarySection(active, office, library, patchLibrary)
            )
          ) : (
            renderStaticSection(active, office)
          )}
        </section>
      </div>
    </div>
  );
}

function renderLibrarySection(
  key: TcSettingsSectionKey,
  office: OfficeId,
  library: TcLibrary,
  onPatch: (patch: TcLibrary) => void,
) {
  const props = { office, library, onPatch };
  switch (key) {
    case "pricing":
      return <PricingSection {...props} />;
    case "financing":
      return <FinancingSection {...props} />;
    case "stages":
      return <StagesSection {...props} />;
    case "library":
      return <LibraryListsSection {...props} />;
    default:
      return null;
  }
}

function renderStaticSection(key: TcSettingsSectionKey, office: OfficeId) {
  switch (key) {
    case "practice":
      return <PracticeSection office={office} />;
    case "team":
      return <TeamSection />;
    case "integrations":
      return <IntegrationsSection office={office} />;
    case "data":
      return <DataSection office={office} />;
    default:
      return null;
  }
}
