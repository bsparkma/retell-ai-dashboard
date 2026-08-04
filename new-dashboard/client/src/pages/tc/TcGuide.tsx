/**
 * /tc/guide — TC Guide: discovery questions, objection scripts, education
 * library, and the follow-up playbook. Ported 1:1 from DentaFlow's TCGuide
 * page; fully static coaching content (no office gate, no API calls). All
 * content lives in features/tc/guide/content.ts; legacy hardcoded oklch teal
 * is replaced with semantic tokens so dark mode works.
 */
import { useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Clock,
  DollarSign,
  Heart,
  HelpCircle,
  Mail,
  MessageSquare,
  Phone,
  Star,
  Users,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TcPageHeader } from "@/features/tc/components/TcShell";
import {
  CADENCE_TIERS,
  CONSULT_FLOW_STEPS,
  CONTACT_METHODS,
  DISCOVERY_QUESTIONS,
  EDUCATION_LIBRARY,
  LOST_REASONS,
  OBJECTION_FOLLOWUPS,
  OBJECTION_KEYS,
  OBJECTION_RESPONSES,
  type CadenceAccent,
  type ContactMethodIcon,
  type ObjectionFollowupIcon,
  type ObjectionKey,
} from "@/features/tc/guide/content";

// Legacy accents (green/teal/coral literals) mapped onto theme tokens so the
// tiers stay legible in dark mode.
const CADENCE_ACCENT: Record<CadenceAccent, { dot: string; text: string }> = {
  green: { dot: "bg-chart-5", text: "text-chart-5" },
  teal: { dot: "bg-primary", text: "text-primary" },
  coral: { dot: "bg-accent-coral", text: "text-accent-coral" },
};

const FOLLOWUP_ICONS: Record<ObjectionFollowupIcon, React.ElementType> = {
  dollar: DollarSign,
  users: Users,
  heart: Heart,
  alert: AlertTriangle,
};

const CONTACT_ICONS: Record<ContactMethodIcon, React.ElementType> = {
  phone: Phone,
  text: MessageSquare,
  email: Mail,
};

