/**
 * /tc/cases/:id/prep — Consult Prep (ported from DentaFlow PrepConsult).
 *
 * Quick case brief before entering Presentation Mode: patient context,
 * financial summary, phase overview, before/after gallery picks, known
 * concerns, and a prep checklist. The checklist toggles and the gallery
 * selection are PAGE-LOCAL state — the legacy app never persisted them
 * either, and the presentation deck sources its Before/After slide from the
 * office gallery directly.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Heart,
  Image as ImageIcon,
  Plus as PlusIcon,
  Presentation,
  Search as SearchIcon,
  SearchX,
  User,
  X,
} from "lucide-react";
import type { OfficeId, TcCase, TcGalleryCase } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getCase,
  getLibrary,
  listGallery,
  TcApiError,
  tcErrorMessage,
  type TcLibrary,
} from "@/features/tc/api";
import { TcOfficeGate, UrgencyBadge, useTcOffice } from "@/features/tc/components/TcShell";
import { formatCents } from "@/features/tc/money";
import { financingOptionsCents } from "@/features/tc/lib/financing";
import {
  casePatientPortionCents,
  pickPresentationOptions,
} from "@/features/tc/present/slides";
import { TcMediaPair } from "@/features/tc/gallery/GalleryGrid";
import { GalleryPicker } from "@/features/tc/consult/GalleryPicker";
import { suggestedGalleryCases } from "@/features/tc/consult/galleryMap";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export default function TcPrepConsult() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }
  return <PrepConsultInner office={office} />;
}

function PrepConsultInner({ office }: { office: OfficeId }) {
  const { id } = useParams<{ id: string }>();
  const caseId = id ?? "";

  const [tcCase, setTcCase] = useState<TcCase | null>(null);
  const [library, setLibrary] = useState<TcLibrary>({});
  const [gallery, setGallery] = useState<TcGalleryCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [checklist, setChecklist] = useState({
    reviewedPlan: false,
    financingReady: false,
    insuranceVerified: false,
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!caseId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setLoadError(null);
    getCase(office, caseId)
      .then((c) => {
        if (!cancelled) setTcCase(c);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof TcApiError && e.status === 404) setNotFound(true);
        else setLoadError(tcErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Library + gallery are optional — failures just hide those sections.
    getLibrary(office)
      .then((lib) => {
        if (!cancelled) setLibrary(lib);
      })
      .catch(() => {});
    listGallery(office)
      .then((g) => {
        if (!cancelled) setGallery(g);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [office, caseId]);

  const toggleSelected = useCallback((galleryId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(galleryId)) next.delete(galleryId);
      else next.add(galleryId);
      return next;
    });
  }, []);

  // Money — sums from real items, all integer cents.
  const totals = useMemo(() => {
    if (!tcCase) return { fee: 0, insurance: 0, patient: 0 };
    const items = tcCase.phases.flatMap((p) => p.items);
    return {
      fee: items.reduce((s, i) => s + i.feeCents, 0),
      insurance: items.reduce((s, i) => s + i.insuranceEstCents, 0),
      patient: items.reduce((s, i) => s + i.patientPortionCents, 0),
    };
  }, [tcCase]);

  // Financing chips — only when the office library has providers configured.
  const financingChips = useMemo(() => {
    const providers = library.financing_providers;
    if (!tcCase || !providers || providers.length === 0) return [];
    const portion = casePatientPortionCents(tcCase);
    if (portion <= 0) return [];
    return pickPresentationOptions(
      financingOptionsCents(portion, providers, library.financing_settings ?? null),
    ).slice(0, 3);
  }, [tcCase, library]);

  const suggested = useMemo(() => {
    if (!tcCase) return [];
    return suggestedGalleryCases(tcCase.caseType, tcCase.category, gallery, selectedIds);
  }, [tcCase, gallery, selectedIds]);

  const selectedCases = useMemo(
    () => gallery.filter((g) => selectedIds.has(g.galleryId)),
    [gallery, selectedIds],
  );

  const lastObjection = useMemo(() => {
    if (!tcCase || tcCase.objections.length === 0) return null;
    return [...tcCase.objections].sort((a, b) => b.loggedAt.localeCompare(a.loggedAt))[0] ?? null;
  }, [tcCase]);

  const photosReady = selectedIds.size > 0;
  const manualReadyCount = Object.values(checklist).filter(Boolean).length;
  const readyCount = manualReadyCount + (photosReady ? 1 : 0);
  const totalChecks = Object.keys(checklist).length + 1;

  function toggleCheck(key: keyof typeof checklist) {
    setChecklist((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (notFound || (!tcCase && !loadError)) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <SearchX size={32} className="text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            Case not found
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            This case doesn't exist for the selected office.
          </p>
          <Button asChild variant="outline">
            <Link href="/tc">
              <ArrowLeft size={14} />
              Back to cases
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!tcCase) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        </div>
      </div>
    );
  }

  const contactPrefLine =
    tcCase.contactPreference !== null
      ? `Prefers: ${tcCase.contactPreference} · Best time: ${tcCase.bestTimeToReach || "Any"}`
      : null;

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link href={`/tc/cases/${caseId}`} aria-label="Back to case">
              <ArrowLeft className="w-4 h-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
              Consult Prep
            </h1>
            <p className="text-xs text-muted-foreground">Review before entering the room</p>
          </div>
        </div>
        <Button asChild size="lg" className="gap-2 text-sm font-semibold">
          <Link href={`/tc/present/${caseId}`}>
            <Presentation className="w-4 h-4" />
            Enter Presentation Mode
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Patient brief */}
        <div className="lg:col-span-2 space-y-4">
          {/* Patient card */}
          <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold bg-primary text-primary-foreground shrink-0">
                {initials(tcCase.patientName)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                    {tcCase.patientName}
                  </h2>
                  <UrgencyBadge urgency={tcCase.urgency} />
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p>
                    {[tcCase.caseType || null, tcCase.doctorName || null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {(tcCase.patientAge !== null || tcCase.phone) && (
                    <p>
                      {[
                        tcCase.patientAge !== null ? `Age ${tcCase.patientAge}` : null,
                        tcCase.phone,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  {contactPrefLine && <p>{contactPrefLine}</p>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  {formatCents(tcCase.caseValueCents)}
                </div>
                <div className="text-[10px] text-muted-foreground">case value</div>
              </div>
            </div>
          </div>

          {/* Financial summary */}
          <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
              Financial Summary
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 rounded-lg bg-muted/50">
                <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  {formatCents(totals.fee)}
                </div>
                <div className="text-[10px] text-muted-foreground">Total Treatment</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-emerald-100/60 dark:bg-emerald-950/40">
                <div className="text-lg font-bold text-emerald-700 dark:text-emerald-300" style={{ fontFamily: "Sora, sans-serif" }}>
                  {formatCents(totals.insurance)}
                </div>
                <div className="text-[10px] text-muted-foreground">Insurance Est.</div>
              </div>
              <div className="text-center p-3 rounded-lg bg-primary/10">
                <div className="text-lg font-bold text-primary" style={{ fontFamily: "Sora, sans-serif" }}>
                  {formatCents(totals.patient)}
                </div>
                <div className="text-[10px] text-muted-foreground">Patient Portion</div>
              </div>
            </div>
            {financingChips.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-xs text-muted-foreground mb-1.5">Financing options available:</p>
                <div className="flex flex-wrap gap-2">
                  {financingChips.map((opt) => (
                    <span
                      key={`${opt.providerKey}-${opt.months}-${opt.isPromo}`}
                      className="text-xs px-2 py-1 rounded-full bg-muted font-medium text-foreground"
                    >
                      {opt.providerLabel}: {formatCents(opt.monthlyCents)}/mo
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Treatment plan */}
          <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-foreground mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
              Treatment Plan ({tcCase.phases.length} phase{tcCase.phases.length === 1 ? "" : "s"})
            </h3>
            {tcCase.phases.length === 0 ? (
              <p className="text-xs text-muted-foreground">No phases on this case yet.</p>
            ) : (
              <div className="space-y-2">
                {tcCase.phases.map((phase, idx) => (
                  <div key={phase.phaseId} className="flex items-center gap-3 p-3 rounded-lg border border-border">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold bg-primary text-primary-foreground shrink-0">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-foreground">{phase.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {phase.items.length} item{phase.items.length === 1 ? "" : "s"}
                        {phase.description ? ` · ${phase.description}` : ""}
                      </div>
                    </div>
                    <div className="text-xs font-bold text-foreground shrink-0">
                      {formatCents(phase.items.reduce((s, i) => s + i.feeCents, 0))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Before & After */}
          <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2" style={{ fontFamily: "Sora, sans-serif" }}>
                <ImageIcon className="w-4 h-4 text-primary" />
                Before &amp; After Cases
              </h3>
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1.5"
                onClick={() => setPickerOpen(true)}
              >
                <SearchIcon className="w-3 h-3" />
                Browse Gallery
              </Button>
            </div>

            {/* Selected filmstrip */}
            {selectedCases.length > 0 && (
              <div className="flex gap-3 overflow-x-auto pb-2 mb-3">
                {selectedCases.map((g) => (
                  <div
                    key={g.galleryId}
                    className="relative shrink-0 rounded-lg border border-border overflow-hidden w-40"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSelected(g.galleryId)}
                      aria-label={`Remove ${g.title}`}
                      className="absolute top-1 right-1 z-10 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                    <TcMediaPair
                      office={office}
                      beforeKey={g.beforeBlobKey}
                      afterKey={g.afterBlobKey}
                      beforeLabel="Before"
                      afterLabel="After"
                      altBase={g.title}
                      heightClass="h-16"
                    />
                    <div className="px-2 py-1.5">
                      <div className="text-[10px] font-semibold truncate text-foreground">{g.title}</div>
                      <div className="text-[9px] text-muted-foreground truncate">{g.category}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Suggested for this case */}
            {suggested.length > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground font-medium mb-2 uppercase tracking-wide">
                  Suggested for this case
                </p>
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {suggested.slice(0, 4).map((g) => (
                    <div
                      key={g.galleryId}
                      className="relative shrink-0 rounded-lg border border-border overflow-hidden w-40"
                    >
                      <TcMediaPair
                        office={office}
                        beforeKey={g.beforeBlobKey}
                        afterKey={g.afterBlobKey}
                        beforeLabel="Before"
                        afterLabel="After"
                        altBase={g.title}
                        heightClass="h-16"
                      />
                      <div className="px-2 py-1.5 flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="text-[10px] font-semibold truncate text-foreground">{g.title}</div>
                          <div className="text-[9px] text-muted-foreground truncate">{g.category}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleSelected(g.galleryId)}
                          className="shrink-0 ml-1 p-1 rounded-md hover:bg-muted transition-colors"
                          title="Add to presentation prep"
                        >
                          <PlusIcon className="w-3.5 h-3.5 text-primary" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedCases.length === 0 && suggested.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">
                No cases selected. Browse the gallery to add before &amp; after photos.
              </p>
            )}
          </div>

          {/* Known concerns */}
          {(lastObjection || tcCase.notes) && (
            <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2" style={{ fontFamily: "Sora, sans-serif" }}>
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                Known Concerns
              </h3>
              {lastObjection && (
                <div className="objection-card mb-3">
                  <span className="text-xs font-semibold capitalize text-foreground">
                    {lastObjection.category.replace(/_/g, " ")}
                  </span>
                  {(lastObjection.note || lastObjection.patientWords) && (
                    <p className="text-xs mt-0.5 text-muted-foreground">
                      {lastObjection.note || lastObjection.patientWords}
                    </p>
                  )}
                </div>
              )}
              {tcCase.notes && (
                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {tcCase.notes}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Right: checklist + key info */}
        <div className="space-y-4">
          {/* Prep checklist */}
          <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                Prep Checklist
              </h3>
              <span className="text-xs text-muted-foreground">
                {readyCount}/{totalChecks}
              </span>
            </div>
            <div className="space-y-2">
              {(
                [
                  { key: "reviewedPlan" as const, label: "Treatment plan reviewed" },
                  { key: "financingReady" as const, label: "Financing options ready" },
                  { key: "insuranceVerified" as const, label: "Insurance verified" },
                ]
              ).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleCheck(key)}
                  className="flex items-center gap-2.5 w-full text-left p-2 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  {checklist[key] ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  ) : (
                    <Circle className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span
                    className={`text-xs font-medium ${checklist[key] ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {label}
                  </span>
                </button>
              ))}

              {/* Derived photos item — opens the gallery picker */}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-2.5 w-full text-left p-2 rounded-lg hover:bg-muted/50 transition-colors"
              >
                {photosReady ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                ) : (
                  <Circle className="w-4 h-4 text-muted-foreground shrink-0" />
                )}
                <span
                  className={`text-xs font-medium ${photosReady ? "text-foreground" : "text-muted-foreground"}`}
                >
                  Before/after photos loaded{photosReady ? ` (${selectedIds.size})` : ""}
                </span>
              </button>
            </div>
            {readyCount === totalChecks && (
              <div className="mt-3 p-2.5 rounded-lg text-center bg-emerald-100/60 dark:bg-emerald-950/40">
                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  Ready to present!
                </p>
              </div>
            )}
          </div>

          {/* Key motivators */}
          {tcCase.keyMotivators.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2" style={{ fontFamily: "Sora, sans-serif" }}>
                <Heart className="w-4 h-4 text-chart-2" />
                Key Motivators
              </h3>
              <div className="space-y-1.5">
                {tcCase.keyMotivators.map((m, i) => (
                  <div key={i} className="text-xs flex items-start gap-2 text-foreground">
                    <span className="mt-0.5 shrink-0 text-chart-2">•</span>
                    {m}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Decision makers */}
          {tcCase.decisionMakers && (
            <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2" style={{ fontFamily: "Sora, sans-serif" }}>
                <User className="w-4 h-4 text-muted-foreground" />
                Decision Makers
              </h3>
              <p className="text-xs text-foreground">{tcCase.decisionMakers}</p>
            </div>
          )}

          {/* Quick actions */}
          <div className="space-y-2">
            <Button asChild className="w-full gap-2 font-semibold">
              <Link href={`/tc/present/${caseId}`}>
                <Presentation className="w-4 h-4" />
                Enter Presentation Mode
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full gap-2 text-xs">
              <Link href={`/tc/cases/${caseId}`}>
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Case View
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <GalleryPicker
        office={office}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        gallery={gallery}
        selectedIds={selectedIds}
        onToggle={toggleSelected}
      />
    </div>
  );
}
