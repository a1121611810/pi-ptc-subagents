import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
  },
  platform: "node",
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "esm",
  },
});
