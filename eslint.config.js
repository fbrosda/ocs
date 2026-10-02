// Flat config. ESLint 10 removed `.eslintrc.*` support; this is the same
// rule set the old file declared, expressed the way flat config expects.
//
// Order matters and is the whole trick: `recommended` first, then prettier
// last so the formatting rules win over anything stylistic above it.
import js from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      // Turns off the base rules TypeScript already enforces (no-undef,
      // no-unused-vars and friends), so we are not told twice.
      ...tsPlugin.configs["eslint-recommended"].rules,
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Must stay last: it switches off every formatting rule.
      ...eslintConfigPrettier.rules,
    },
  },
];