/**
 * Dashboard card: how much unscheduled treatment is waiting (item 41).
 *
 * REAL ROWS ONLY. The count and the dollar figure are the inbox's own `new`
 * totals, summed across the offices in scope — no estimate, no seed data. An
 * office that has never synced contributes nothing and the card says so
 * rather than showing a reassuring zero.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Loader2, Telescope } from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import { fanOutOfficeValues } from "../officeScope";
import { formatCents, listOpportunities } from "./opportunitiesApi";

type CardState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; count: number; valueCents: number; neverSynced: boolean };

export function OpportunitiesCard({ offices }: { offices: OfficeId[] }) {
  const [state, setState] = useState<CardState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    void fanOutOfficeValues(offices, (o) => listOpportunities(o, "new")).then((result) => {
      if (!alive) return;
      if (result.values.length === 0) {
        setState({ kind: "error" });
        return;
      }
      let count = 0;
      let valueCents = 0;
      let neverSynced = true;
      for (const { value } of result.values) {
        count += value.totals.count;
        valueCents += value.totals.valueCents;
        if (value.sync && value.sync.lastSyncedAt) neverSynced = false;
      }
      setState({ kind: "ready", count, valueCents, neverSynced });
    });
    return () => {
      alive = false;
    };
  }, [offices]);

  return (
    <section
      aria-label="Opportunities"
      className="w-full bg-card rounded-xl border border-border shadow-sm overflow-hidden"
      data-testid="opportunities-card"
    >
      <div className="flex items-center gap-3 p-4">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Telescope className="w-4 h-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            Unscheduled treatment
          </h2>
          {state.kind === "loading" && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mt-1" />}
          {state.kind === "error" && (
            <p className="text-xs text-muted-foreground mt-1">Couldn't load opportunities.</p>
          )}
          {state.kind === "ready" &&
            (state.neverSynced && state.count === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">
                Not synced from Open Dental yet — nothing to show until the nightly sync runs.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                <span className="text-lg font-bold text-foreground mr-1">{state.count}</span>
                {state.count === 1 ? "patient" : "patients"} ·{" "}
                <span className="font-semibold text-foreground">{formatCents(state.valueCents)}</span>{" "}
                diagnosed and not on the schedule
              </p>
            ))}
        </div>
        <Link href="/tc/opportunities" className="text-xs font-medium text-primary inline-flex items-center gap-1 shrink-0">
          Open <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </section>
  );
}
