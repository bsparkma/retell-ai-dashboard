/**
 * TC email rendering: the email block model (./emailBlocks.ts) and plain text
 * to the HTML and plain text that is actually sent (queue item 40).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE IMPLEMENTATION
 * ═════════════════════════════════════════════════════════════════════════════
 * The backend uses this file through the committed contract bundle
 * (backend/tc/contract.gen.cjs). The dashboard's EmailPreview imports the same
 * text helpers from here, and the Messages tab previews a draft by asking the
 * server to render it, so the HTML a TC looks at before clicking Send comes
 * from this code and nothing else.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TOTAL FUNCTIONS
 * ═════════════════════════════════════════════════════════════════════════════
 * Nothing exported here throws. Templates imported from the legacy TC app may
 * hold blocks that do not parse against today's strict schema: a wrong type, a
 * missing field, an unknown block type, a `null`, a string where an array
 * should be. Each block is read field by field with a default for anything
 * unusable. A block that has nothing renderable is dropped. Input that is not
 * an array at all renders as an empty body (the footer still renders).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ESCAPING
 * ═════════════════════════════════════════════════════════════════════════════
 * Every string that came from a person (template text, merge values, the body
 * a TC typed) is HTML-escaped before it reaches the output. Text-block HTML is
 * NOT passed through. It is reduced to plain paragraphs first, exactly as the
 * editor's preview always showed it, and then escaped. Bold and italics are
 * lost. That is the trade for having no HTML sanitizer to get wrong.
 * Links and images accept http(s) only (plus mailto: and tel: for buttons).
 * Anything else, such as `javascript:`, drops the link. Colours must be
 * #rrggbb or fall back to the block's default.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * MINIMUM NECESSARY
 * ═════════════════════════════════════════════════════════════════════════════
 * Only the merge tokens in EMAIL_MERGE_TOKENS are ever filled. The `case.*`
 * tokens the legacy highlight block carries (treatment summary, fees) are
 * deliberately NOT among them. They render as nothing, and a highlight block
 * left with nothing to show is dropped. A template can still say whatever a
 * person typed into it; this code just never pulls clinical or financial
 * detail out of a case on its own. An unknown token renders as nothing, never
 * as a literal "{{...}}" in a patient's inbox.
 */

// ── Merge tokens ────────────────────────────────────────────────────────────

/** The ONLY tokens a render ever fills. See MINIMUM NECESSARY above. */
export const EMAIL_MERGE_TOKENS = [
  "patient.firstName",
  "practice.name",
  "practice.phone",
  "practice.address",
  "sender.name",
  "sender.email",
] as const;
export type EmailMergeToken = (typeof EMAIL_MERGE_TOKENS)[number];
export type EmailMergeValues = Partial<Record<EmailMergeToken, string | null>>;

const TOKEN_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

function isMergeToken(name: string): name is EmailMergeToken {
  return (EMAIL_MERGE_TOKENS as readonly string[]).includes(name);
}

/**
 * Replace every `{{token}}`. Allowlisted tokens get their value (or nothing
 * when there is none). Every other token becomes nothing.
 */
export function fillMergeTokens(text: unknown, values: EmailMergeValues): string {
  if (typeof text !== "string" || text === "") return "";
  return text.replace(TOKEN_RE, (_m, name: string) => {
    if (!isMergeToken(name)) return "";
    const v = values[name];
    return typeof v === "string" ? v : "";
  });
}

// ── Escaping and safe values ────────────────────────────────────────────────

/** HTML-escape text content and attribute values alike. */
export function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function color(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX_RE.test(v) ? v : fallback;
}

/**
 * A URL safe to put in an href/src, or null. The scheme must be in `allowed`.
 * Credentials in the URL are refused too.
 */
