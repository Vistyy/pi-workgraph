import config from "@syzom/typescript-quality/oxlint/effect";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...config,
  ignorePatterns: ["dist/**", "coverage/**"],
  overrides: [
    {
      files: ["test/**/*.test.ts"],
      // node:test callbacks and fake Promise adapters are framework contracts; all safety and Effect boundary rules remain enabled.
      rules: { "effecttsgo/async-function": "off" },
    },
  ],
});
