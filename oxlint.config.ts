import config from "@syzom/typescript-quality/oxlint/effect";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...config,
  ignorePatterns: ["dist/**", "coverage/**"],
  overrides: [
    {
      files: ["test/**/*.test.ts"],
      rules: { "effecttsgo/async-function": "off" },
    },
  ],
});
