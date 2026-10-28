import { randomUUID } from "node:crypto";
import { globSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
// src/fs-tools.ts
const SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git"]);
const SKIP_SUFFIXES = /* @__PURE__ */ new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".zip",
	".gz",
	".tgz",
	".pdf",
	".woff",
	".woff2",
	".map"
]);
const GREP_MAX_RESULTS = 500;
const GLOB_MAX_RESULTS = 1e3;
const READ_MAX_BYTES = 2097152;
function strArg(args, key) {
	const value = args?.[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} 必须是非空字符串`);
	return value;
}
function jailed(workdirReal, p) {
	const abs = resolve(workdirReal, p);
	let real;
	try {
		real = realpathSync(abs);
	} catch {
		real = resolve(realpathSync(dirname(abs)), basename(abs));
	}
	if (real !== workdirReal && !real.startsWith(workdirReal + sep)) throw new Error(`path escapes workdir: ${p}`);
	return real;
}
function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) {
		if (SKIP_DIRS.has(entry.name)) continue;
		yield* walk(resolve(dir, entry.name));
	} else if (entry.isFile()) yield resolve(dir, entry.name);
}
function readPlainText(file) {
	const stat = statSync(file);
	const dot = file.lastIndexOf(".");
	const suffix = dot === -1 ? "" : file.slice(dot).toLowerCase();
	if (stat.size > READ_MAX_BYTES || SKIP_SUFFIXES.has(suffix)) return void 0;
	const text = readFileSync(file, "utf8");
	return text.includes("�") ? void 0 : text;
}
function createFsBindings(workdir) {
	const workdirReal = realpathSync(resolve(workdir));
	return {
		read: async (args) => {
			const real = jailed(workdirReal, strArg(args, "path"));
			const stat = statSync(real);
			if (!stat.isFile()) throw new Error(`not a file: ${strArg(args, "path")}`);
			if (stat.size > READ_MAX_BYTES) throw new Error(`file too large (${stat.size} bytes > ${READ_MAX_BYTES})`);
			return readFileSync(real, "utf8");
		},
		grep: async (args) => {
			const pattern = strArg(args, "pattern");
			const scope = typeof args?.path === "string" ? jailed(workdirReal, strArg(args, "path")) : workdirReal;
			let regex;
			try {
				regex = new RegExp(pattern);
			} catch {
				throw new Error(`invalid pattern: ${pattern}`);
			}
			const hits = [];
			outer: for (const file of walk(scope)) {
				const text = readPlainText(file);
				if (text === void 0) continue;
				const lines = text.split("\n");
				for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) {
					hits.push(`${file.slice(workdirReal.length + 1)}:${i + 1}: ${lines[i]}`);
					if (hits.length >= GREP_MAX_RESULTS) {
						hits.push(`…（已截断：达到 ${GREP_MAX_RESULTS} 条上限）`);
						break outer;
					}
				}
			}
			return hits;
		},
		glob: async (args) => {
			const pattern = strArg(args, "pattern");
			let found;
			try {
				found = globSync(pattern, { cwd: workdirReal });
			} catch {
				throw new Error(`invalid glob: ${pattern}`);
			}
			return found.slice(0, GLOB_MAX_RESULTS);
		},
		edit: async (args) => {
			const real = jailed(workdirReal, strArg(args, "path"));
			const oldString = strArg(args, "old_string");
			const text = readFileSync(real, "utf8");
			const count = text.split(oldString).length - 1;
			if (count === 0) throw new Error("old_string not found");
			if (count > 1) throw new Error(`old_string matches ${count} places — must be unique`);
			const tmp = `${real}.ptc-${randomUUID()}`;
			writeFileSync(tmp, text.replace(oldString, newString), "utf8");
			renameSync(tmp, real);
			return { edited: real.slice(workdirReal.length + 1) };
		}
	};
}
export { createFsBindings as t };
