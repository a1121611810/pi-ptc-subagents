import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    worker: "src/worker-entry.ts",
  },
  platform: "node",
  external: [/^@earendil-works\//],
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
  },
});
