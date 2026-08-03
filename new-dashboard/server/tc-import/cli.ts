/**
 * TC legacy importer — CLI entry (Slice 2).
 *
 * One-shot import of the legacy TC-app data directory into the tc_* tables
 * and Azure Blob. DRY-RUN IS THE DEFAULT: without --execute nothing is
 * written anywhere. Launch via backend/scripts/tc-import.cjs (the repo's
 * script convention) or directly:
 *
 *   pnpm exec tsx server/tc-import/cli.ts --data-dir <legacy TC-app server/data> [options]
 *
 * Options:
 *   --data-dir <path>        REQUIRED. Legacy data directory (read-only).
 *   --execute                Actually write to DB + Blob (default: dry-run).
 *   --tenant-slug <slug>     Tenant for blob keys (default: carein).
 *   --default-office <id>    roland|valley for entities with no location (default: roland).
 *   --user-map <path>        JSON { legacyUserId: platformEmail } for tc_legacy_user_map.
 *   --blob-account <name>    Storage account (execute mode; e.g. stcareinstaging).
 *   --blob-container <name>  Blob container (default: tc-media).
 *
 * Environment (execute mode):
 *   TC_IMPORT_DB_URL   Tenant DB connection string (fetch from Key Vault into
 *                      the session; never print, never commit).
 *
 * Auth for Blob: DefaultAzureCredential (az login on a workstation). No SAS
 * tokens, no account keys — the account has shared-key auth disabled.
 */
import * as fs from "node:fs";
import { OfficeId } from "@shared/tc/contract";
import { buildBlobKey, createBlobStore } from "../../../backend/services/blobStore.js";
import { loadLegacyDataDir } from "./loadLegacy";
import { buildImportPlan } from "./plan";
import { executePlan } from "./execute";
import { formatReport } from "./report";
import { PgImportTarget } from "./pgTarget";
import { emptyExistingState } from "./types";

interface CliArgs {
  dataDir: string;
  execute: boolean;
  tenantSlug: string;
  defaultOffice: OfficeId;
  userMapPath: string | null;
  blobAccount: string | null;
  blobContainer: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dataDir: "",
    execute: false,
    tenantSlug: "carein",
    defaultOffice: "roland",
    userMapPath: null,
    blobAccount: null,
    blobContainer: "tc-media",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") args.dataDir = argv[++i] ?? "";
    else if (a === "--execute") args.execute = true;
    else if (a === "--tenant-slug") args.tenantSlug = argv[++i] ?? "";
    else if (a === "--default-office") args.defaultOffice = OfficeId.parse(argv[++i]);
    else if (a === "--user-map") args.userMapPath = argv[++i] ?? null;
    else if (a === "--blob-account") args.blobAccount = argv[++i] ?? null;
    else if (a === "--blob-container") args.blobContainer = argv[++i] ?? "tc-media";
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.dataDir) throw new Error("--data-dir is required");
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const userEmailOverrides: Record<string, string> = args.userMapPath
    ? (JSON.parse(fs.readFileSync(args.userMapPath, "utf8")) as Record<string, string>)
    : {};

  const data = loadLegacyDataDir(args.dataDir);
  const options = {
    tenantSlug: args.tenantSlug,
    defaultOffice: args.defaultOffice,
    userEmailOverrides,
  };
  const makeBlobKey = (entity: "gallery" | "smile-sim" | "email", ext: string): string =>
    buildBlobKey({ tenantSlug: args.tenantSlug, module: "tc", entity, ext });

  if (!args.execute) {
    const plan = buildImportPlan(data, options, emptyExistingState(), { makeBlobKey });
    console.log(formatReport(plan, data, "dry-run"));
    return plan.recon.some((r) => r.errors.length > 0) ? 2 : 0;
  }

  // ── Execute mode ─────────────────────────────────────────────────────────
  const dbUrl = process.env.TC_IMPORT_DB_URL;
  if (!dbUrl) throw new Error("TC_IMPORT_DB_URL is required with --execute (fetch from Key Vault)");
  if (!args.blobAccount) throw new Error("--blob-account is required with --execute");

  const target = new PgImportTarget(dbUrl);
  await target.connect();
  try {
    const existing = await target.fetchExistingState();
    const plan = buildImportPlan(data, options, existing, { makeBlobKey });

    const store = createBlobStore({
      accountName: args.blobAccount,
      containerName: args.blobContainer,
    });
    const result = await executePlan(plan, target, {
      async upload(key, buf, contentType) {
        await store.upload(key, buf, contentType);
      },
    });
    console.log(formatReport(plan, data, "execute", result));
    return plan.recon.some((r) => r.errors.length > 0) ? 2 : 0;
  } finally {
    await target.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`tc-import FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
