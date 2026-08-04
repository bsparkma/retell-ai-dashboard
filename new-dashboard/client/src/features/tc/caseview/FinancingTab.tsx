/**
 * Financing tab — read-only monthly-payment presentation computed from the
 * server-owned library config (financing_providers + financing_settings +
 * financing_config). No float math in this file: everything routes through
 * lib/financing.ts and renders via formatCents.
 *
 * Honesty-debt fix: the legacy hardcoded 5% cash discount is dead — the cash
 * line renders ONLY when the office enabled it in financing_config.
 */
import { useEffect, useMemo, useState } from "react";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Banknote, CreditCard } from "lucide-react";
import { getLibrary, tcErrorMessage } from "../api";
import type { TcLibrary } from "../api";
import {
  cashDiscountCents,
  financingOptionsCents,
  serviceFeeCents,
} from "../lib/financing";
import type { MonthlyOptionCents } from "../lib/financing";
import { formatCents, formatCentsExact } from "../money";
import { cn } from "@/lib/utils";

export interface FinancingTabProps {
  office: OfficeId;
  tcCase: TcCase;
}

/** Patient portion = sum of item patientPortionCents; caseValueCents fallback. */
export function patientPortionCentsOf(tcCase: TcCase): number {
  const items = tcCase.phases.flatMap((p) => p.items);
  if (items.length === 0) return tcCase.caseValueCents;
  return items.reduce((sum, i) => sum + i.patientPortionCents, 0);
}

export function FinancingTab({ office, tcCase }: FinancingTabProps) {
  const [library, setLibrary] = useState<TcLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLibrary(null);
    setLoadError(null);
    getLibrary(office)
      .then((lib) => {
        if (!cancelled) setLibrary(lib);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(tcErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  const portionCents = patientPortionCentsOf(tcCase);

  const providers = library?.financing_providers;
  const settings = library?.financing_settings ?? null;
  const config = library?.financing_config ?? null;

  const options = useMemo(
    () => (providers ? financingOptionsCents(portionCents, providers, settings) : []),
    [providers, settings, portionCents],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; options: MonthlyOptionCents[] }>();
    for (const opt of options) {
      const entry = map.get(opt.providerKey) ?? { label: opt.providerLabel, options: [] };
      entry.options.push(opt);
      map.set(opt.providerKey, entry);
    }
    return Array.from(map.entries());
  }, [options]);

  if (loadError) {
    return <p className="text-sm text-red-600 dark:text-red-400 py-6">{loadError}</p>;
  }

  if (!library) {
    return (
      <div className="space-y-3 py-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  const fee = serviceFeeCents(portionCents, config);
  const cash = cashDiscountCents(portionCents, config);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Patient portion</div>
            <div
              className="text-2xl font-bold text-foreground"
              style={{ fontFamily: "Outfit, sans-serif" }}
            >
              {formatCents(portionCents)}
            </div>
          </div>
          <div className="space-y-1 text-sm text-right">
            {fee.enabled && (
              <div className="text-muted-foreground">
                Service fee ({fee.percent}%): {formatCentsExact(fee.feeCents)} · total with fee{" "}
                <span className="font-medium text-foreground">
                  {formatCentsExact(fee.totalWithFeeCents)}
                </span>
              </div>
            )}
            {cash.enabled && (
              <div className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <Banknote size={14} />
                Pay in full: {formatCentsExact(cash.discountedCents)} ({cash.percent}% off — save{" "}
                {formatCentsExact(cash.savingsCents)})
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {!providers ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <CreditCard size={24} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            Financing providers not configured — set them up in Library.
          </p>
        </div>
      ) : grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No financing options available for this amount.
        </p>
      ) : (
        grouped.map(([providerKey, group]) => (
          <Card key={providerKey}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">{group.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {group.options.map((opt) => (
                  <div
                    key={`${opt.providerKey}-${opt.months}-${opt.isPromo ? "p" : "r"}`}
                    className={cn(
                      "rounded-lg border border-border p-3",
                      !opt.eligible && "opacity-50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs text-muted-foreground">{opt.months} mo</span>
                      {opt.isPromo && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        >
                          Promo
                        </Badge>
                      )}
                    </div>
                    <div className="text-lg font-bold text-foreground">
                      {formatCentsExact(opt.monthlyCents)}
                      <span className="text-xs font-normal text-muted-foreground">/mo</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {opt.apr}% APR · total {formatCents(opt.totalCents)}
                    </div>
                    {!opt.eligible && (
                      <div className="text-[11px] text-muted-foreground mt-1">
                        Requires at least {formatCents(opt.minAmountCents)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
