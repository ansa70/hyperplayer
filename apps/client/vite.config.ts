import { defineConfig } from "vite-plus";

// Cargo has its own incremental cache, so these tasks opt out of Vite Task caching.
// Every task regenerates api/schema.json first so the Rust types match the Zod schemas.
const generate = "@hyperplayer/schemas#generate";

export default defineConfig({
  run: {
    tasks: {
      dev: { command: "cargo run", dependsOn: [generate], cache: false },
      build: { command: "cargo build --release", dependsOn: [generate], cache: false },
      test: { command: "cargo test", dependsOn: [generate], cache: false },
      lint: {
        command: ["cargo fmt --check", "cargo clippy --all-targets -- -D warnings"],
        dependsOn: [generate],
        cache: false,
      },
    },
  },
});
