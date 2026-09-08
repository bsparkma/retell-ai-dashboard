/**
 * Bundle entry for the hygiene shared contract (H1 slice 2).
 *
 * The contract is TypeScript + zod and lives in new-dashboard/shared/hyg/. The
 * backend is plain CommonJS with NO build step (backend/Dockerfile: "no
 * transpile"), so it cannot require .ts at runtime. This entry re-exports the
 * surface the routes need; esbuild bundles it — zod included — into
 * contract.gen.cjs, which is COMMITTED so the Docker image needs no build step
 * and the backend gains no new dependency.
 *
 * Slice 1 deliberately shipped WITHOUT this. Its whole request surface was two
 * query params, and a second 650KB bundle to validate two strings was not worth
 * doubling a byte-compare guard this repo's CLAUDE.md already documents as
 * fragile under a plain `pnpm install`. Slice 2 introduces request BODIES that
 * become chart writes one slice later, and a body is exactly where a client and
 * a server most need the same schema — "the client validated it" is the RCM F3
 * finding restated as a design.
 *
 * Regenerate whenever shared/hyg changes (from new-dashboard/, so the PINNED
 * esbuild devDependency is used — never a floating npx version):
 *
 *   pnpm exec esbuild ../backend/hyg/contract.entry.ts --bundle --platform=node \
 *     --format=cjs --alias:zod=./node_modules/zod \
 *     --outfile=../backend/hyg/contract.gen.cjs
 *
 * Drift guard: new-dashboard/tests/hyg-contract-bundle.test.ts re-bundles with
 * these exact options and fails the build on any diff — a stale bundle is a red
 * build, not a discovery.
 *
 * The --alias is REQUIRED and is not optional tidiness: without it this entry's
 * own `zod` import resolves from backend/node_modules (openai's transitive zod)
 * while the contract's resolves from new-dashboard. Two zod instances in one
 * bundle silently break schema composition (".extend: expected a Zod schema").
 */
export * from "../../new-dashboard/shared/hyg/contract";
export * from "../../new-dashboard/shared/hyg/records";
// The routes compose small request shapes from contract pieces; export the SAME
// zod instance so those shapes and the contract schemas share one library
// version. ZodError is what the 400-shaping helper switches on.
export { z, ZodError } from "zod";
