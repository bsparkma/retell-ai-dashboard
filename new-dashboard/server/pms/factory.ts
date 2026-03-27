/**
 * PMS Adapter Factory
 *
 * Returns the correct PMSAdapter implementation based on tenant config.
 * Tenant config is read from environment variables at startup.
 *
 * Environment variables:
 *   PMS_TYPE            — "OPEN_DENTAL" | "DENTRIX" | "EAGLESOFT"
 *   OD_HOST             — Open Dental MySQL host (when PMS_TYPE=OPEN_DENTAL)
 *   OD_PORT             — Open Dental MySQL port (default: 3306)
 *   OD_DATABASE         — Open Dental database name
 *   OD_USER             — Open Dental MySQL user
 *   OD_PASSWORD         — Open Dental MySQL password
 *   OD_CLINIC_NUM       — ClinicNum for this tenant
 *   NEXHEALTH_API_KEY   — NexHealth API key (when PMS_TYPE=DENTRIX|EAGLESOFT)
 *   NEXHEALTH_PRACTICE_ID — NexHealth practice ID
 */

import { PMSType } from "../scheduling/types.js";
import type { PMSAdapter } from "./adapter.js";
import { OpenDentalAdapter } from "./open-dental.js";
import { DentrixAdapter } from "./dentrix.js";
import { EaglesoftAdapter } from "./eaglesoft.js";

// ---------------------------------------------------------------------------
// Tenant config
// ---------------------------------------------------------------------------

export interface TenantPMSConfig {
  pmsType: PMSType;
  clinicNum: number;
}

// ---------------------------------------------------------------------------
// Singleton adapters per tenant (keyed by clinicNum)
// ---------------------------------------------------------------------------

const adapterCache = new Map<number, PMSAdapter>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Get (or create) the PMS adapter for the given tenant.
 * Adapters are singletons — created once and reused.
 */
export function getPMSAdapter(config: TenantPMSConfig): PMSAdapter {
  const cached = adapterCache.get(config.clinicNum);
  if (cached) return cached;

  const adapter = createAdapter(config);
  adapterCache.set(config.clinicNum, adapter);
  return adapter;
}

function createAdapter(config: TenantPMSConfig): PMSAdapter {
  switch (config.pmsType) {
    case PMSType.OPEN_DENTAL:
      return new OpenDentalAdapter({
        host: requireEnv("OD_HOST"),
        port: parseInt(process.env.OD_PORT ?? "3306", 10),
        database: requireEnv("OD_DATABASE"),
        user: requireEnv("OD_USER"),
        password: requireEnv("OD_PASSWORD"),
        clinicNum: config.clinicNum,
      });

    case PMSType.DENTRIX:
      return new DentrixAdapter({
        nexhealthApiKey: requireEnv("NEXHEALTH_API_KEY"),
        practiceId: requireEnv("NEXHEALTH_PRACTICE_ID"),
        clinicNum: config.clinicNum,
      });

    case PMSType.EAGLESOFT:
      return new EaglesoftAdapter({
        nexhealthApiKey: requireEnv("NEXHEALTH_API_KEY"),
        practiceId: requireEnv("NEXHEALTH_PRACTICE_ID"),
        clinicNum: config.clinicNum,
      });

    default:
      throw new Error(`Unknown PMS type: ${String(config.pmsType)}`);
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Required environment variable ${key} is not set`);
  return val;
}

/**
 * Build TenantPMSConfig from environment variables.
 * Call this at startup to validate the environment is correctly configured.
 */
export function getTenantConfigFromEnv(clinicNum?: number): TenantPMSConfig {
  const pmsTypeStr = process.env.PMS_TYPE ?? "OPEN_DENTAL";
  const pmsType =
    PMSType[pmsTypeStr as keyof typeof PMSType] ?? PMSType.OPEN_DENTAL;
  const resolvedClinicNum =
    clinicNum ?? parseInt(process.env.OD_CLINIC_NUM ?? "0", 10);
  return { pmsType, clinicNum: resolvedClinicNum };
}

/** Clear adapter cache (for testing) */
export function clearAdapterCache(): void {
  adapterCache.clear();
}
