// PROTOTYPE helper: same probe with a 200KB payload to measure the worst-case rejection size.
import { writeFileSync } from "node:fs";

const nm = "/tmp/lead086/node_modules";
const NL = String.fromCharCode(10);

const loader = [
  'import { existsSync, realpathSync } from "node:fs";',
  'import { pathToFileURL } from "node:url";',
  "const BASE = " + JSON.stringify(nm) + ";",
  "export function resolve(specifier, context, next) {",
  '  if (specifier.startsWith("@earendil-works/")) {',
  '    const sub = specifier.slice("@earendil-works/".length);',
  '    const candidates = sub.includes("/")',
  '      ? [BASE + "/" + sub]',
  "      : [",
  '          BASE + "/@earendil-works/" + sub + "/dist/index.js",',
  '          BASE + "/@earendil-works/" + sub + "/index.js",',
  "        ];",
  "    const hit = candidates.find((c) => existsSync(c));",
  "    if (hit) return { url: pathToFileURL(realpathSync(hit)).href, shortCircuit: true };",
  "  }",
  "  return next(specifier, context);",
  "}",
].join(NL);
writeFileSync("/tmp/b086-loader-big.mjs", loader);

const head = "PTCHEAD0000";
const tail = "PTCTAIL9999";
const filler = "y".repeat(200 * 1024);
const command = "printf '%s" + NL + "' '" + head + filler + tail + "'; exit 3";
const script = [
  'import { register } from "node:module";',
  'import { pathToFileURL } from "node:url";',
  'register(pathToFileURL("/tmp/b086-loader-big.mjs").href, pathToFileURL(' +
    JSON.stringify(nm + "/") +
    "));",
  'const { createBuiltinBindings } = await import("/Users/lilianda/develop/pi-ptc-subagents/dist/index.js");',
  'const bindings = createBuiltinBindings({ cwd: process.cwd(), optIns: ["bash"] });',
  "const command = " + JSON.stringify(command) + ";",
  "try {",
  '  await bindings.get("bash").execute({ command }, { callId: 1 });',
  '  console.log("RESOLVED (unexpected on 0.86.1?)");',
  "} catch (e) {",
  "  const m = String(e.message);",
  '  console.log("binding rejection length:", m.length);',
  '  console.log("has head marker:", m.includes("PTCHEAD0000"));',
  '  console.log("has tail marker:", m.includes("PTCTAIL9999"));',
  "}",
].join(NL);
writeFileSync("/tmp/b086-bind-big.mjs", script);
console.log("written");
