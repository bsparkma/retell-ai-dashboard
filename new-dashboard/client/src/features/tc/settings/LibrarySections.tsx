/**
 * Settings → Pricing / Financing / Stages / Library.
 *
 * These four sections REUSE the existing office-library editors from
 * features/tc/library verbatim. They are the same components /tc/library
 * renders, driving the same confirmed whole-section PUT through
 * putLibrarySection. There is deliberately no second write path to this data:
 * this module contributes arrangement only, never persistence.
 *
 * Each editor owns its own draft/dirty/save state; we just hand it the loaded
 * slice and fold the persisted value the server returned back into the page's
 * copy of the library.
 */
import type { OfficeId } from "@shared/tc/contract";
import type { TcLibrary } from "@/features/tc/api";
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

/** Merges a persisted section back into the page's library snapshot. */
export type LibraryPatch = (patch: TcLibrary) => void;

interface SectionProps {
  office: OfficeId;
  library: TcLibrary;
  onPatch: LibraryPatch;
}

/**
 * Shown above every library-backed section so nobody wonders whether Settings
 * and Library are two different copies of the same numbers.
 */
function SharedWithLibraryNote() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Saved to this office's library — the same settings the Library page
      edits. Changes apply to everyone in this office.
    </p>
  );
}

export function PricingSection({ office, library, onPatch }: SectionProps) {
  return (
    <div className="space-y-4">
      <SharedWithLibraryNote />
      <PricingEditor
        office={office}
        value={library.crown_pricing}
        onSaved={(crown_pricing) => onPatch({ crown_pricing })}
      />
    </div>
  );
}

export function FinancingSection({ office, library, onPatch }: SectionProps) {
  return (
    <div className="space-y-4">
      <SharedWithLibraryNote />
      <ProvidersEditor
        office={office}
        value={library.financing_providers}
        onSaved={(financing_providers) => onPatch({ financing_providers })}
      />
      <FinancingConfigEditor
        office={office}
        value={library.financing_config}
        onSaved={(financing_config) => onPatch({ financing_config })}
      />
      <FinancingOverridesEditor
        office={office}
        value={library.financing_settings}
        providers={library.financing_providers}
        onSaved={(financing_settings) => onPatch({ financing_settings })}
      />
    </div>
  );
}

export function StagesSection({ office, library, onPatch }: SectionProps) {
  return (
    <div className="space-y-4">
      <SharedWithLibraryNote />
      <StagesEditor
        office={office}
        value={library.stages}
        onSaved={(stages) => onPatch({ stages })}
      />
    </div>
  );
}

/**
 * The remaining library lists: the tag vocabularies, the objection scripts,
 * treatment categories, and the follow-up cadence. Everything the office can
 * word for itself lives here.
 */
export function LibraryListsSection({ office, library, onPatch }: SectionProps) {
  return (
    <div className="space-y-4">
      <SharedWithLibraryNote />
      <TagSectionEditor
        office={office}
        section="motivators"
        title="Motivators"
        description="Why the patient wants treatment — tagged on cases to shape follow-up talking points."
        value={library.motivators}
        onSaved={(motivators) => onPatch({ motivators })}
      />
      <TagSectionEditor
        office={office}
        section="lost_reasons"
        title="Lost reasons"
        description="Why a case was lost — powers loss reporting."
        value={library.lost_reasons}
        onSaved={(lost_reasons) => onPatch({ lost_reasons })}
      />
      <TagSectionEditor
        office={office}
        section="referral_sources"
        title="Referral sources"
        description="How patients find the office."
        value={library.referral_sources}
        onSaved={(referral_sources) => onPatch({ referral_sources })}
      />
      <ObjectionsEditor
        office={office}
        value={library.objections}
        onSaved={(objections) => onPatch({ objections })}
      />
      <TreatmentCategoriesEditor
        office={office}
        value={library.treatment_categories}
        providers={library.financing_providers}
        onSaved={(treatment_categories) => onPatch({ treatment_categories })}
      />
      <CadenceEditor
        office={office}
        value={library.cadence_config}
        onSaved={(cadence_config) => onPatch({ cadence_config })}
      />
    </div>
  );
}
