/**
 * Bundle entry for the TC shared contract (Slice 3).
 *
 * The strict TC contract is TypeScript + zod and lives in
 * new-dashboard/shared/tc/ (design authority, PR #23). The backend is plain
 * CommonJS with NO build step (see backend/Dockerfile: "no transpile"), so it
 * cannot require .ts at runtime. This entry re-exports the contract surface the
 * routes need; esbuild bundles it (zod included) into contract.gen.cjs, which
 * is COMMITTED so the Docker image needs no build step and the backend gains
 * no new dependency.
 *
 * Regenerate whenever shared/tc changes (from new-dashboard/, where esbuild is
 * a devDependency):
 *
 *   npx esbuild ../backend/tc/contract.entry.ts --bundle --platform=node \
 *     --format=cjs --alias:zod=./node_modules/zod \
 *     --outfile=../backend/tc/contract.gen.cjs
 *
 * The --alias is REQUIRED: without it this entry's own `zod` import resolves
 * from backend/node_modules (openai's transitive zod) while the contract's
 * resolves from new-dashboard — two zod instances in one bundle silently break
 * schema composition (".extend: expected a Zod schema").
 *
 * legacy.ts is deliberately NOT exported — legacy-JSON mapping belongs to the
 * Slice 2 importer, not the API surface.
 */
export * from "../../new-dashboard/shared/tc/contract";
export * from "../../new-dashboard/shared/tc/rows";
export * from "../../new-dashboard/shared/tc/emailBlocks";
// The routes compose small request shapes (status-transition bodies, complete/
// reschedule payloads) from contract pieces; export the SAME zod instance so
// those shapes and the contract schemas share one library version.
export { z, ZodError } from "zod";
