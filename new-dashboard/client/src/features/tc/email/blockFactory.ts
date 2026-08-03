/**
 * Block factory + display metadata for the closed 8-type email block union
 * (shared/tc/emailBlocks.ts). Defaults mirror the legacy TC-app blockFactory
 * so seeded and hand-built templates look alike; every value produced here
 * parses the shared zod schemas.
 */
import type { EmailBlock, EmailBlockType } from "@shared/tc/emailBlocks";
import type { z } from "zod";
import type { EmailTemplateCategory } from "@shared/tc/contract";

let counter = 0;
function bid(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export const BLOCK_TYPES: EmailBlockType[] = [
  "header",
  "text",
  "image",
  "button",
  "highlight",
  "signature",
  "divider",
  "footer",
];

export function createBlock(type: EmailBlockType): EmailBlock {
  switch (type) {
    case "header":
      return {
        id: bid("hdr"),
        type: "header",
        logoUrl: null,
        logoWidth: 140,
        headline: "Your headline",
        subhead: "",
        bgColor: "#ffffff",
        textColor: "#0f172a",
        align: "center",
      };
    case "text":
      return {
        id: bid("txt"),
        type: "text",
        html: "<p>Write your message here…</p>",
        bgColor: "#ffffff",
        textColor: "#0f172a",
        fontSize: 15,
      };
    case "image":
      return {
        id: bid("img"),
        type: "image",
        src: "https://placehold.co/560x280?text=Image",
        alt: "",
        width: 560,
        align: "center",
        href: null,
        bgColor: "#ffffff",
      };
    case "button":
      return {
        id: bid("btn"),
        type: "button",
        label: "Schedule now",
        href: "https://example.com",
        bgColor: "#0ea5b8",
        textColor: "#ffffff",
        align: "center",
        fullWidth: false,
      };
    case "highlight":
      return {
        id: bid("hl"),
        type: "highlight",
        title: "Your treatment plan",
        treatment: "{{case.treatmentSummary}}",
        totalFee: "{{case.totalFee}}",
        patientOwes: "{{case.patientPortion}}",
        monthly: "{{case.monthlyPayment}}",
        showFinancing: true,
        accentColor: "#0ea5b8",
      };
    case "signature":
      return {
        id: bid("sig"),
        type: "signature",
        source: "doctor",
        customText: "",
        showPhone: true,
        showEmail: true,
      };
    case "divider":
      return {
        id: bid("div"),
        type: "divider",
        color: "#e2e8f0",
        thickness: 1,
        spacing: 16,
      };
    case "footer":
      return {
        id: bid("ftr"),
        type: "footer",
        showAddress: true,
        showPhone: true,
        fineText:
          "You are receiving this email because you are a patient of {{practice.name}}.",
        bgColor: "#f8fafc",
        textColor: "#64748b",
      };
  }
}

/** Minimal starter set for a brand-new template (header → text → signature → footer). */
export function starterBlocks(): EmailBlock[] {
  return [
    createBlock("header"),
    createBlock("text"),
    createBlock("signature"),
    createBlock("footer"),
  ];
}

export const BLOCK_LABELS: Record<EmailBlockType, string> = {
  header: "Header",
  text: "Text",
  image: "Image",
  button: "CTA Button",
  highlight: "Treatment Highlight",
  signature: "Signature",
  divider: "Divider",
  footer: "Footer",
};

export const BLOCK_HINTS: Record<EmailBlockType, string> = {
  header: "Logo + headline at the top",
  text: "Paragraph of body copy",
  image: "Photo or banner",
  button: "Call-to-action button",
  highlight: "Treatment + price callout card",
  signature: "Doctor / TC sign-off",
  divider: "Thin separator line",
  footer: "Practice address + fine print",
};

type EmailTemplateCategoryId = z.infer<typeof EmailTemplateCategory>;

export const TEMPLATE_CATEGORY_LABELS: Record<EmailTemplateCategoryId, string> = {
  consult_confirmation: "Consult Confirmation",
  consult_followup: "Consult Follow-up",
  financing_followup: "Financing Follow-up",
  preauth_approved: "Pre-Auth Approved",
  unscheduled_treatment: "Unscheduled Treatment",
  treatment_presentation: "Treatment Presentation",
  general: "General",
};
