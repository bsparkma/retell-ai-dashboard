/**
 * Value engineering — crown material alternatives priced from the office's OWN
 * configured crown_pricing library section.
 *
 * Honesty-debt fix: the legacy panel (TC-app CaseView.tsx:1466-1551) invented
 * dollar figures with hardcoded "typical fee schedule" multipliers. Here the
 * panel renders NOTHING unless (a) the case actually contains crown items and
 * (b) the office has configured crown pricing — and every number shown is the
 * office's configured price, labeled as such.
 */
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { LibraryCrownPricing, OfficeId, TcCase, TcCaseItem } from "@shared/tc/contract";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Layers } from "lucide-react";
import { getLibrarySection, TcApiError } from "../api";
import { formatCents } from "../money";

type CrownPricing = z.infer<typeof LibraryCrownPricing>;

const CROWN_CODES = [
  "d2740",
  "d2750",
  "d2751",
  "d2752",
  "d2790",
  "d2720",
  "d2721",
  "d2722",
];

export function isCrownItem(item: TcCaseItem): boolean {
  if (item.procedureName.toLowerCase().includes("crown")) return true;
  const desc = item.patientDescription.toLowerCase();
  return CROWN_CODES.some((code) => desc.includes(code));
}

const TIERS: { key: keyof CrownPricing; label: string }[] = [
  { key: "economyCents", label: "Economy" },
  { key: "standardCents", label: "Standard" },
  { key: "premiumCents", label: "Premium" },
  { key: "implantCents", label: "Implant" },
];

export interface ValueEngineeringPanelProps {
  office: OfficeId;
  tcCase: TcCase;
}

export function ValueEngineeringPanel({ office, tcCase }: ValueEngineeringPanelProps) {
  const crownItems = tcCase.phases.flatMap((p) => p.items).filter(isCrownItem);
  const [pricing, setPricing] = useState<CrownPricing | null>(null);

  const hasCrowns = crownItems.length > 0;
  useEffect(() => {
    if (!hasCrowns) return;
    let cancelled = false;
    getLibrarySection(office, "crown_pricing")
      .then((value) => {
        if (!cancelled) setPricing(value);
      })
      .catch((e: unknown) => {
        // 404 = section unconfigured → honest silence. Any other failure also
        // renders nothing: this panel never guesses prices.
        if (!cancelled && !(e instanceof TcApiError && e.status === 404)) setPricing(null);
      });
    return () => {
      cancelled = true;
    };
  }, [office, hasCrowns]);

  if (!hasCrowns || !pricing) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold inline-flex items-center gap-2">
            <Layers size={16} className="text-muted-foreground" />
            Value engineering — crown materials
          </CardTitle>
          <span className="text-xs text-muted-foreground">Configured practice pricing</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {crownItems.map((item) => (
          <div key={item.itemId} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-sm font-medium text-foreground">
                {item.tooth && <span className="text-muted-foreground mr-1.5">#{item.tooth}</span>}
                {item.procedureName}
              </div>
              <div className="text-sm text-muted-foreground">
                Current fee: <span className="font-semibold text-foreground">{formatCents(item.feeCents)}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {TIERS.map((tier) => {
                const tierCents = pricing[tier.key];
                const savingsCents = item.feeCents - tierCents;
                return (
                  <div key={tier.key} className="rounded-md bg-muted/50 p-2 text-center">
                    <div className="text-xs text-muted-foreground">{tier.label}</div>
                    <div className="text-sm font-semibold text-foreground">
                      {formatCents(tierCents)}
                    </div>
                    {savingsCents > 0 && (
                      <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        Save {formatCents(savingsCents)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