export default function TcGuide() {
  const [selectedObjection, setSelectedObjection] = useState<ObjectionKey | null>(null);
  const objection = selectedObjection !== null ? OBJECTION_RESPONSES[selectedObjection] : null;

  return (
    <div className="p-6 space-y-5">
      <TcPageHeader
        title="TC Guide"
        subtitle="Discovery questions, objection scripts, education library, and follow-up playbook"
      />

      <Tabs defaultValue="discovery">
        <TabsList className="bg-muted/50">
          <TabsTrigger value="discovery">Discovery Questions</TabsTrigger>
          <TabsTrigger value="objections">Objection Handling</TabsTrigger>
          <TabsTrigger value="education">Education Library</TabsTrigger>
          <TabsTrigger value="playbook">Follow-Up Playbook</TabsTrigger>
        </TabsList>

        {/* ── Discovery Questions ─────────────────────────────────────────── */}
        <TabsContent value="discovery" className="mt-4 space-y-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">Consult Discovery Questions</h2>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Use these questions at the start of every TC consult to uncover the patient's real motivators and concerns.
              Listen more than you talk.
            </p>
            <div className="space-y-3">
              {DISCOVERY_QUESTIONS.map((q, i) => (
                <div key={i} className="rounded-lg border border-border p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-primary text-primary-foreground shrink-0">
                      {i + 1}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">"{q.question}"</p>
                      <p className="text-xs text-muted-foreground mt-1">Purpose: {q.purpose}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="tc-script-card">
            <div className="text-xs font-semibold mb-2 text-primary">TC CONSULT FLOW</div>
            <div className="space-y-2 text-sm text-primary">
              {CONSULT_FLOW_STEPS.map((step, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="font-bold shrink-0">{i + 1}.</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* ── Objection Handling ──────────────────────────────────────────── */}
        <TabsContent value="objections" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Select Objection
              </h2>
              {OBJECTION_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedObjection(key)}
                  className={`w-full text-left p-3 rounded-lg border transition-all text-sm font-medium ${
                    selectedObjection === key
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-border text-foreground hover:border-primary/40 bg-card"
                  }`}
                >
                  {OBJECTION_RESPONSES[key].title}
                </button>
              ))}
            </div>

            <div className="lg:col-span-2">
              {objection ? (
                <div className="space-y-4">
                  <h2 className="text-lg font-bold">{objection.title}</h2>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                      Response Scripts
                    </div>
                    <div className="space-y-3">
                      {objection.scripts.map((script, i) => (
                        <div key={i} className="tc-script-card">
                          <p className="text-sm italic text-primary">"{script}"</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                      TC Tips
                    </div>
                    <div className="space-y-2">
                      {objection.tips.map((tip, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm text-foreground">
                          <Star className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                          {tip}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-sm">
                  <HelpCircle className="w-8 h-8 mb-2 opacity-30" />
                  Select an objection to see scripts and tips
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ── Education Library ───────────────────────────────────────────── */}
        <TabsContent value="education" className="mt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {EDUCATION_LIBRARY.map((item) => (
              <div
                key={item.id}
                className="bg-card rounded-xl border border-border p-4 hover:shadow-md transition-shadow cursor-pointer"
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-3 bg-primary/10">
                  <BookOpen className="w-[18px] h-[18px] text-primary" />
                </div>
                <div className="text-sm font-semibold mb-1">{item.title}</div>
                <div className="text-xs text-muted-foreground">{item.description}</div>
                <div className="mt-3">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                    {item.category}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* ── Follow-Up Playbook ──────────────────────────────────────────── */}
        <TabsContent value="playbook" className="mt-4 space-y-5">
          {/* Intro card */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">Adaptive Follow-Up System</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Follow-up cadence is automatically generated based on case value, urgency, and the patient's primary objection.
              The system adapts — higher-value cases get more touches, and objection type changes the messaging approach.
            </p>
          </div>

          {/* Cadence Tiers */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {CADENCE_TIERS.map((t) => {
              const accent = CADENCE_ACCENT[t.accent];
              return (
                <div key={t.tier} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${accent.dot}`} />
                    <h3 className="text-sm font-semibold">{t.tier}</h3>
                  </div>
                  <div className={`text-xs font-medium mb-1 ${accent.text}`}>{t.range}</div>
                  <div className="text-[10px] text-muted-foreground mb-3">{t.touches}</div>
                  <div className="space-y-1.5">
                    {t.schedule.map((step, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-foreground">
                        <div className={`w-1 h-1 rounded-full mt-1.5 shrink-0 ${accent.dot}`} />
                        {step}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Objection-Based Messaging */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold mb-4">How Objections Shape Follow-Up</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {OBJECTION_FOLLOWUPS.map((obj) => {
                const Icon = FOLLOWUP_ICONS[obj.icon];
                return (
                  <div key={obj.objection} className="rounded-lg border border-border p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="w-3.5 h-3.5 text-primary" />
                      <h3 className="text-xs font-semibold">{obj.objection}</h3>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">{obj.approach}</p>
                    <div className="tc-script-card">
                      <p className="text-xs italic text-primary">{obj.firstTouch}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Long-Tail Mode */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-accent-coral" />
              <h2 className="text-sm font-semibold">Long-Tail Nurture (No Abyss Rule)</h2>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              After the active cadence completes, cases enter long-tail mode with reminders every 2 weeks.
              Cases stay in the pipeline until explicitly marked as <strong>Accepted</strong> or <strong>Lost</strong>.
              No patient falls into the abyss.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {LOST_REASONS.map((reason) => (
                <div key={reason.label} className="rounded-lg border border-border p-3 text-center">
                  <div className="text-xs font-semibold text-foreground">{reason.label}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{reason.desc}</div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-3 italic">
              When marking a case as Lost, always select a reason — this data feeds your conversion reports.
            </p>
          </div>

          {/* Contact Best Practices */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold mb-3">Contact Method Best Practices</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {CONTACT_METHODS.map((m) => {
                const Icon = CONTACT_ICONS[m.icon];
                return (
                  <div key={m.method} className="rounded-lg border border-border p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="w-3.5 h-3.5 text-primary" />
                      <h3 className="text-xs font-semibold">{m.method}</h3>
                    </div>
                    <div className="text-[10px] font-medium mb-2 text-primary">Best for: {m.when}</div>
                    <div className="space-y-1">
                      {m.tips.map((tip, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <Star className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                          {tip}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
