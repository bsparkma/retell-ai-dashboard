import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["server/lib/ingestion.ts", "server/lib/analytics.ts", "server/lib/commlog.ts"],
      exclude: ["server/lib/seed.ts", "server/lib/store.ts", "server/lib/types.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 75,
        statements: 75,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
});
