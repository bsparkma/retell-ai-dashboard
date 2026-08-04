/**
 * /tc/present/:caseId — full-screen patient-facing presentation deck.
 *
 * The layout renders this route chrome-free; the page owns the whole screen.
 * Patient-facing rules: big type, warm wording, no statuses/urgency/internal
 * jargon, money only on the Investment slide, and NO insurance snapshot (the
 * legacy OD pull is omitted entirely — patients never see disabled buttons).
 *
 * The Before/After slide only appears when gallery images actually preload
 * through the tcMediaUrl proxy — a patient never sees a broken-media slide.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOffice } from "@/contexts/OfficeContext";
import type { OfficeId, TcCase, TcCasePhase, TcGalleryCase } from "@shared/tc/contract";
import { useTcOffice } from "@/features/tc/components/TcShell";
import {
  getCase,
  getLibrary,
  listGallery,
  tcErrorMessage,
  tcMediaUrl,
  type TcLibrary,
} from "@/features/tc/api";
import {
  cashDiscountCents,
  financingOptionsCents,
  type MonthlyOptionCents,
} from "@/features/tc/lib/financing";
import {
  BeforeAfterSlide,
  casePatientPortionCents,
  ClosingSlide,
  InvestmentSlide,
  PhaseDetailSlide,
  pickPresentationOptions,
  PlanOverviewSlide,
  WelcomeSlide,
} from "@/features/tc/present/slides";

const MAX_GALLERY_PAIRS = 6;

type Slide =
  | { kind: "welcome" }
  | { kind: "plan" }
  | { kind: "phase"; phase: TcCasePhase; index: number }
  | { kind: "investment" }
  | { kind: "beforeAfter" }
  | { kind: "closing" };

/** Resolve to the gallery case iff BOTH of its images load through the proxy. */
function verifyPair(office: OfficeId, g: TcGalleryCase): Promise<TcGalleryCase | null> {
  const loadOne = (key: string) =>
    new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = tcMediaUrl(office, key);
    });
  return Promise.all([loadOne(g.beforeBlobKey), loadOne(g.afterBlobKey)]).then(
    ([before, after]) => (before && after ? g : null),
  );
}

