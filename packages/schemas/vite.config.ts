import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      generate: {
        command: "vpx scripts/generate.ts",
        cache: { input: [{ auto: true }, "!../../api/**"] },
      },
    },
  },
});
