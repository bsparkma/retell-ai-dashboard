/**
 * Per-type field editors for the 8 email block types. One exported
 * <BlockEditor /> switches on block.type; all sub-editors are co-located here
 * (legacy BlockEditors.tsx pattern) to avoid 8 tiny files.
 *
 * Differences from legacy, on purpose:
 *  - No tiptap rich-text editor (would be a new dependency) — text blocks edit
 *    the stored HTML/plain content in a textarea.
 *  - No image upload — media uploads arrive with blob-store wiring; the image
 *    src is a URL field with an honest note.
 * Colors are constrained to 6-digit hex (#rrggbb) to match the zod contract.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  EmailBlock,
} from "@shared/tc/emailBlocks";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { z } from "zod";
import type {
  HeaderBlock,
  TextBlock,
  ImageBlock,
  ButtonBlock,
  HighlightBlock,
  SignatureBlock,
  DividerBlock,
  FooterBlock,
} from "@shared/tc/emailBlocks";

type Header = z.infer<typeof HeaderBlock>;
type Text = z.infer<typeof TextBlock>;
type Image = z.infer<typeof ImageBlock>;
type Btn = z.infer<typeof ButtonBlock>;
type Highlight = z.infer<typeof HighlightBlock>;
type Signature = z.infer<typeof SignatureBlock>;
type Divider = z.infer<typeof DividerBlock>;
type Footer = z.infer<typeof FooterBlock>;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// ── Shared field UI ─────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <span>{label}</span>
    </label>
  );
}

/**
 * Hex color field: native color picker (always emits #rrggbb) + text input
 * that only commits values matching ^#[0-9a-fA-F]{6}$.
 */
function HexColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={HEX_RE.test(value) ? value : "#0ea5b8"}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 shrink-0 rounded border border-border bg-background p-0.5 cursor-pointer"
      />
      <Input
        value={text}
        maxLength={7}
        placeholder="#rrggbb"
        className="h-8 font-mono text-xs"
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (HEX_RE.test(v)) onChange(v);
        }}
        onBlur={() => {
          if (!HEX_RE.test(text)) setText(value);
        }}
      />
    </div>
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <Input
      type="number"
      value={value}
      min={min}
      max={max}
      className="h-8"
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isNaN(n)) return;
        onChange(Math.min(max, Math.max(min, Math.round(n))));
      }}
    />
  );
}

type AlignId = "left" | "center" | "right";

function AlignSelect({ value, onChange }: { value: AlignId; onChange: (v: AlignId) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AlignId)}>
      <SelectTrigger className="h-8">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="left">Left</SelectItem>
        <SelectItem value="center">Center</SelectItem>
        <SelectItem value="right">Right</SelectItem>
      </SelectContent>
    </Select>
  );
}

// ── Per-type editors ────────────────────────────────────────────────────────

function HeaderEditor({ value, onChange }: { value: Header; onChange: (v: Header) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Headline">
        <Input className="h-8" value={value.headline} maxLength={120} onChange={(e) => onChange({ ...value, headline: e.target.value })} />
      </Field>
      <Field label="Subhead">
        <Input className="h-8" value={value.subhead} maxLength={160} onChange={(e) => onChange({ ...value, subhead: e.target.value })} />
      </Field>
      <Field label="Logo URL (optional)">
        <Input className="h-8" value={value.logoUrl ?? ""} placeholder="https://…" onChange={(e) => onChange({ ...value, logoUrl: e.target.value.trim() || null })} />
      </Field>
      <Field label="Logo width (px)">
        <NumberField value={value.logoWidth} min={40} max={320} onChange={(v) => onChange({ ...value, logoWidth: v })} />
      </Field>
      <Field label="Background">
        <HexColorField value={value.bgColor} onChange={(v) => onChange({ ...value, bgColor: v })} />
      </Field>
      <Field label="Text color">
        <HexColorField value={value.textColor} onChange={(v) => onChange({ ...value, textColor: v })} />
      </Field>
      <Field label="Align">
        <AlignSelect value={value.align} onChange={(v) => onChange({ ...value, align: v })} />
      </Field>
    </div>
  );
}

