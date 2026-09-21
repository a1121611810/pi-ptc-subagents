import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
  input: "./src/index.ts",
  platform: "node",
  // Node builtins stay external (the worker/bootstrap strings are data, not imports), and
  // pi's peer packages must stay external too: pi resolves them through its extension
  // loader aliases, and bundling them would ship a second copy of the host's own tool
  // implementations inside this package.
  external: [/^node:/, "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"],
  // One bundled dist/index.d.ts from the declaration tree (oxc generator — auto-selected
  // because tsconfig enables isolatedDeclarations, which the source satisfies).
  //
  // Do NOT set `output.entryFileNames`: hard-coding it breaks this plugin's dts pipeline —
  // it then emits its raw intermediate as `dist/index.ts` instead of `index.d.ts`
  // (reproduced on rolldown-plugin-dts 0.28.6 + rolldown 1.2.9). The default `[name].js`
  // naming already produces `index.js`.
  plugins: [dts({ sourcemap: true })],
  output: {
    dir: "dist",
    format: "esm",
    sourcemap: true,
    cleanDir: true,
  },
});