export function safeUrl(v: unknown, allowed: readonly string[] = ["https:", "http:"]): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (!allowed.includes(u.protocol)) return null;
  if (u.username || u.password) return null;
  return u.toString();
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function str(v: unknown, fallback = "", maxLen = 20_000): string {
  return typeof v === "string" ? v.slice(0, maxLen) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function align(v: unknown, fallback: "left" | "center" | "right"): "left" | "center" | "right" {
  return v === "left" || v === "center" || v === "right" ? v : fallback;
}

// ── Text-block HTML → plain text (shared with the editor preview) ───────────

/**
 * Strip tags and decode the basic entities from a text block's stored HTML.
 * The editor preview and the sent email both go through this, so what a TC
 * sees in the template editor is what the patient reads.
 */
export function htmlToPlainText(html: unknown): string {
  if (typeof html !== "string") return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]*>?/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The name line a signature block shows for each source, as a merge token. */
export const SIGNATURE_SOURCE_TEXT: Record<"practice" | "doctor" | "tc", string> = {
  practice: "{{practice.name}}",
  doctor: "{{doctor.name}}",
  tc: "{{sender.name}}",
};

// ── Lenient block reading (the total part) ──────────────────────────────────

type Align = "left" | "center" | "right";

/** A block after lenient reading and token filling: every field usable as-is. */
export type RenderBlock =
  | { type: "header"; logoUrl: string | null; logoWidth: number; headline: string; subhead: string; bgColor: string; textColor: string; align: Align }
  | { type: "text"; text: string; bgColor: string; textColor: string; fontSize: number }
  | { type: "image"; src: string; alt: string; width: number; align: Align; href: string | null; bgColor: string }
  | { type: "button"; label: string; href: string; bgColor: string; textColor: string; align: Align; fullWidth: boolean }
  | { type: "highlight"; title: string; treatment: string; totalFee: string; patientOwes: string; monthly: string; showFinancing: boolean; accentColor: string }
  | { type: "signature"; name: string; phone: string; email: string }
  | { type: "divider"; color: string; thickness: number; spacing: number }
  | { type: "footer"; address: string; phone: string; fineText: string; bgColor: string; textColor: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Read ONE block leniently and fill its tokens. Returns null when the block is
 * not an object, has an unknown type, or has nothing that could render.
 */
export function readBlock(raw: unknown, values: EmailMergeValues): RenderBlock | null {
  const b = asRecord(raw);
  if (!b) return null;
  const fill = (v: unknown, max = 20_000) => fillMergeTokens(str(v, "", max), values).trim();

  switch (b.type) {
    case "header": {
      const logoUrl = safeUrl(b.logoUrl);
      const headline = fill(b.headline, 120);
      const subhead = fill(b.subhead, 160);
      if (!logoUrl && !headline && !subhead) return null;
      return {
        type: "header",
        logoUrl,
        logoWidth: num(b.logoWidth, 140, 40, 320),
        headline,
        subhead,
        bgColor: color(b.bgColor, "#ffffff"),
        textColor: color(b.textColor, "#0f172a"),
        align: align(b.align, "center"),
      };
    }
    case "text": {
      const text = fillMergeTokens(htmlToPlainText(b.html), values).trim();
      if (!text) return null;
      return {
        type: "text",
        text,
        bgColor: color(b.bgColor, "#ffffff"),
        textColor: color(b.textColor, "#0f172a"),
        fontSize: num(b.fontSize, 15, 10, 28),
      };
    }
    case "image": {
      const src = safeUrl(b.src);
      if (!src) return null;
      return {
        type: "image",
        src,
        alt: fill(b.alt, 200),
        width: num(b.width, 560, 80, 600),
        align: align(b.align, "center"),
        href: safeUrl(b.href),
        bgColor: color(b.bgColor, "#ffffff"),
      };
    }
    case "button": {
      const href = safeUrl(b.href, ["https:", "http:", "mailto:", "tel:"]);
      const label = fill(b.label, 60) || "Learn more";
      if (!href) return null;
      return {
        type: "button",
        label,
        href,
        bgColor: color(b.bgColor, "#0ea5b8"),
        textColor: color(b.textColor, "#ffffff"),
        align: align(b.align, "center"),
        fullWidth: bool(b.fullWidth, false),
      };
    }
    case "highlight": {
      const treatment = fill(b.treatment, 240);
      const totalFee = fill(b.totalFee, 40);
      const patientOwes = fill(b.patientOwes, 40);
      const showFinancing = bool(b.showFinancing, true);
      const monthly = showFinancing ? fill(b.monthly, 40) : "";
      // With the case.* tokens unfilled (minimum necessary), a stock highlight
      // block has nothing left to say; drop it rather than send an empty box.
      if (!treatment && !totalFee && !patientOwes && !monthly) return null;
      return {
        type: "highlight",
        title: fill(b.title, 80),
        treatment,
        totalFee,
        patientOwes,
        monthly,
        showFinancing,
        accentColor: color(b.accentColor, "#0ea5b8"),
      };
    }
    case "signature": {
      const source = b.source === "practice" || b.source === "doctor" || b.source === "tc" || b.source === "custom" ? b.source : "doctor";
      const name =
        source === "custom" ? fill(b.customText, 400) : fillMergeTokens(SIGNATURE_SOURCE_TEXT[source], values).trim();
      const phone = bool(b.showPhone, true) ? fillMergeTokens("{{practice.phone}}", values).trim() : "";
      const email = bool(b.showEmail, true) ? fillMergeTokens("{{sender.email}}", values).trim() : "";
      if (!name && !phone && !email) return null;
      return { type: "signature", name, phone, email };
    }
    case "divider":
      return {
        type: "divider",
        color: color(b.color, "#e2e8f0"),
        thickness: num(b.thickness, 1, 1, 8),
        spacing: num(b.spacing, 16, 0, 48),
      };
    case "footer": {
      const address = bool(b.showAddress, true) ? fillMergeTokens("{{practice.address}}", values).trim() : "";
      const phone = bool(b.showPhone, true) ? fillMergeTokens("{{practice.phone}}", values).trim() : "";
      const fineText = fill(b.fineText, 400);
      if (!address && !phone && !fineText) return null;
      return {
        type: "footer",
        address,
        phone,
        fineText,
        bgColor: color(b.bgColor, "#f8fafc"),
        textColor: color(b.textColor, "#64748b"),
      };
    }
    default:
      return null;
  }
}

/** Read a whole block list leniently. Not an array ⇒ []. Never throws. */
export function readBlocks(raw: unknown, values: EmailMergeValues): RenderBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: RenderBlock[] = [];
  for (const item of raw.slice(0, 40)) {
    try {
      const b = readBlock(item, values);
      if (b) out.push(b);
    } catch {
      // A getter that throws, a hostile object: skip the block, keep the email.
    }
  }
  return out;
}

/**
 * Fill the allowlisted tokens inside a stored block list WITHOUT changing its
 * shape. Used when a draft snapshots a template, so the snapshot holds the
 * values the TC saw in the preview. Non-string fields pass through; anything
 * that is not an array becomes [].
 */
export function fillBlockTokens(raw: unknown, values: EmailMergeValues): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((item) => {
    const b = asRecord(item);
    if (!b) return item;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      copy[k] = typeof v === "string" && k !== "type" && k !== "id" ? fillMergeTokens(v, values) : v;
    }
    // Signature and footer LINES (phone, address, sender email) are not fields
    // a template can hold text in; they come from the same `values` again at
    // render time, which are practice settings, never case data.
    return copy;
  });
}

