/**
 * TC module — email template block contract.
 *
 * Strict port of the legacy TC-app block union (TC-app server/email/blocks.ts):
 * a CLOSED discriminated union of exactly 8 block types, stored as jsonb in
 * tc_email_templates.blocks and validated here at every edge. The legacy hard
 * cap stands: do NOT add a block type without explicit approval — more block
 * types is how a block editor quietly becomes a page builder.
 */
import { z } from "zod";

const BlockId = z.string().min(1).max(40);
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be #rrggbb");
const Align = z.enum(["left", "center", "right"]);

export const HeaderBlock = z.object({
  id: BlockId,
  type: z.literal("header"),
  logoUrl: z.string().url().nullable(),
  logoWidth: z.number().min(40).max(320).default(140),
  headline: z.string().max(120).default(""),
  subhead: z.string().max(160).default(""),
  bgColor: HexColor.default("#ffffff"),
  textColor: HexColor.default("#0f172a"),
  align: Align.default("center"),
});

export const TextBlock = z.object({
  id: BlockId,
  type: z.literal("text"),
  html: z.string().max(20_000).default("<p></p>"), // sanitized upstream
  bgColor: HexColor.default("#ffffff"),
  textColor: HexColor.default("#0f172a"),
  fontSize: z.number().min(10).max(28).default(15),
});

export const ImageBlock = z.object({
  id: BlockId,
  type: z.literal("image"),
  src: z.string().url(),
  alt: z.string().max(200).default(""),
  width: z.number().min(80).max(600).default(560),
  align: Align.default("center"),
  href: z.string().url().nullable().default(null),
  bgColor: HexColor.default("#ffffff"),
});

export const ButtonBlock = z.object({
  id: BlockId,
  type: z.literal("button"),
  label: z.string().min(1).max(60).default("Learn more"),
  href: z.string().url(),
  bgColor: HexColor.default("#0ea5b8"),
  textColor: HexColor.default("#ffffff"),
  align: Align.default("center"),
  fullWidth: z.boolean().default(false),
});

export const HighlightBlock = z.object({
  id: BlockId,
  type: z.literal("highlight"),
  title: z.string().max(80).default("Your treatment plan"),
  treatment: z.string().max(240).default("{{case.treatmentSummary}}"),
  totalFee: z.string().max(40).default("{{case.totalFee}}"),
  patientOwes: z.string().max(40).default("{{case.patientPortion}}"),
  monthly: z.string().max(40).default("{{case.monthlyPayment}}"),
  showFinancing: z.boolean().default(true),
  accentColor: HexColor.default("#0ea5b8"),
});

export const SignatureBlock = z.object({
  id: BlockId,
  type: z.literal("signature"),
  source: z.enum(["practice", "doctor", "tc", "custom"]).default("doctor"),
  customText: z.string().max(400).default(""),
  showPhone: z.boolean().default(true),
  showEmail: z.boolean().default(true),
});

export const DividerBlock = z.object({
  id: BlockId,
  type: z.literal("divider"),
  color: HexColor.default("#e2e8f0"),
  thickness: z.number().min(1).max(8).default(1),
  spacing: z.number().min(0).max(48).default(16),
});

export const FooterBlock = z.object({
  id: BlockId,
  type: z.literal("footer"),
  showAddress: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  fineText: z
    .string()
    .max(400)
    .default("You are receiving this email because you are a patient of {{practice.name}}."),
  bgColor: HexColor.default("#f8fafc"),
  textColor: HexColor.default("#64748b"),
});

export const EmailBlock = z.discriminatedUnion("type", [
  HeaderBlock,
  TextBlock,
  ImageBlock,
  ButtonBlock,
  HighlightBlock,
  SignatureBlock,
  DividerBlock,
  FooterBlock,
]);
export type EmailBlock = z.infer<typeof EmailBlock>;
export type EmailBlockType = EmailBlock["type"];

export const EmailBlocks = z.array(EmailBlock).min(1).max(40);
