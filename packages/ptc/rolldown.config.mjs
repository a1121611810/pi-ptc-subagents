import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    worker: "src/worker-entry.ts",
    cli: "src/cli.ts",
  },
  platform: "node",
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
  },
});