export default function TcPresentation() {
  const office = useTcOffice();
  const { offices } = useOffice();
  const params = useParams<{ caseId: string }>();
  const caseId = params.caseId ?? "";
  const [, setLocation] = useLocation();

  const [caseData, setCaseData] = useState<TcCase | null>(null);
  const [library, setLibrary] = useState<TcLibrary>({});
  const [pairs, setPairs] = useState<TcGalleryCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slide, setSlide] = useState(0);

  const practiceName = useMemo(() => {
    if (!office) return "our practice";
    return offices.find((o) => o.officeId === office)?.officeName ?? "our practice";
  }, [offices, office]);

  // Case + library (essential) — a failure here blocks the deck.
  useEffect(() => {
    if (!office || !caseId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([getCase(office, caseId), getLibrary(office)])
      .then(([c, lib]) => {
        if (cancelled) return;
        setCaseData(c);
        setLibrary(lib);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(tcErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [office, caseId]);

  // Gallery (optional) — failures or broken media simply skip the slide.
  useEffect(() => {
    if (!office) return;
    let cancelled = false;
    listGallery(office)
      .then((gallery) =>
        Promise.all(gallery.slice(0, MAX_GALLERY_PAIRS).map((g) => verifyPair(office, g))),
      )
      .then((verified) => {
        if (!cancelled) {
          setPairs(verified.filter((g): g is TcGalleryCase => g !== null));
        }
      })
      .catch(() => {
        if (!cancelled) setPairs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  const slides = useMemo<Slide[]>(() => {
    if (!caseData) return [];
    const list: Slide[] = [{ kind: "welcome" }, { kind: "plan" }];
    caseData.phases.forEach((phase, index) => list.push({ kind: "phase", phase, index }));
    list.push({ kind: "investment" });
    if (pairs.length > 0) list.push({ kind: "beforeAfter" });
    list.push({ kind: "closing" });
    return list;
  }, [caseData, pairs]);

  // Investment inputs — money in integer cents, providers/config from the
  // server-owned library. No providers configured → no monthly options.
  const totalCents = useMemo(() => (caseData ? casePatientPortionCents(caseData) : 0), [caseData]);
  const monthlyOptions = useMemo<MonthlyOptionCents[]>(() => {
    const providers = library.financing_providers;
    if (!providers || providers.length === 0 || totalCents <= 0) return [];
    return pickPresentationOptions(
      financingOptionsCents(totalCents, providers, library.financing_settings ?? null),
    );
  }, [library, totalCents]);
  const cash = useMemo(
    () => cashDiscountCents(totalCents, library.financing_config ?? null),
    [library, totalCents],
  );

  const exit = useCallback(() => {
    setLocation(caseId ? `/tc/cases/${caseId}` : "/tc");
  }, [setLocation, caseId]);

  const slideCount = slides.length;
  const next = useCallback(
    () => setSlide((s) => Math.min(s + 1, Math.max(slideCount - 1, 0))),
    [slideCount],
  );
  const prev = useCallback(() => setSlide((s) => Math.max(s - 1, 0)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, exit]);

  // ── Gate / loading / error states (after all hooks) ───────────────────────

  if (!office || !caseId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <p className="text-lg text-muted-foreground">
          Open this presentation from a case.
        </p>
        <Link href="/tc" className="text-primary font-medium hover:underline">
          Back to Treatment Coordinator
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center gap-2 bg-background text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" /> Preparing your presentation…
      </div>
    );
  }

  if (loadError || !caseData) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <p className="text-lg text-muted-foreground">
          {loadError ?? "We couldn't load this case."}
        </p>
        <Link href="/tc" className="text-primary font-medium hover:underline">
          Back to Treatment Coordinator
        </Link>
      </div>
    );
  }

  const current = slides[slide] ?? slides[0];
  const progress = slideCount > 0 ? ((slide + 1) / slideCount) * 100 : 0;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 sm:px-8 py-4 border-b border-border bg-card">
        <span
          className="text-sm font-semibold text-foreground"
          style={{ fontFamily: "Outfit, sans-serif" }}
        >
          {practiceName}
        </span>
        <div className="flex items-center gap-4">
          <span className="text-xs text-muted-foreground tabular-nums">
            {slide + 1} / {slideCount}
          </span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={exit} aria-label="Close presentation">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Progress */}
      <div className="h-1 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Slide */}
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center px-6 sm:px-10 py-10">
          {current?.kind === "welcome" && (
            <WelcomeSlide
              patientName={caseData.patientName}
              practiceName={practiceName}
              doctorName={caseData.doctorName}
            />
          )}
          {current?.kind === "plan" && <PlanOverviewSlide tcCase={caseData} />}
          {current?.kind === "phase" && (
            <PhaseDetailSlide
              phase={current.phase}
              index={current.index}
              total={caseData.phases.length}
            />
          )}
          {current?.kind === "investment" && (
            <InvestmentSlide totalCents={totalCents} options={monthlyOptions} cash={cash} />
          )}
          {current?.kind === "beforeAfter" && <BeforeAfterSlide office={office} pairs={pairs} />}
          {current?.kind === "closing" && <ClosingSlide practiceName={practiceName} />}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between px-6 sm:px-8 py-4 border-t border-border bg-card">
        <Button variant="outline" onClick={prev} disabled={slide === 0} className="gap-1.5">
          <ChevronLeft className="w-4 h-4" /> Back
        </Button>
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Slides">
          {slides.map((s, i) => (
            <button
              key={`${s.kind}-${i}`}
              type="button"
              aria-label={`Go to slide ${i + 1}`}
              onClick={() => setSlide(i)}
              className={`h-2 rounded-full transition-all duration-200 ${
                i === slide ? "w-5 bg-primary" : "w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50"
              }`}
            />
          ))}
        </div>
        <Button onClick={next} disabled={slide >= slideCount - 1} className="gap-1.5">
          Next <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
