/**
 * /tc/settings — section registry and hash deep-link helpers.
 *
 * The order, labels, and icons mirror the legacy DentaFlow Settings shell so
 * the arrangement is familiar. What each section CONTAINS is platform reality:
 * four sections reuse the existing office-library editors (same write path as
 * /tc/library — there is deliberately no second one), and four are read-only
 * or explanatory because the platform owns that data elsewhere.
 */
import {
  Bell,
  BookOpen,
  Building2,
  Crown,
  LayoutList,
  Mail,
  Percent,
  Plug,
  Send,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PermissionAction } from "@/lib/permissions";

export type TcSettingsSectionKey =
  | "practice"
  | "pricing"
  | "financing"
  | "team"
  | "stages"
  | "library"
  | "integrations"
  | "data"
  | "notifications"
  | "email_identity"
  | "referrals";

export interface TcSettingsSection {
  key: TcSettingsSectionKey;
  label: string;
  icon: LucideIcon;
  /** Sections whose editors need the office library loaded first. */
  needsLibrary: boolean;
  /**
   * Shown only while referrals is switched on for the office (item 52).
   * TcSettings asks /api/tc/referrals/status and leaves the section out of the
   * nav when it is off, or when the answer cannot be had.
   */
  requiresReferrals?: boolean;
  /**
   * Shown only to a caller who holds this action (R5c). UX only: the server
   * refuses everyone else regardless.
   */
  requiresPermission?: PermissionAction;
}

export const TC_SETTINGS_SECTIONS: readonly TcSettingsSection[] = [
  { key: "practice", label: "Practice", icon: Building2, needsLibrary: false },
  { key: "pricing", label: "Pricing", icon: Crown, needsLibrary: true },
  { key: "financing", label: "Financing", icon: Percent, needsLibrary: true },
  { key: "team", label: "Team", icon: Users, needsLibrary: false },
  { key: "stages", label: "Stages", icon: LayoutList, needsLibrary: true },
  { key: "library", label: "Library", icon: BookOpen, needsLibrary: true },
  { key: "integrations", label: "Integrations", icon: Plug, needsLibrary: false },
  { key: "data", label: "Data & Backup", icon: ShieldCheck, needsLibrary: false },
  // Item 51: in-app alert preferences — yours, and the office default (admin).
  { key: "notifications", label: "Notifications", icon: Bell, needsLibrary: false },
  // R5c: the office's email reply-to, practice name and phone. Admin + office.
  {
    key: "email_identity",
    label: "Email identity",
    icon: Mail,
    needsLibrary: false,
    requiresPermission: "tc.notification_defaults",
  },
  // Item 52: the specialist directory and the referral policies. Dark per office.
  { key: "referrals", label: "Referrals", icon: Send, needsLibrary: false, requiresReferrals: true },
];

export const DEFAULT_TC_SETTINGS_SECTION: TcSettingsSectionKey = "practice";

const KEYS: readonly string[] = TC_SETTINGS_SECTIONS.map((s) => s.key);

/** `"#pricing"` / `"pricing"` → `"pricing"`; anything else → the default. */
export function sectionFromHash(hash: string): TcSettingsSectionKey {
  const raw = hash.replace(/^#/, "");
  return KEYS.includes(raw)
    ? (raw as TcSettingsSectionKey)
    : DEFAULT_TC_SETTINGS_SECTION;
}

export function currentSectionFromLocation(): TcSettingsSectionKey {
  if (typeof window === "undefined") return DEFAULT_TC_SETTINGS_SECTION;
  return sectionFromHash(window.location.hash);
}

export function sectionMeta(key: TcSettingsSectionKey): TcSettingsSection {
  const found = TC_SETTINGS_SECTIONS.find((s) => s.key === key);
  // The registry is exhaustive over TcSettingsSectionKey; the fallback only
  // exists to keep the return type non-nullable.
  return found ?? TC_SETTINGS_SECTIONS[0];
}
