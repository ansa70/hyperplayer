import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

// In development the API is a local HyperPlayer server (`vp run server`), reached through
// this dev server so the page and the API share one origin, as when the server serves
// the built app. Its Host header is kept, so the server's same-origin check passes.
const server = process.env.HP_DEV_SERVER ?? "https://127.0.0.1:4533";

export default defineConfig({
  plugins: lazyPlugins(() => [react()]),
  server: {
    proxy: { "/api": { target: server, secure: false } },
  },
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
});
