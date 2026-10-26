import { existsSync, realpathSync } from "node:fs";
export function resolve(specifier, context, next) {
  if (specifier.startsWith("@earendil-works/")) {
    const sub = specifier.slice("@earendil-works/".length);
    const base = "/tmp/pi-cap-matrix/v0-99-0/node_modules";
    const candidates = sub.includes("/")
      ? [base + "/" + sub]
      : [
          base + "/@earendil-works/" + sub + "/dist/index.js",
          base + "/@earendil-works/" + sub + "/index.js",
        ];
    const hit = candidates.find((c) => existsSync(c));
    if (hit) return { url: "file://" + realpathSync(hit), shortCircuit: true };
  }
  return next(specifier, context);
}
