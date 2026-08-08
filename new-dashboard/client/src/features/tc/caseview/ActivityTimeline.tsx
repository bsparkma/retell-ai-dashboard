/**
 * Activity timeline — case events newest-first with a type icon, description,
 * actor and timestamp. contact_attempt and voice_handoff events render their
 * typed detail instead of relying on free text.
 *
 * voice_handoff is the record of a call handed over from the voice module. Its
 * summary is a SNAPSHOT taken at handoff time, and its call link may 404 once
 * the voice side prunes the call row — so the link is rendered as a
 * best-effort affordance under the text that carries the meaning, never as the
 * only way to read what the call was about.
 */
import {
  isContactAttemptDetail,
  isVoiceHandoffDetail,
  type TcCaseEvent,
} from "@shared/tc/contract";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRightLeft,
  CheckCircle2,
  FilePlus2,
  Headphones,
  MessageSquareWarning,
  PhoneCall,
  Sprout,
  StickyNote,
} from "lucide-react";

type EventType = TcCaseEvent["type"];

const EVENT_META: Record<EventType, { label: string; icon: typeof StickyNote; iconClass: string }> = {
  status_change: { label: "Status change", icon: ArrowRightLeft, iconClass: "text-blue-600 dark:text-blue-400" },
  follow_up_completed: { label: "Follow-up completed", icon: CheckCircle2, iconClass: "text-emerald-600 dark:text-emerald-400" },
  objection_logged: { label: "Objection", icon: MessageSquareWarning, iconClass: "text-amber-600 dark:text-amber-400" },
  note_added: { label: "Note", icon: StickyNote, iconClass: "text-slate-500 dark:text-slate-400" },
  case_created: { label: "Case created", icon: FilePlus2, iconClass: "text-purple-600 dark:text-purple-400" },
  nurture_enrolled: { label: "Nurture enrolled", icon: Sprout, iconClass: "text-violet-600 dark:text-violet-400" },
  contact_attempt: { label: "Contact attempt", icon: PhoneCall, iconClass: "text-cyan-600 dark:text-cyan-400" },
  voice_handoff: { label: "From call", icon: Headphones, iconClass: "text-primary" },
};

const ATTEMPT_CHANNEL_LABEL = { call: "Call", text: "Text", email: "Email" } as const;
const ATTEMPT_OUTCOME_LABEL = {
  reached: "reached",
  voicemail: "voicemail",
  no_answer: "no answer",
} as const;

export interface ActivityTimelineProps {
  events: readonly TcCaseEvent[];
}

export function ActivityTimeline({ events }: ActivityTimelineProps) {
  const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts));

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground py-6">No activity yet.</p>;
  }

  return (
    <ol className="space-y-0">
      {sorted.map((event, idx) => {
        const meta = EVENT_META[event.type];
        const Icon = meta.icon;
        const attempt = event.type === "contact_attempt" && isContactAttemptDetail(event.detail)
          ? event.detail
          : null;
        const handoff = event.type === "voice_handoff" && isVoiceHandoffDetail(event.detail)
          ? event.detail
          : null;
        return (
          <li key={event.eventId} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-muted flex-shrink-0">
                <Icon size={14} className={meta.iconClass} />
              </div>
              {idx < sorted.length - 1 && <div className="w-px flex-1 bg-border my-1" />}
            </div>
            <div className="pb-5 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-foreground">{meta.label}</span>
                {attempt && (
                  <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
                    {ATTEMPT_CHANNEL_LABEL[attempt.channel]} —{" "}
                    {ATTEMPT_OUTCOME_LABEL[attempt.outcome]}
                  </Badge>
                )}
                {handoff && (
                  <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
                    {handoff.attached ? "Attached to this case" : "Opened this case"}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(event.ts).toLocaleString()}
                </span>
                {event.actor && (
                  <span className="text-xs text-muted-foreground">· {event.actor}</span>
                )}
              </div>
              {event.description && (
                <p className="text-sm text-muted-foreground mt-0.5">{event.description}</p>
              )}
              {handoff?.callSummary && (
                <p className="text-sm text-foreground mt-1 whitespace-pre-line">
                  {handoff.callSummary}
                </p>
              )}
              {handoff?.callUrl && (
                <a
                  href={handoff.callUrl}
                  className="text-xs text-primary underline underline-offset-2 mt-1 inline-block"
                >
                  Open the call
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
