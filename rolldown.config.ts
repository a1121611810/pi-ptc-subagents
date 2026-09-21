import { defineConfig } from "rolldown";

export default defineConfig({
  input: "./src/index.ts",
  platform: "node",
  // Node builtins stay external; the worker/bootstrap strings are data, not imports.
  external: [/^node:/],
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "index.js",
    sourcemap: true,
    cleanDir: true,
  },
});
