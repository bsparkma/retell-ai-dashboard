/**
 * Pure-React email preview — renders the block array as simple styled HTML.
 *
 * Deliberately NOT the legacy server-render-in-an-iframe: there is no render
 * endpoint on the platform yet, and dangerouslySetInnerHTML is banned. Text
 * blocks store sanitized HTML strings; we down-convert them to plain
 * paragraphs for preview (bold/italic formatting is dropped, content is not).
 * Merge tokens like {{practice.name}} render literally on purpose.
 */
import type { CSSProperties } from "react";
import type { EmailBlock } from "@shared/tc/emailBlocks";
import { Monitor, Smartphone } from "lucide-react";
import { useState } from "react";

/** Strip tags / decode basic entities from a text block's stored HTML. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SIGNATURE_SOURCE_TEXT: Record<string, string> = {
  practice: "{{practice.name}}",
  doctor: "{{doctor.name}}",
  tc: "{{sender.name}}",
};

function BlockView({ block }: { block: EmailBlock }) {
  switch (block.type) {
    case "header":
      return (
        <div
          style={{
            backgroundColor: block.bgColor,
            color: block.textColor,
            textAlign: block.align,
            padding: "24px 32px",
          }}
        >
          {block.logoUrl && (
            <img
              src={block.logoUrl}
              alt="Logo"
              style={{ width: block.logoWidth, maxWidth: "100%", display: "inline-block", marginBottom: 12 }}
            />
          )}
          {block.headline && (
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>{block.headline}</div>
          )}
          {block.subhead && (
            <div style={{ fontSize: 14, opacity: 0.8, marginTop: 4 }}>{block.subhead}</div>
          )}
        </div>
      );
    case "text": {
      const text = htmlToPlainText(block.html);
      return (
        <div
          style={{
            backgroundColor: block.bgColor,
            color: block.textColor,
            fontSize: block.fontSize,
            lineHeight: 1.6,
            padding: "16px 32px",
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
          }}
        >
          {text || <span style={{ opacity: 0.5 }}>Empty text block</span>}
        </div>
      );
    }
    case "image":
      return (
        <div style={{ backgroundColor: block.bgColor, textAlign: block.align, padding: "12px 32px" }}>
          <img
            src={block.src}
            alt={block.alt}
            style={{ width: block.width, maxWidth: "100%", display: "inline-block", borderRadius: 4 }}
          />
        </div>
      );
    case "button": {
      const inner: CSSProperties = {
        display: block.fullWidth ? "block" : "inline-block",
        backgroundColor: block.bgColor,
        color: block.textColor,
        padding: "12px 28px",
        borderRadius: 8,
        fontSize: 15,
        fontWeight: 600,
        textAlign: "center",
      };
      return (
        <div style={{ textAlign: block.align, padding: "12px 32px", backgroundColor: "#ffffff" }}>
          <span style={inner}>{block.label}</span>
        </div>
      );
    }
    case "highlight":
      return (
        <div style={{ padding: "12px 32px", backgroundColor: "#ffffff" }}>
          <div
            style={{
              border: "1px solid #e2e8f0",
              borderLeft: `4px solid ${block.accentColor}`,
              borderRadius: 8,
              padding: "16px 20px",
              color: "#0f172a",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: block.accentColor, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {block.title}
            </div>
            <div style={{ fontSize: 15, marginTop: 6 }}>{block.treatment}</div>
            <div style={{ marginTop: 10, fontSize: 14, display: "grid", rowGap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Total fee</span>
                <span style={{ fontWeight: 600 }}>{block.totalFee}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Your portion</span>
                <span style={{ fontWeight: 600 }}>{block.patientOwes}</span>
              </div>
              {block.showFinancing && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Est. monthly</span>
                  <span style={{ fontWeight: 600 }}>{block.monthly}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    case "signature": {
      const name =
        block.source === "custom"
          ? block.customText || "Custom signature"
          : SIGNATURE_SOURCE_TEXT[block.source] ?? block.source;
      return (
        <div style={{ padding: "16px 32px", backgroundColor: "#ffffff", color: "#0f172a", fontSize: 14, lineHeight: 1.6 }}>
          <div style={{ whiteSpace: "pre-wrap", fontWeight: block.source === "custom" ? 400 : 600 }}>{name}</div>
          {block.showPhone && <div style={{ color: "#64748b" }}>{"{{practice.phone}}"}</div>}
          {block.showEmail && <div style={{ color: "#64748b" }}>{"{{sender.email}}"}</div>}
        </div>
      );
    }
    case "divider":
      return (
        <div style={{ padding: `${block.spacing}px 32px`, backgroundColor: "#ffffff" }}>
          <hr style={{ border: "none", borderTop: `${block.thickness}px solid ${block.color}`, margin: 0 }} />
        </div>
      );
    case "footer":
      return (
        <div
          style={{
            backgroundColor: block.bgColor,
            color: block.textColor,
            fontSize: 12,
            lineHeight: 1.6,
            padding: "20px 32px",
            textAlign: "center",
          }}
        >
          {block.showAddress && <div>{"{{practice.address}}"}</div>}
          {block.showPhone && <div>{"{{practice.phone}}"}</div>}
          {block.fineText && <div style={{ marginTop: 8, opacity: 0.85 }}>{block.fineText}</div>}
        </div>
      );
  }
}

export function EmailPreview({
  subject,
  preheader,
  blocks,
}: {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
        <span className="text-xs font-semibold text-foreground">Preview</span>
        <div className="inline-flex items-center rounded border border-border overflow-hidden">
          <button
            type="button"
            aria-label="Desktop preview"
            onClick={() => setDevice("desktop")}
            className={`px-2 py-1 ${device === "desktop" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label="Mobile preview"
            onClick={() => setDevice("mobile")}
            className={`px-2 py-1 ${device === "mobile" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-border bg-muted/10 text-xs space-y-0.5">
        <div>
          <span className="text-muted-foreground">Subject: </span>
          {subject ? (
            <span className="font-medium text-foreground">{subject}</span>
          ) : (
            <em className="text-muted-foreground">(empty)</em>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">Preheader: </span>
          {preheader ? (
            <span className="text-foreground">{preheader}</span>
          ) : (
            <em className="text-muted-foreground">(empty)</em>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-900 p-4 flex justify-center">
        <div style={{ width: device === "mobile" ? 380 : 640, maxWidth: "100%", transition: "width 200ms" }}>
          {/* Email canvas is always light — that's how it renders in inboxes. */}
          <div className="bg-white rounded-md shadow overflow-hidden">
            {blocks.length === 0 ? (
              <div className="py-16 text-center text-sm text-slate-400">No blocks yet</div>
            ) : (
              blocks.map((b) => <BlockView key={b.id} block={b} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
