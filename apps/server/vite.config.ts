import { defineConfig } from "vite-plus";

export default defineConfig({
  // The release build (`vp pack`): one file with every dependency but sharp, whose
  // native parts ship beside it in node_modules.
  pack: {
    entry: ["src/main.ts"],
    platform: "node",
    format: "esm",
    outDir: "dist",
    clean: true,
    dts: false,
    deps: { alwaysBundle: [/^(?!sharp$)/], onlyBundle: false },
  },
});