function TextEditor({ value, onChange }: { value: Text; onChange: (v: Text) => void }) {
  return (
    <div className="space-y-3">
      <Field label="Body (simple HTML — <p>, <br>, lists)">
        <Textarea
          value={value.html}
          rows={5}
          maxLength={20000}
          className="font-mono text-xs"
          onChange={(e) => onChange({ ...value, html: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Background">
          <HexColorField value={value.bgColor} onChange={(v) => onChange({ ...value, bgColor: v })} />
        </Field>
        <Field label="Text color">
          <HexColorField value={value.textColor} onChange={(v) => onChange({ ...value, textColor: v })} />
        </Field>
        <Field label="Font size">
          <NumberField value={value.fontSize} min={10} max={28} onChange={(v) => onChange({ ...value, fontSize: v })} />
        </Field>
      </div>
    </div>
  );
}

function ImageEditor({ value, onChange }: { value: Image; onChange: (v: Image) => void }) {
  return (
    <div className="space-y-3">
      <Field label="Image URL">
        <Input className="h-8" value={value.src} placeholder="https://…" onChange={(e) => onChange({ ...value, src: e.target.value })} />
      </Field>
      <p className="text-xs text-muted-foreground italic">
        Paste an image URL for now — media uploads come later with platform blob storage.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Alt text">
          <Input className="h-8" value={value.alt} maxLength={200} onChange={(e) => onChange({ ...value, alt: e.target.value })} />
        </Field>
        <Field label="Width (px)">
          <NumberField value={value.width} min={80} max={600} onChange={(v) => onChange({ ...value, width: v })} />
        </Field>
        <Field label="Align">
          <AlignSelect value={value.align} onChange={(v) => onChange({ ...value, align: v })} />
        </Field>
        <Field label="Link URL (optional)">
          <Input className="h-8" value={value.href ?? ""} placeholder="https://…" onChange={(e) => onChange({ ...value, href: e.target.value.trim() || null })} />
        </Field>
        <Field label="Background">
          <HexColorField value={value.bgColor} onChange={(v) => onChange({ ...value, bgColor: v })} />
        </Field>
      </div>
    </div>
  );
}

function ButtonEditor({ value, onChange }: { value: Btn; onChange: (v: Btn) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Button label">
        <Input className="h-8" value={value.label} maxLength={60} onChange={(e) => onChange({ ...value, label: e.target.value })} />
      </Field>
      <Field label="Link URL">
        <Input className="h-8" value={value.href} placeholder="https://…" onChange={(e) => onChange({ ...value, href: e.target.value })} />
      </Field>
      <Field label="Background">
        <HexColorField value={value.bgColor} onChange={(v) => onChange({ ...value, bgColor: v })} />
      </Field>
      <Field label="Text color">
        <HexColorField value={value.textColor} onChange={(v) => onChange({ ...value, textColor: v })} />
      </Field>
      <Field label="Align">
        <AlignSelect value={value.align} onChange={(v) => onChange({ ...value, align: v })} />
      </Field>
      <div className="flex items-end pb-1.5">
        <Toggle checked={value.fullWidth} onChange={(v) => onChange({ ...value, fullWidth: v })} label="Full-width button" />
      </div>
    </div>
  );
}

function HighlightEditor({ value, onChange }: { value: Highlight; onChange: (v: Highlight) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Card title">
        <Input className="h-8" value={value.title} maxLength={80} onChange={(e) => onChange({ ...value, title: e.target.value })} />
      </Field>
      <Field label="Treatment line">
        <Input className="h-8" value={value.treatment} maxLength={240} onChange={(e) => onChange({ ...value, treatment: e.target.value })} />
      </Field>
      <Field label="Total fee">
        <Input className="h-8" value={value.totalFee} maxLength={40} onChange={(e) => onChange({ ...value, totalFee: e.target.value })} />
      </Field>
      <Field label="Patient portion">
        <Input className="h-8" value={value.patientOwes} maxLength={40} onChange={(e) => onChange({ ...value, patientOwes: e.target.value })} />
      </Field>
      <Field label="Monthly payment">
        <Input className="h-8" value={value.monthly} maxLength={40} onChange={(e) => onChange({ ...value, monthly: e.target.value })} />
      </Field>
      <Field label="Accent color">
        <HexColorField value={value.accentColor} onChange={(v) => onChange({ ...value, accentColor: v })} />
      </Field>
      <div className="col-span-2">
        <Toggle checked={value.showFinancing} onChange={(v) => onChange({ ...value, showFinancing: v })} label="Show monthly payment row" />
      </div>
    </div>
  );
}

function SignatureEditor({ value, onChange }: { value: Signature; onChange: (v: Signature) => void }) {
  return (
    <div className="space-y-3">
      <Field label="Signature source">
        <Select
          value={value.source}
          onValueChange={(v) => onChange({ ...value, source: v as Signature["source"] })}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="doctor">Doctor</SelectItem>
            <SelectItem value="practice">Practice name</SelectItem>
            <SelectItem value="tc">Sender / TC name</SelectItem>
            <SelectItem value="custom">Custom text</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {value.source === "custom" && (
        <Field label="Custom sign-off">
          <Textarea
            value={value.customText}
            rows={3}
            maxLength={400}
            onChange={(e) => onChange({ ...value, customText: e.target.value })}
          />
        </Field>
      )}
      <div className="flex items-center gap-6">
        <Toggle checked={value.showPhone} onChange={(v) => onChange({ ...value, showPhone: v })} label="Show phone" />
        <Toggle checked={value.showEmail} onChange={(v) => onChange({ ...value, showEmail: v })} label="Show email" />
      </div>
    </div>
  );
}

function DividerEditor({ value, onChange }: { value: Divider; onChange: (v: Divider) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="Color">
        <HexColorField value={value.color} onChange={(v) => onChange({ ...value, color: v })} />
      </Field>
      <Field label="Thickness (px)">
        <NumberField value={value.thickness} min={1} max={8} onChange={(v) => onChange({ ...value, thickness: v })} />
      </Field>
      <Field label="Spacing (px)">
        <NumberField value={value.spacing} min={0} max={48} onChange={(v) => onChange({ ...value, spacing: v })} />
      </Field>
    </div>
  );
}

function FooterEditor({ value, onChange }: { value: Footer; onChange: (v: Footer) => void }) {
  return (
    <div className="space-y-3">
      <Field label="Fine print">
        <Textarea
          value={value.fineText}
          rows={3}
          maxLength={400}
          onChange={(e) => onChange({ ...value, fineText: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Background">
          <HexColorField value={value.bgColor} onChange={(v) => onChange({ ...value, bgColor: v })} />
        </Field>
        <Field label="Text color">
          <HexColorField value={value.textColor} onChange={(v) => onChange({ ...value, textColor: v })} />
        </Field>
      </div>
      <div className="flex items-center gap-6">
        <Toggle checked={value.showAddress} onChange={(v) => onChange({ ...value, showAddress: v })} label="Show address" />
        <Toggle checked={value.showPhone} onChange={(v) => onChange({ ...value, showPhone: v })} label="Show phone" />
      </div>
    </div>
  );
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export function BlockEditor({
  block,
  onChange,
}: {
  block: EmailBlock;
  onChange: (b: EmailBlock) => void;
}) {
  switch (block.type) {
    case "header":
      return <HeaderEditor value={block} onChange={onChange} />;
    case "text":
      return <TextEditor value={block} onChange={onChange} />;
    case "image":
      return <ImageEditor value={block} onChange={onChange} />;
    case "button":
      return <ButtonEditor value={block} onChange={onChange} />;
    case "highlight":
      return <HighlightEditor value={block} onChange={onChange} />;
    case "signature":
      return <SignatureEditor value={block} onChange={onChange} />;
    case "divider":
      return <DividerEditor value={block} onChange={onChange} />;
    case "footer":
      return <FooterEditor value={block} onChange={onChange} />;
  }
}