// ── HTML ────────────────────────────────────────────────────────────────────

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Escaped text with newlines as <br>. */
function lines(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/** Escaped text as paragraphs: blank lines split paragraphs, single newlines become <br>. */
function paragraphs(text: string, style: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px 0;${style}">${lines(p)}</p>`)
    .join("");
}

function row(inner: string, bg: string, padding: string, extra = ""): string {
  return `<tr><td style="background-color:${bg};padding:${padding};${extra}">${inner}</td></tr>`;
}

function blockHtml(b: RenderBlock): string {
  switch (b.type) {
    case "header": {
      const logo = b.logoUrl
        ? `<img src="${escapeHtml(b.logoUrl)}" alt="" width="${b.logoWidth}" style="width:${b.logoWidth}px;max-width:100%;display:inline-block;margin-bottom:12px;border:0">`
        : "";
      const headline = b.headline
        ? `<div style="font-size:22px;font-weight:700;line-height:1.3;color:${b.textColor}">${lines(b.headline)}</div>`
        : "";
      const subhead = b.subhead
        ? `<div style="font-size:14px;margin-top:4px;color:${b.textColor}">${lines(b.subhead)}</div>`
        : "";
      return row(logo + headline + subhead, b.bgColor, "24px 32px", `text-align:${b.align}`);
    }
    case "text":
      return row(
        paragraphs(b.text, `color:${b.textColor};font-size:${b.fontSize}px;line-height:1.6`),
        b.bgColor,
        "16px 32px",
      );
    case "image": {
      const img = `<img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt)}" width="${b.width}" style="width:${b.width}px;max-width:100%;display:inline-block;border:0;border-radius:4px">`;
      const inner = b.href ? `<a href="${escapeHtml(b.href)}">${img}</a>` : img;
      return row(inner, b.bgColor, "12px 32px", `text-align:${b.align}`);
    }
    case "button": {
      const display = b.fullWidth ? "block" : "inline-block";
      const a = `<a href="${escapeHtml(b.href)}" style="display:${display};background-color:${b.bgColor};color:${b.textColor};padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;text-align:center;text-decoration:none">${escapeHtml(b.label)}</a>`;
      return row(a, "#ffffff", "12px 32px", `text-align:${b.align}`);
    }
    case "highlight": {
      const line = (label: string, value: string) =>
        value
          ? `<tr><td style="color:#64748b;font-size:14px;padding:2px 0">${escapeHtml(label)}</td><td style="font-weight:600;font-size:14px;text-align:right;padding:2px 0">${escapeHtml(value)}</td></tr>`
          : "";
      const inner =
        `<div style="border:1px solid #e2e8f0;border-left:4px solid ${b.accentColor};border-radius:8px;padding:16px 20px;color:#0f172a">` +
        (b.title
          ? `<div style="font-size:13px;font-weight:700;color:${b.accentColor};text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(b.title)}</div>`
          : "") +
        (b.treatment ? `<div style="font-size:15px;margin-top:6px">${lines(b.treatment)}</div>` : "") +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px">` +
        line("Total fee", b.totalFee) +
        line("Your portion", b.patientOwes) +
        (b.showFinancing ? line("Est. monthly", b.monthly) : "") +
        `</table></div>`;
      return row(inner, "#ffffff", "12px 32px");
    }
    case "signature": {
      const inner =
        (b.name ? `<div style="font-weight:600">${lines(b.name)}</div>` : "") +
        (b.phone ? `<div style="color:#64748b">${escapeHtml(b.phone)}</div>` : "") +
        (b.email ? `<div style="color:#64748b">${escapeHtml(b.email)}</div>` : "");
      return row(inner, "#ffffff", "16px 32px", "color:#0f172a;font-size:14px;line-height:1.6");
    }
    case "divider":
      return row(
        `<div style="border-top:${b.thickness}px solid ${b.color};font-size:0;line-height:0">&nbsp;</div>`,
        "#ffffff",
        `${b.spacing}px 32px`,
      );
    case "footer": {
      const inner =
        (b.address ? `<div>${lines(b.address)}</div>` : "") +
        (b.phone ? `<div>${escapeHtml(b.phone)}</div>` : "") +
        (b.fineText ? `<div style="margin-top:8px">${lines(b.fineText)}</div>` : "");
      return row(inner, b.bgColor, "20px 32px", `color:${b.textColor};font-size:12px;line-height:1.6;text-align:center`);
    }
  }
}

function blockText(b: RenderBlock): string {
  switch (b.type) {
    case "header":
      return [b.headline, b.subhead].filter(Boolean).join("\n");
    case "text":
      return b.text;
    case "image":
      return b.alt;
    case "button":
      return `${b.label}: ${b.href}`;
    case "highlight":
      return [
        b.title,
        b.treatment,
        b.totalFee ? `Total fee: ${b.totalFee}` : "",
        b.patientOwes ? `Your portion: ${b.patientOwes}` : "",
        b.monthly ? `Est. monthly: ${b.monthly}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "signature":
      return [b.name, b.phone, b.email].filter(Boolean).join("\n");
    case "divider":
      return "";
    case "footer":
      return [b.address, b.phone, b.fineText].filter(Boolean).join("\n");
  }
}

// ── The whole email ─────────────────────────────────────────────────────────

/**
 * The footer CareIN adds to EVERY email, whatever the template says. It is not
 * a block: a template cannot remove it, which is the point.
 */
export interface EmailSystemFooter {
  practiceName: string;
  practiceAddress?: string | null;
  practicePhone?: string | null;
  /** The one-click unsubscribe link. Null only in a preview. */
  unsubscribeUrl: string | null;
}

export type EmailContent =
  | { kind: "blocks"; blocks: unknown }
  | { kind: "text"; body: unknown };

export interface RenderEmailInput {
  subject: unknown;
  preheader?: unknown;
  content: EmailContent;
  values: EmailMergeValues;
  footer: EmailSystemFooter;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function systemFooterHtml(f: EmailSystemFooter): string {
  const name = str(f.practiceName, "", 200).trim();
  const contact = [str(f.practiceAddress, "", 400).trim(), str(f.practicePhone, "", 60).trim()].filter(Boolean);
  const link = f.unsubscribeUrl ? safeUrl(f.unsubscribeUrl) : null;
  const unsub = link
    ? `<a href="${escapeHtml(link)}" style="color:#475569;text-decoration:underline">Unsubscribe from these emails</a>`
    : `<span style="color:#475569;text-decoration:underline">Unsubscribe from these emails</span>`;
  return (
    `<tr><td style="padding:20px 32px;color:#64748b;font-size:12px;line-height:1.6;text-align:center;font-family:${FONT}">` +
    (name ? `<div>You are receiving this email because you are a patient of ${escapeHtml(name)}.</div>` : "") +
    contact.map((c) => `<div>${lines(c)}</div>`).join("") +
    `<div style="margin-top:8px">${unsub}</div>` +
    `</td></tr>`
  );
}

function systemFooterText(f: EmailSystemFooter): string {
  const name = str(f.practiceName, "", 200).trim();
  const parts = [
    name ? `You are receiving this email because you are a patient of ${name}.` : "",
    str(f.practiceAddress, "", 400).trim(),
    str(f.practicePhone, "", 60).trim(),
    f.unsubscribeUrl ? `Unsubscribe: ${f.unsubscribeUrl}` : "Unsubscribe: (link added when sent)",
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * The plain text of an email's BODY only (no system footer): what the thread
 * shows for a template draft. Total, like everything here.
 */
export function emailBodyText(content: EmailContent, values: EmailMergeValues): string {
  const c = asRecord(content);
  const v = (asRecord(values) ?? {}) as EmailMergeValues;
  if (c && c.kind === "blocks") {
    return readBlocks(c.blocks, v).map(blockText).filter(Boolean).join("\n\n");
  }
  if (c && c.kind === "text") return fillMergeTokens(str(c.body, "", 8000), v).trim();
  return "";
}

/**
 * Render a whole email. TOTAL: whatever `input` holds, this returns strings.
 * The subject is one line of plain text (the provider escapes it); the html is
 * a complete document; the text is the plain-text alternative.
 */
export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const values = (asRecord(input && input.values) ?? {}) as EmailMergeValues;
  const footer: EmailSystemFooter = asRecord(input && input.footer)
    ? (input.footer as EmailSystemFooter)
    : { practiceName: "", unsubscribeUrl: null };
  const subject = fillMergeTokens(str(input && input.subject, "", 300), values).replace(/[\r\n]+/g, " ").trim();
  const preheader = fillMergeTokens(str(input && input.preheader, "", 300), values).replace(/[\r\n]+/g, " ").trim();

  let bodyRows = "";
  let bodyText = "";
  const content = asRecord(input && input.content);
  if (content && content.kind === "blocks") {
    const blocks = readBlocks(content.blocks, values);
    bodyRows = blocks.map(blockHtml).join("");
    bodyText = blocks.map(blockText).filter(Boolean).join("\n\n");
  } else if (content && content.kind === "text") {
    const text = fillMergeTokens(str(content.body, "", 8000), values).trim();
    bodyRows = text ? row(paragraphs(text, "color:#0f172a;font-size:15px;line-height:1.6"), "#ffffff", "24px 32px") : "";
    bodyText = text;
  }

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f1f5f9">` +
    (preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>`
      : "") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9">` +
    `<tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:6px;font-family:${FONT}">` +
    bodyRows +
    systemFooterHtml(footer) +
    `</table></td></tr></table></body></html>`;

  const text = [bodyText, systemFooterText(footer)].filter(Boolean).join("\n\n");
  return { subject, html, text };
}
