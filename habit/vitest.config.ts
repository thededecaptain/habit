import { defineConfig } from "vitest/config";

// Kept apart from vite.config.ts: the React Router plugin there takes over
// the build and isn't wanted when running tests.
const shared = ["test/setup/env.ts", "test/setup/shopify-mock.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
          setupFiles: shared,
        },
      },
      {
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          environment: "node",
          // One real Postgres per run (embedded-postgres, same major as
          // production), migrated with `prisma migrate deploy`. Files share it,
          // so they run one at a time and each test starts from empty tables.
          globalSetup: ["test/setup/db-global.ts"],
          setupFiles: [...shared, "test/setup/db-each.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "ui",
          include: ["test/ui/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: [...shared, "test/setup/ui.ts"],
        },
      },
      {
        test: {
          name: "storefront",
          include: ["test/storefront/**/*.test.ts"],
          environment: "jsdom",
        },
      },
      {
        esbuild: { jsx: "automatic", jsxImportSource: "preact" },
        test: {
          name: "extensions",
          include: ["test/extensions/**/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "app/lib/**/*.ts",
        "app/routes/**/*.{ts,tsx}",
        "app/components/**/*.tsx",
        "extensions/points-widget/assets/*.js",
        "extensions/redeem-points/src/*.jsx",
        "extensions/account-rewards/src/*.jsx",
      ],
      exclude: ["**/*.test.*", "**/*.d.ts"],
      reporter: ["text-summary", "text", "html", "json-summary"],
      reportsDirectory: "coverage",
      // CI fails if coverage drops below these. What's left uncovered is
      // defensive fallbacks and Shopify's template error boundaries.
      thresholds: {
        lines: 99,
        statements: 99,
        functions: 98,
        branches: 90,
      },
    },
  },
});
