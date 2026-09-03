/**
 * /hyg/visit/:aptNum — the visit workspace. NOT BUILT YET.
 *
 * This route exists in slice 1 for one reason: every card on the day view is a
 * link, and a link that 404s teaches a hygienist that the app is broken. A
 * placeholder that says what it is teaches her that the app is unfinished,
 * which is true and is a much cheaper thing to believe.
 *
 * It deliberately shows the appointment number and NOTHING ELSE about the
 * patient. The day view has the name and the flags in memory, and passing them
 * through would be easy — but this page has made no request, holds no
 * entitlement check of its own, and has written no audit row. Rendering PHI it
 * did not fetch and did not record would put a patient's details on a screen
 * with no trail behind them, which is the one thing this platform's audit rule
 * exists to prevent. Slice 2 fetches the visit properly, and gets to show
 * everything.
 */
import { Link, useParams } from "wouter";
import { ArrowLeft, Construction } from "lucide-react";

export default function HygVisit() {
  const params = useParams<{ aptNum: string }>();

  return (
    <div className="p-6" data-testid="hyg-visit-placeholder">
      <Link
        href="/hyg/day"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={16} />
        Back to the day
      </Link>

      <h1
        className="mt-4 text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        Visit view ships in Slice 2
      </h1>

      <div className="mt-6 flex max-w-2xl items-start gap-3 rounded-2xl border border-dashed border-border bg-card p-5 text-sm text-muted-foreground">
        <Construction size={18} className="mt-0.5 shrink-0" />
        <div>
          <p className="text-foreground">
            Appointment{" "}
            <span className="font-mono font-medium tabular-nums">{params.aptNum}</span> is real —
            this screen is not, yet.
          </p>
          <p className="mt-2">
            Slice 2 builds the routing slip here: the tooth chart, the treatment items, the records
            each one needs, and the review before anything is sent. Slice 3 adds the send itself —
            the slip into the patient&apos;s images, and the handoff to the treatment coordinator.
          </p>
          <p className="mt-2">
            Nothing on this page has read a chart, so it deliberately shows no patient details. The
            day view is where today&apos;s information lives until then.
          </p>
        </div>
      </div>
    </div>
  );
}
