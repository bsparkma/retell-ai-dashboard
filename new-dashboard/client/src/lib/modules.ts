/**
 * Platform module registry (client side).
 *
 * Module ids mirror the backend tenant_module vocabulary (CHECK constraint in
 * carein_control): 'voice' | 'rcm' | 'tc' | 'hyg' | 'scheduling'. The SPA uses this to
 * decide which product shells to render — UI convenience only; the backend
 * requireModule() 403 is the source of truth for entitlement.
 *
 * Voice is the existing dashboard (all current pages) and the default module.
 * Other modules gain entries (label + basePath) when their first pages land;
 * until then an entitled-but-unbuilt module simply isn't in this registry and
 * won't render.
 */

import { KanbanSquare, PhoneCall, Receipt, Sparkles, type LucideIcon } from "lucide-react";

export const MODULE_IDS = ["voice", "rcm", "tc", "hyg", "scheduling"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface ModuleDef {
  id: ModuleId;
  label: string;
  /** One-line pitch shown on the /home module tile. */
  description: string;
  /** Tile icon on /home (the sidebar keeps its own per-page icons). */
  icon: LucideIcon;
  /** The module's home route — where its tile and the switcher land. */
  basePath: string;
}

/** Modules the SPA can actually render today. Voice = the whole current app. */
export const MODULES: Partial<Record<ModuleId, ModuleDef>> = {
  voice: {
    id: "voice",
    label: "Voice",
    description: "AI phone agent — calls, callbacks, scheduling, and analytics.",
    icon: PhoneCall,
    basePath: "/dashboard",
  },
  tc: {
    id: "tc",
    label: "Treatment Coordinator",
    description: "Case pipeline, follow-ups, pre-auth, and patient presentations.",
    icon: KanbanSquare,
    basePath: "/tc",
  },
  hyg: {
    id: "hyg",
    label: "Hygiene",
    description: "The hygiene day, the routing slip, and the handoff to TC.",
    icon: Sparkles,
    basePath: "/hyg/day",
  },
  rcm: {
    id: "rcm",
    label: "RCM",
    description: "Claims, payment batches, and the posting queue.",
    icon: Receipt,
    basePath: "/rcm",
  },
};

export const DEFAULT_MODULE: ModuleId = "voice";

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}

/** Entitled module ids (from /auth/me), narrowed to known ids, stable order. */
export function entitledModuleIds(raw: readonly string[] | undefined): ModuleId[] {
  if (!Array.isArray(raw)) return [];
  return MODULE_IDS.filter((id) => raw.includes(id));
}

/**
 * Is this tenant entitled to `id`? Mirrors the backend's isEntitledModule() and
 * fails closed the same way: no list, or a list that isn't an array, reads as
 * NOT entitled. Used to hide cross-module affordances (e.g. the voice side's
 * "Send to TC") from a tenant that doesn't have the other module — UI convenience
 * only; the backend requireModule() 403 remains the source of truth.
 */
export function hasModule(raw: readonly string[] | undefined, id: ModuleId): boolean {
  return entitledModuleIds(raw).includes(id);
}

/**
 * Resolve which module is active given a remembered selection and the
 * entitlement list. Pure so it's directly unit-testable:
 *  - remembered selection wins when still entitled,
 *  - otherwise the default module if entitled,
 *  - otherwise the first entitled module,
 *  - otherwise the default (renders as "no modules" upstream; harmless).
 */
export function resolveActiveModule(
  stored: string | null,
  entitled: readonly ModuleId[],
): ModuleId {
  if (isModuleId(stored) && entitled.includes(stored)) return stored;
  if (entitled.includes(DEFAULT_MODULE)) return DEFAULT_MODULE;
  return entitled[0] ?? DEFAULT_MODULE;
}
