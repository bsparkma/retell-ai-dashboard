/**
 * CareIN voice handoffs strip — LAYOUT PARITY ONLY (PM ruling 3).
 *
 * The legacy DentaFlow app rendered a full-width strip at the top of the
 * Dashboard (components/CareINHandoffs.tsx) that polled /api/carein/handoffs
 * every 30s, listed claimable patient rows with a live "N new" pulse badge,
 * and created a case from a claimed handoff.
 *
 * NONE of that is ported. On the platform, voice and TC finally live in the
 * same product, so a handoff is a real cross-module write (voice call → TC
 * case) that needs its own slice: an entitlement check, an office-scoped
 * source of truth, and a case-creation path that can't duplicate patients.
 * Shipping a polling loop against an endpoint that doesn't exist would be a
 * silent no-op, and rendering sample patients would be a lie.
 *
 * So this component keeps the legacy visual footprint — a full-width card at
 * the very top of the dashboard, so the page's vertical rhythm matches
 * DentaFlow's. It used to say "coming soon"; the handoff then shipped as the
 * call's Send to TC (Mango M6), and the strip kept promising it (pre-IA fix
 * F8, IA report §4 D8). It now says where those calls actually land: a case
 * owned by whoever sent it, or the patient's open case — on the Pipeline, not
 * in a list here.
 *
 * Deliberate omissions (do not "fix" these without the handoff slice):
 *   - no fetch/poll of any kind (this file imports nothing from ../api)
 *   - no counts, no badge, no patient rows, no Claim button
 *
 * It does NOT use DisabledFeatureButton/DisabledFeatureNote from TcShell:
 * the DisabledReason union (platform_email | slice5_od | slice7_ai) has no
 * value that honestly describes a cross-module handoff, and inventing a new
 * reason key would mean editing TcShell (owned elsewhere this slice). A plain
 * note in the same voice is the honest option.
 */
import { Headphones } from "lucide-react";

export function CareInHandoffsStrip() {
  return (
    <section
      aria-label="Voice handoffs"
      className="w-full bg-card rounded-xl border border-border shadow-sm overflow-hidden"
    >
      <div className="flex items-start gap-3 p-4">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Headphones className="w-4 h-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2
            className="text-sm font-semibold text-foreground"
            style={{ fontFamily: "Sora, sans-serif" }}
          >
            Voice handoffs
          </h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Calls come in from Voice with Send to TC on the call. Each one
            opens a case for the person who sent it, or joins the patient's
            open case, so you'll find it on the Pipeline rather than here.
            This strip lists nothing itself — no sample patients, no counts.
          </p>
        </div>
      </div>
    </section>
  );
}
