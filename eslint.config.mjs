import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Framework imports that site-only code may use but the shared module and the
// site's library folder may not.
const frameworkImports = [
  {
    group: ["react", "react/**", "react-dom", "react-dom/**"],
    message: "No React here.",
  },
  { group: ["next", "next/**"], message: "No Next here." },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The shared module (`src/shared/`) is bundled into the agent service, which
  // runs on Node with no React, no Next, no `@/` alias and no DOM. It imports
  // only itself; the agent imports nothing else from the site
  // (agent/eslint.config.js).
  {
    files: ["src/shared/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...frameworkImports.map((p) => ({
              ...p,
              message: `${p.message} The agent bundles src/shared/.`,
            })),
            {
              group: ["@/**"],
              message:
                "No path aliases in src/shared/: the agent doesn't resolve them.",
            },
            {
              group: ["../**"],
              message:
                "src/shared/ imports only itself: the agent bundles it alone.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "document",
          "navigator",
          "location",
          "history",
          "localStorage",
          "sessionStorage",
          "matchMedia",
          "requestAnimationFrame",
          "self",
        ].map((name) => ({
          name,
          message: "No browser globals in src/shared/: the agent runs on Node.",
        })),
      ],
    },
  },
  // The site's library folder holds framework-free site code; hooks and
  // components live in src/components/.
  {
    files: ["src/lib/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: frameworkImports.map((p) => ({
            ...p,
            message: `${p.message} src/lib/ is framework-free: put it in src/components/.`,
          })),
        },
      ],
    },
  },
  // Browser specs take `test` from e2e/fixtures.ts, which keeps the page off
  // every server but the local one: CI tests the build it deploys, which
  // holds the production agent URL.
  {
    files: ["e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@playwright/test",
              importNames: ["test", "expect"],
              message:
                "Import test and expect from ./fixtures: it keeps the page off the production agent.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The agent service lints itself (agent/eslint.config.js).
    "agent/**",
  ]),
]);

export default eslintConfig;
