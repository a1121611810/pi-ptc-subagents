import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  platform: "node",
  external: [/^@earendil-works\//],
  output: {
    file: "dist/index.js",
    format: "esm",
  },
});
