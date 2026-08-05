/**
 * /tc/library — office library & settings. Loads the whole library once per
 * office, then hands each section to its editor. Every save is a strict
 * whole-section PUT (see features/tc/library/*); this page just routes
 * persisted values back into local state.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  CreditCard,
  DollarSign,
  FolderKanban,
  LayoutList,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  Tags,
} from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import {
  getLibrary,
  tcErrorMessage,
  type TcLibrary as TcLibraryValue,
} from "@/features/tc/api";
import {
  TcOfficeGate,
  TcPageHeader,
  useTcOffice,
} from "@/features/tc/components/TcShell";
import {
  FinancingConfigEditor,
  FinancingOverridesEditor,
  ProvidersEditor,
} from "@/features/tc/library/FinancingEditors";
import {
  CadenceEditor,
  ObjectionsEditor,
  PricingEditor,
  StagesEditor,
  TagSectionEditor,
  TreatmentCategoriesEditor,
} from "@/features/tc/library/SectionEditors";

type SectionId =
  | "pricing"
  | "financing"
  | "stages"
  | "objections"
  | "tags"
  | "categories"
  | "cadence";

const NAV: { id: SectionId; label: string; icon: React.ElementType }[] = [
  { id: "pricing", label: "Pricing", icon: DollarSign },
  { id: "financing", label: "Financing", icon: CreditCard },
  { id: "stages", label: "Stages", icon: LayoutList },
  { id: "objections", label: "Objections", icon: MessageSquareQuote },
  { id: "tags", label: "Tags", icon: Tags },
  { id: "categories", label: "Treatment Categories", icon: FolderKanban },
  { id: "cadence", label: "Cadence", icon: CalendarClock },
];

export default function TcLibrary() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }
  // Keyed by office so switching offices remounts editors with fresh drafts.
  return <LibraryInner key={office} office={office} />;
}

function LibraryInner({ office }: { office: OfficeId }) {
  const [library, setLibrary] = useState<TcLibraryValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SectionId>("pricing");

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

  return (
    <div className="p-6">
      <TcPageHeader
        title="Library"
        subtitle="Office-wide configuration for the Treatment Coordinator module — pricing, financing, stages, tags, and follow-up cadence"
      />

      {loading ? (
        <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading library…</span>
        </div>
      ) : error !== null || library === null ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {error ?? "Couldn't load the library."}
          </p>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="w-4 h-4 mr-1" /> Retry
          </Button>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row gap-4 items-start">
          {/* Section nav */}
          <nav className="flex md:flex-col flex-wrap gap-1 md:w-52 shrink-0 md:sticky md:top-4">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActive(id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  active === id
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Active section */}
          <div className="flex-1 min-w-0 space-y-4 w-full">
            {active === "pricing" && (
              <PricingEditor
                office={office}
                value={library.crown_pricing}
                onSaved={(v) => setLibrary((p) => ({ ...p, crown_pricing: v }))}
              />
            )}

            {active === "financing" && (
              <>
                <ProvidersEditor
                  office={office}
                  value={library.financing_providers}
                  onSaved={(v) => setLibrary((p) => ({ ...p, financing_providers: v }))}
                />
                <FinancingConfigEditor
                  office={office}
                  value={library.financing_config}
                  onSaved={(v) => setLibrary((p) => ({ ...p, financing_config: v }))}
                />
                <FinancingOverridesEditor
                  office={office}
                  value={library.financing_settings}
                  providers={library.financing_providers}
                  onSaved={(v) => setLibrary((p) => ({ ...p, financing_settings: v }))}
                />
              </>
            )}

            {active === "stages" && (
              <StagesEditor
                office={office}
                value={library.stages}
                onSaved={(v) => setLibrary((p) => ({ ...p, stages: v }))}
              />
            )}

            {active === "objections" && (
              <ObjectionsEditor
                office={office}
                value={library.objections}
                onSaved={(v) => setLibrary((p) => ({ ...p, objections: v }))}
              />
            )}

            {active === "tags" && (
              <>
                <TagSectionEditor
                  office={office}
                  section="motivators"
                  title="Motivators"
                  description="Why the patient wants treatment — tagged on cases to shape follow-up talking points."
                  value={library.motivators}
                  onSaved={(v) => setLibrary((p) => ({ ...p, motivators: v }))}
                />
                <TagSectionEditor
                  office={office}
                  section="lost_reasons"
                  title="Lost reasons"
                  description="Why a case was lost — powers loss reporting."
                  value={library.lost_reasons}
                  onSaved={(v) => setLibrary((p) => ({ ...p, lost_reasons: v }))}
                />
                <TagSectionEditor
                  office={office}
                  section="referral_sources"
                  title="Referral sources"
                  description="How patients find the office."
                  value={library.referral_sources}
                  onSaved={(v) => setLibrary((p) => ({ ...p, referral_sources: v }))}
                />
              </>
            )}

            {active === "categories" && (
              <TreatmentCategoriesEditor
                office={office}
                value={library.treatment_categories}
                providers={library.financing_providers}
                onSaved={(v) => setLibrary((p) => ({ ...p, treatment_categories: v }))}
              />
            )}

            {active === "cadence" && (
              <CadenceEditor
                office={office}
                value={library.cadence_config}
                onSaved={(v) => setLibrary((p) => ({ ...p, cadence_config: v }))}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
