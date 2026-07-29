import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Playwright fixtures are declared as `async ({ page }, use) => { … use(x) }`.
    // That `use` is Playwright's fixture-provider callback, not React's `use`
    // hook, but rules-of-hooks matches on the bare identifier and flags every
    // fixture as a hook called outside a component. The rule has nothing to say
    // about a browser-driver file, so it is off here rather than worked around
    // by renaming Playwright's own API.
    files: ["e2e/**/*.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
