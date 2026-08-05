/**
 * /tc/templates/:id — block-based email template editor.
 *
 * Left: template meta + ordered block canvas (add from the 8-type palette,
 * remove, move up/down, per-type field editors). Right: always-on live
 * preview rendered as pure React (no server render, no iframe, no
 * dangerouslySetInnerHTML). Save goes through patchTemplate (confirmed-save).
 * Send is visibly disabled — the backend returns 501 until platform email
 * ships, and the UI never calls it.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import type { z } from "zod";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  Plus,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import type { EmailTemplateCategory, TcEmailTemplate } from "@shared/tc/contract";
import type { EmailBlock, EmailBlockType } from "@shared/tc/emailBlocks";
import { getTemplate, patchTemplate, tcErrorMessage } from "@/features/tc/api";
import {
  DisabledFeatureButton,
  TcOfficeGate,
  useTcOffice,
} from "@/features/tc/components/TcShell";
import {
  BLOCK_HINTS,
  BLOCK_LABELS,
  BLOCK_TYPES,
  TEMPLATE_CATEGORY_LABELS,
  createBlock,
} from "@/features/tc/email/blockFactory";
import { BlockEditor } from "@/features/tc/email/BlockEditor";
import { EmailPreview } from "@/features/tc/email/EmailPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CategoryId = z.infer<typeof EmailTemplateCategory>;
const CATEGORY_IDS = Object.keys(TEMPLATE_CATEGORY_LABELS) as CategoryId[];

const MAX_BLOCKS = 40;

interface Draft {
  name: string;
  category: CategoryId;
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export default function TcTemplateEditor() {
  const office = useTcOffice();
  const { id } = useParams<{ id: string }>();

  const [template, setTemplate] = useState<TcEmailTemplate | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!office || !id) return;
    setLoading(true);
    setLoadError(null);
    getTemplate(office, id)
      .then((t) => {
        setTemplate(t);
        setDraft({
          name: t.name,
          category: t.category,
          subject: t.subject,
          preheader: t.preheader,
          blocks: t.blocks,
        });
        setExpandedId(t.blocks[0]?.id ?? null);
      })
      .catch((e: unknown) => setLoadError(tcErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [office, id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  const setBlocks = (blocks: EmailBlock[]) =>
    setDraft((d) => (d ? { ...d, blocks } : d));

  const updateBlock = (updated: EmailBlock) =>
    setDraft((d) =>
      d ? { ...d, blocks: d.blocks.map((b) => (b.id === updated.id ? updated : b)) } : d,
    );

  const addBlock = (type: EmailBlockType) => {
    if (!draft || draft.blocks.length >= MAX_BLOCKS) return;
    const block = createBlock(type);
    setBlocks([...draft.blocks, block]);
    setExpandedId(block.id);
  };

  const removeBlock = (blockId: string) => {
    if (!draft || draft.blocks.length <= 1) return;
    setBlocks(draft.blocks.filter((b) => b.id !== blockId));
    if (expandedId === blockId) setExpandedId(null);
  };

  const moveBlock = (blockId: string, dir: -1 | 1) => {
    if (!draft) return;
    const idx = draft.blocks.findIndex((b) => b.id === blockId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= draft.blocks.length) return;
    const next = draft.blocks.slice();
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    setBlocks(next);
  };

  const handleSave = async () => {
    if (!draft || !id) return;
    if (!draft.name.trim() || !draft.subject.trim()) {
      toast.error("Name and subject are required.");
      return;
    }
    setSaving(true);
    try {
      const saved = await patchTemplate(office, id, {
        name: draft.name.trim(),
        category: draft.category,
        subject: draft.subject.trim(),
        preheader: draft.preheader,
        blocks: draft.blocks,
      });
      setTemplate(saved);
      setDraft({
        name: saved.name,
        category: saved.category,
        subject: saved.subject,
        preheader: saved.preheader,
        blocks: saved.blocks,
      });
      toast.success("Template saved");
    } catch (e) {
      // Keep the draft as-is so nothing is lost.
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" asChild aria-label="Back to templates">
            <Link href="/tc/templates">
              <ArrowLeft className="w-4 h-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h1
              className="text-xl font-bold text-foreground truncate flex items-center gap-2"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              {draft?.name || "Template editor"}
              {template?.isSeed && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Lock className="w-4 h-4 shrink-0 text-muted-foreground" aria-label="Seeded template" />
                  </TooltipTrigger>
                  <TooltipContent>Seeded template — edits are allowed, deletion is not</TooltipContent>
                </Tooltip>
              )}
            </h1>
            {template && (
              <p className="text-xs text-muted-foreground">
                {TEMPLATE_CATEGORY_LABELS[template.category]}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Backend returns 501 FEATURE_DISABLED for send — never called from UI. */}
          <DisabledFeatureButton reason="platform_email">
            <Send className="w-4 h-4" /> Send
          </DisabledFeatureButton>
          <Button onClick={() => void handleSave()} disabled={saving || !draft}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading template…
        </div>
      ) : loadError || !draft ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <p className="text-sm text-muted-foreground">{loadError ?? "Template not found."}</p>
          <Button variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 items-start">
          {/* ── Left: meta + canvas ─────────────────────────────────────── */}
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                <span>Name *</span>
                <Input
                  value={draft.name}
                  maxLength={200}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                <span>Category</span>
                <Select
                  value={draft.category}
                  onValueChange={(v) => setDraft({ ...draft, category: v as CategoryId })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_IDS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {TEMPLATE_CATEGORY_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                <span>Subject *</span>
                <Input
                  value={draft.subject}
                  maxLength={160}
                  onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                <span>Preheader</span>
                <Input
                  value={draft.preheader}
                  maxLength={160}
                  placeholder="Inbox preview text"
                  onChange={(e) => setDraft({ ...draft, preheader: e.target.value })}
                />
              </label>
            </div>

            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                Blocks <span className="text-muted-foreground font-normal">({draft.blocks.length}/{MAX_BLOCKS})</span>
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={draft.blocks.length >= MAX_BLOCKS}>
                    <Plus className="w-3.5 h-3.5" /> Add block
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {BLOCK_TYPES.map((t) => (
                    <DropdownMenuItem key={t} onClick={() => addBlock(t)}>
                      <div>
                        <p className="text-sm font-medium">{BLOCK_LABELS[t]}</p>
                        <p className="text-xs text-muted-foreground">{BLOCK_HINTS[t]}</p>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="space-y-2">
              {draft.blocks.map((block, i) => {
                const expanded = expandedId === block.id;
                return (
                  <div key={block.id} className="rounded-lg border border-border bg-card shadow-sm">
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-1 py-1 rounded hover:bg-muted/60"
                        onClick={() => setExpandedId(expanded ? null : block.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? (
                          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="text-sm font-medium text-foreground">{BLOCK_LABELS[block.type]}</span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={i === 0}
                        onClick={() => moveBlock(block.id, -1)}
                        aria-label="Move block up"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={i === draft.blocks.length - 1}
                        onClick={() => moveBlock(block.id, 1)}
                        aria-label="Move block down"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-600 dark:text-red-400"
                        disabled={draft.blocks.length <= 1}
                        onClick={() => removeBlock(block.id)}
                        aria-label="Remove block"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    {expanded && (
                      <div className="border-t border-border px-3 py-3">
                        <BlockEditor block={block} onChange={updateBlock} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Right: always-on live preview ───────────────────────────── */}
          <div className="lg:sticky lg:top-6 h-[calc(100vh-8rem)] min-h-[480px]">
            <EmailPreview subject={draft.subject} preheader={draft.preheader} blocks={draft.blocks} />
          </div>
        </div>
      )}
    </div>
  );
}
