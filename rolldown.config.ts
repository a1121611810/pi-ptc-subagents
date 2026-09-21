import { defineConfig } from "rolldown";

export default defineConfig({
  input: "./src/index.ts",
  platform: "node",
  // Node builtins stay external (the worker/bootstrap strings are data, not imports), and
  // pi's peer packages must stay external too: pi resolves them through its extension
  // loader aliases, and bundling them would ship a second copy of the host's own tool
  // implementations inside this package.
  external: [/^node:/, "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"],
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "index.js",
    sourcemap: true,
    cleanDir: true,
  },
});
