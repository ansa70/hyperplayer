import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 110,
    ignorePatterns: ["api/**", "target/**"],
  },
  lint: {
    ignorePatterns: ["api/**", "target/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
