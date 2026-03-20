/**
 * AgentBuilder — Single-prompt agent builder with knowledge base
 * Build one AI agent persona with office-specific context injected into the prompt.
 */
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Bot, Save, Copy, Eye, EyeOff, Clock, MapPin, Users, Shield,
  Stethoscope, FileText, ChevronDown, ChevronRight, Plus, Trash2, RotateCcw
} from "lucide-react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeSection {
  id: string;
  title: string;
  icon: React.ElementType;
  placeholder: string;
  value: string;
}

interface AgentConfig {
  name: string;
  prompt: string;
  knowledge: KnowledgeSection[];
  customSections: { id: string; title: string; value: string }[];
  lastSaved: string | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_KNOWLEDGE: KnowledgeSection[] = [
  {
    id: "hours",
    title: "Office Hours",
    icon: Clock,
    placeholder: "Mon-Thu: 8:00 AM - 5:00 PM\nFri: 8:00 AM - 12:00 PM\nSat-Sun: Closed\n\nLunch: 12:00 PM - 1:00 PM (phones go to AI)",
    value: "",
  },
  {
    id: "locations",
    title: "Locations & Contact",
    icon: MapPin,
    placeholder: "Valley Family Dental\n1234 Main St, Fort Smith, AR 72901\nPhone: (479) 555-1234\n\nRoland Family Dental\n5678 Hwy 64, Roland, OK 74954\nPhone: (918) 555-5678",
    value: "",
  },
  {
    id: "providers",
    title: "Providers & Staff",
    icon: Users,
    placeholder: "Dr. Sparkman — General Dentistry (all locations)\nDr. Smith — Orthodontics (Valley only)\nSarah — Hygienist (Mon-Thu)\nMike — Hygienist (Tue-Fri)",
    value: "",
  },
  {
    id: "services",
    title: "Services Offered",
    icon: Stethoscope,
    placeholder: "General: cleanings, fillings, crowns, bridges, extractions\nCosmetic: veneers, whitening, bonding\nOrtho: braces, Invisalign, retainers\nEmergency: same-day for pain, swelling, trauma\nPediatric: sealants, fluoride, space maintainers",
    value: "",
  },
  {
    id: "insurance",
    title: "Insurance Accepted",
    icon: Shield,
    placeholder: "Delta Dental\nBCBS of Arkansas\nBCBS of Oklahoma\nHealthChoice OK\nCigna\nAetna\nMetLife\n\nWe also offer in-house membership plans for uninsured patients.",
    value: "",
  },
  {
    id: "policies",
    title: "Office Policies & Scheduling Rules",
    icon: FileText,
    placeholder: "New adult patient (no cleaning in 12+ months): 60 min, exam + X-rays only\nNew adult patient (on recall): 90 min, exam + X-rays + cleaning\nNew child: 60 min\nExisting adult cleaning: 60 min\nExisting child cleaning: 30 min\nEmergency: 60 min limited exam\n\n24-hour cancellation policy. $50 no-show fee after 2nd occurrence.",
    value: "",
  },
];

const DEFAULT_PROMPT = `You are a friendly, professional dental office receptionist for {{office_name}}. Your job is to help callers with scheduling, answer questions about services, and collect information for new patients.

PERSONALITY:
- Warm and welcoming, like a small-town dental office
- Speak clearly and at a comfortable pace
- Use the caller's name once you learn it
- Be empathetic about dental anxiety or pain

SCHEDULING FLOW:
For non-emergency callers, use the 2-question script:
1. "Do you prefer mornings or afternoons?"
2. "Do you prefer early in the week or later in the week?"
Then offer two specific time slots matching their preference.

For emergencies: offer the next available slot today or tomorrow.

RULES:
- Never diagnose or give medical advice
- If unsure, say "Let me have someone from our team call you back about that"
- Always confirm the appointment details before ending the call
- Collect: full name, phone number, date of birth, insurance (if any), reason for visit

The following knowledge base contains current office information. Use it to answer caller questions accurately:

{{knowledge_base}}`;

const TEMPLATES = [
  {
    name: "Inbound Scheduling",
    desc: "Full scheduling agent for incoming calls",
    prompt: DEFAULT_PROMPT,
  },
  {
    name: "Emergency Triage",
    desc: "Identify and escalate dental emergencies",
    prompt: `You are an emergency triage agent for {{office_name}}. Your primary job is to quickly assess whether a caller has a dental emergency and route them appropriately.

EMERGENCY CRITERIA (route to immediate care):
- Severe, uncontrolled pain
- Swelling in face, jaw, or neck
- Knocked-out or broken tooth (within 1 hour)
- Uncontrolled bleeding
- Suspected jaw fracture
- Abscess with fever

NON-EMERGENCY (schedule normally):
- Mild toothache
- Lost filling or crown (no pain)
- Chipped tooth (no sharp edges)
- Sensitivity to hot/cold

For emergencies: "I understand you're in pain. Let me get you in right away." Then offer the next available emergency slot.

For non-emergencies: "That sounds uncomfortable, but the good news is it's not an emergency. Let's get you scheduled soon." Then use the standard 2-question scheduling flow.

{{knowledge_base}}`,
  },
  {
    name: "New Patient Welcome",
    desc: "Warm intake for first-time callers",
    prompt: `You are a new patient coordinator for {{office_name}}. Your job is to make first-time callers feel welcome and collect their information.

GREETING: "Welcome to {{office_name}}! We're so glad you're considering us for your dental care."

COLLECT (in natural conversation, not like a form):
1. Full name
2. Date of birth
3. Phone number
4. Email (optional)
5. Insurance information (carrier + member ID)
6. Reason for visit
7. Any dental anxiety or special needs
8. How they heard about us

SCHEDULING:
- New patients with no cleaning in 12+ months: 60 min appointment (exam + X-rays only, cleaning at follow-up)
- New patients on recall: 90 min appointment (exam + X-rays + cleaning)
- New children: 60 min appointment

Always mention: "We'll send you our new patient forms by email so you can fill them out before your visit."

{{knowledge_base}}`,
  },
  {
    name: "Recall Reminder",
    desc: "Outbound reactivation for overdue patients",
    prompt: `You are making outbound recall reminder calls for {{office_name}}. Your goal is to schedule overdue patients for their cleaning.

OPENING: "Hi, this is {{office_name}} calling. We noticed it's been a while since your last visit and wanted to help get you scheduled."

APPROACH:
- Be warm, not pushy
- Acknowledge that life gets busy
- Emphasize preventive care benefits
- If they have concerns about cost, mention insurance coverage or payment plans

SCHEDULING:
Use the 2-question flow:
1. "Do you prefer mornings or afternoons?"
2. "Early in the week or later?"

If they decline: "No problem at all. If you'd like to schedule in the future, just give us a call. We'd love to see you!"

{{knowledge_base}}`,
  },
];

const STORAGE_KEY = "carein-agent-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCompiledPrompt(prompt: string, knowledge: KnowledgeSection[], customSections: { title: string; value: string }[]): string {
  const filledSections = [...knowledge.filter(s => s.value.trim()), ...customSections.filter(s => s.value.trim())];

