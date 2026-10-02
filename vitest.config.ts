import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // `*.int.test.ts` matches `*.test.ts`, so without this the integration suite
    // — which actually invokes bubblewrap — runs as part of `npm test`. AGENTS.md
    // is explicit that `npm test` needs no sandbox and no privileges.
    exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
  },
});
