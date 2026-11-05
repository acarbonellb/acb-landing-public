import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// The agent imports site code only through the shared module (`src/shared/`
// at the repo root), which is lint-checked to stay free of React, Next and the
// DOM (../eslint.config.mjs). Import strings are relative, so the prefix that
// leaves `agent/` depends on how deep the importing file sits: one config per
// depth, deep enough for any folder the agent will grow.
const maxDepth = 8;
const siteBoundary = Array.from({ length: maxDepth + 1 }, (_, depth) => ({
  files: [`${"*/".repeat(depth)}*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: `^(?:\\.\\./){${depth + 1}}(?!src/shared/)`,
            message:
              "The agent imports site code only from src/shared/. Move what it needs there.",
          },
        ],
      },
    ],
  },
}));

export default defineConfig([
  globalIgnores(["dist/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...siteBoundary,
]);