  if (filledSections.length === 0) {
    return prompt.replace("{{knowledge_base}}", "(No knowledge base configured yet)");
  }

  const kb = filledSections
    .map(s => `## ${"title" in s ? s.title : ""}\n${s.value.trim()}`)
    .join("\n\n");

  return prompt.replace("{{knowledge_base}}", kb);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentBuilder() {
  const [config, setConfig] = useState<AgentConfig>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as AgentConfig;
        // Merge saved knowledge with defaults (in case new sections were added)
        const mergedKnowledge = DEFAULT_KNOWLEDGE.map(def => {
          const saved = parsed.knowledge?.find((s: KnowledgeSection) => s.id === def.id);
          return saved ? { ...def, value: saved.value } : def;
        });
        return { ...parsed, knowledge: mergedKnowledge };
      }
    } catch { /* ignore */ }
    return {
      name: "Rover",
      prompt: DEFAULT_PROMPT,
      knowledge: DEFAULT_KNOWLEDGE,
      customSections: [],
      lastSaved: null,
    };
  });

  const [showPreview, setShowPreview] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["hours", "locations"]));
  const [hasUnsaved, setHasUnsaved] = useState(false);

  // Track unsaved changes
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setHasUnsaved(JSON.stringify(config) !== saved);
    } else {
      setHasUnsaved(true);
    }
  }, [config]);

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateKnowledge = useCallback((id: string, value: string) => {
    setConfig(prev => ({
      ...prev,
      knowledge: prev.knowledge.map(s => s.id === id ? { ...s, value } : s),
    }));
  }, []);

  const addCustomSection = () => {
    const id = `custom_${Date.now()}`;
    setConfig(prev => ({
      ...prev,
      customSections: [...prev.customSections, { id, title: "New Section", value: "" }],
    }));
    setExpandedSections(prev => new Set([...Array.from(prev), id]));
  };

  const updateCustomSection = useCallback((id: string, field: "title" | "value", val: string) => {
    setConfig(prev => ({
      ...prev,
      customSections: prev.customSections.map(s => s.id === id ? { ...s, [field]: val } : s),
    }));
  }, []);

  const removeCustomSection = (id: string) => {
    setConfig(prev => ({
      ...prev,
      customSections: prev.customSections.filter(s => s.id !== id),
    }));
  };

  const handleSave = () => {
    const toSave = { ...config, lastSaved: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    setConfig(toSave);
    setHasUnsaved(false);
    toast.success("Agent configuration saved");
  };

  const handleCopyPrompt = () => {
    const compiled = buildCompiledPrompt(config.prompt, config.knowledge, config.customSections);
    navigator.clipboard.writeText(compiled);
    toast.success("Compiled prompt copied to clipboard");
  };

  const handleLoadTemplate = (template: typeof TEMPLATES[number]) => {
    setConfig(prev => ({ ...prev, prompt: template.prompt }));
    toast.success(`Loaded "${template.name}" template`);
  };

  const handleReset = () => {
    if (window.confirm("Reset all fields to defaults? Your current configuration will be lost.")) {
      localStorage.removeItem(STORAGE_KEY);
      setConfig({
        name: "Rover",
        prompt: DEFAULT_PROMPT,
        knowledge: DEFAULT_KNOWLEDGE,
        customSections: [],
        lastSaved: null,
      });
      setHasUnsaved(false);
      toast.success("Reset to defaults");
    }
  };

  const compiledPrompt = buildCompiledPrompt(config.prompt, config.knowledge, config.customSections);
  const filledKBCount = config.knowledge.filter(s => s.value.trim()).length + config.customSections.filter(s => s.value.trim()).length;
  const totalKBCount = config.knowledge.length + config.customSections.length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            Agent Builder
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Define your AI agent's personality and teach it about your practice
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5 text-muted-foreground">
            <RotateCcw size={13} /> Reset
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopyPrompt} className="gap-1.5">
            <Copy size={13} /> Copy Prompt
          </Button>
          <Button size="sm" onClick={handleSave} className="gap-1.5" disabled={!hasUnsaved}>
            <Save size={13} /> {hasUnsaved ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left column: Prompt + Templates */}
        <div className="xl:col-span-2 space-y-6">
          {/* Agent Name */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
                  <Bot size={22} className="text-primary" />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Agent Name</label>
                  <input
                    value={config.name}
                    onChange={(e) => setConfig(prev => ({ ...prev, name: e.target.value }))}
                    className="text-xl font-bold bg-transparent border-none outline-none text-foreground w-full mt-0.5"
                    style={{ fontFamily: "Outfit, sans-serif" }}
                    placeholder="e.g. Rover"
                  />
                </div>
                {config.lastSaved && (
                  <div className="text-xs text-muted-foreground text-right">
                    Last saved<br />
                    <span className="font-mono">{new Date(config.lastSaved).toLocaleString()}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* System Prompt */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">System Prompt</CardTitle>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-mono">{countWords(config.prompt)} words</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setShowPreview(!showPreview)}
                  >
                    {showPreview ? <EyeOff size={11} /> : <Eye size={11} />}
                    {showPreview ? "Edit" : "Preview"}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {showPreview ? (
                <div className="p-4 rounded-lg bg-muted/30 border border-border">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Compiled Prompt (sent to AI)
                  </div>
                  <pre className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-[500px] overflow-y-auto">
                    {compiledPrompt}
                  </pre>
                  <div className="mt-3 pt-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                    <span>{countWords(compiledPrompt)} words total</span>
                    <span>{filledKBCount} knowledge sections included</span>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground mb-3">
                    This defines your agent's personality and behavior. Use{" "}
                    <code className="bg-muted px-1 rounded text-xs">{"{{office_name}}"}</code> and{" "}
                    <code className="bg-muted px-1 rounded text-xs">{"{{knowledge_base}}"}</code> as placeholders.
                  </p>
                  <textarea
                    value={config.prompt}
                    onChange={(e) => setConfig(prev => ({ ...prev, prompt: e.target.value }))}
                    rows={20}
                    className="w-full p-4 text-sm rounded-lg border border-border bg-muted/30 font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary leading-relaxed"
                    placeholder="Enter your agent's system prompt..."
                  />
                </>
              )}
            </CardContent>
          </Card>

          {/* Templates */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Prompt Templates</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => handleLoadTemplate(t)}
                    className="text-left p-4 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 transition-all"
                  >
                    <div className="text-sm font-semibold text-foreground">{t.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">{t.desc}</div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right column: Knowledge Base */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Knowledge Base</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {filledKBCount}/{totalKBCount} filled
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                This info is injected into your agent's prompt so it can answer caller questions accurately.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {/* Built-in sections */}
              {config.knowledge.map((section) => {
                const Icon = section.icon;
                const isExpanded = expandedSections.has(section.id);
                const isFilled = section.value.trim().length > 0;

                return (
                  <div key={section.id} className="border border-border rounded-xl overflow-hidden">
                    <button
                      onClick={() => toggleSection(section.id)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors"
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        isFilled ? "bg-primary/15" : "bg-muted"
                      }`}>
                        <Icon size={13} className={isFilled ? "text-primary" : "text-muted-foreground"} />
                      </div>
                      <span className="text-sm font-medium text-foreground flex-1 text-left">{section.title}</span>
                      {isFilled && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: "oklch(0.65 0.18 155 / 0.15)", color: "oklch(0.45 0.18 155)" }}>
                          filled
                        </span>
                      )}
                      {isExpanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3">
                        <textarea
                          value={section.value}
                          onChange={(e) => updateKnowledge(section.id, e.target.value)}
                          placeholder={section.placeholder}
                          rows={6}
                          className="w-full p-3 text-sm rounded-lg border border-border bg-background resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary leading-relaxed"
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Custom sections */}
              {config.customSections.map((section) => {
                const isExpanded = expandedSections.has(section.id);
                const isFilled = section.value.trim().length > 0;

                return (
                  <div key={section.id} className="border border-border rounded-xl overflow-hidden">
                    <button
                      onClick={() => toggleSection(section.id)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors"
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        isFilled ? "bg-primary/15" : "bg-muted"
                      }`}>
                        <FileText size={13} className={isFilled ? "text-primary" : "text-muted-foreground"} />
                      </div>
                      <span className="text-sm font-medium text-foreground flex-1 text-left">{section.title}</span>
                      {isFilled && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: "oklch(0.65 0.18 155 / 0.15)", color: "oklch(0.45 0.18 155)" }}>
                          filled
                        </span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeCustomSection(section.id); }}
                        className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                      {isExpanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-2">
                        <Input
                          value={section.title}
                          onChange={(e) => updateCustomSection(section.id, "title", e.target.value)}
                          placeholder="Section title"
                          className="h-8 text-sm font-medium"
                        />
                        <textarea
                          value={section.value}
                          onChange={(e) => updateCustomSection(section.id, "value", e.target.value)}
                          placeholder="Paste your content here..."
                          rows={6}
                          className="w-full p-3 text-sm rounded-lg border border-border bg-background resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary leading-relaxed"
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Add custom section */}
              <button
                onClick={addCustomSection}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all"
              >
                <Plus size={14} /> Add Custom Section
              </button>
            </CardContent>
          </Card>

          {/* How it works */}
          <Card>
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">How it works</div>
              <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                <div className="flex gap-2">
                  <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center flex-shrink-0 text-xs font-bold">1</span>
                  <span>Write your agent's personality and behavior rules in the <strong className="text-foreground">System Prompt</strong></span>
                </div>
                <div className="flex gap-2">
                  <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center flex-shrink-0 text-xs font-bold">2</span>
                  <span>Fill in <strong className="text-foreground">Knowledge Base</strong> sections with your office details</span>
                </div>
                <div className="flex gap-2">
                  <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center flex-shrink-0 text-xs font-bold">3</span>
                  <span>The knowledge is auto-injected where <code className="bg-muted px-1 rounded">{"{{knowledge_base}}"}</code> appears</span>
                </div>
                <div className="flex gap-2">
                  <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center flex-shrink-0 text-xs font-bold">4</span>
                  <span>Click <strong className="text-foreground">Copy Prompt</strong> to get the compiled output for Retell</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
