/**
 * Platform module registry (client side).
 *
 * Module ids mirror the backend tenant_module vocabulary (CHECK constraint in
 * carein_control): 'voice' | 'rcm' | 'tc' | 'scheduling'. The SPA uses this to
 * decide which product shells to render — UI convenience only; the backend
 * requireModule() 403 is the source of truth for entitlement.
 *
 * Voice is the existing dashboard (all current pages) and the default module.
 * Other modules gain entries (label + basePath) when their first pages land;
 * until then an entitled-but-unbuilt module simply isn't in this registry and
 * won't render.
 */

export const MODULE_IDS = ["voice", "rcm", "tc", "scheduling"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface ModuleDef {
  id: ModuleId;
  label: string;
  /** Route prefix the module's pages live under ("/" for voice today). */
  basePath: string;
}

/** Modules the SPA can actually render today. Voice = the whole current app. */
export const MODULES: Partial<Record<ModuleId, ModuleDef>> = {
  voice: { id: "voice", label: "Voice", basePath: "/" },
  tc: { id: "tc", label: "Treatment Coordinator", basePath: "/tc" },
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
