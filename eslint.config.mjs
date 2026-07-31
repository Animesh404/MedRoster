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
    // A leading underscore is the deliberate "this parameter exists to satisfy
    // a signature I do not control" marker — test doubles standing in for a
    // Supabase admin call, for instance, must accept the arguments the real
    // API passes whether or not the double reads them. Without this, the only
    // ways to keep the lint clean are to lie about the signature or to litter
    // disable comments, and the go-live gate runs eslint at --max-warnings 0.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
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
