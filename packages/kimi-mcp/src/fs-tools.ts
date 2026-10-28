import { randomUUID } from "node:crypto";
import {
  globSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { BindingTable } from "@pi-ptc/ptc";

// Kimi 面程序四件套：read / grep / glob / edit，语义对齐 pi 会话工具的常用子集。
// workdir 是信任边界：所有路径先 realpath 再判定（防符号链接逃逸），越界即拒
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SKIP_SUFFIXES = new Set([
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
  ".map",
]);
const GREP_MAX_RESULTS = 500;
const GLOB_MAX_RESULTS = 1000;
const READ_MAX_BYTES = 2 * 1024 * 1024;

function strArg(args: unknown, key: string): string {
  const value = (args as Record<string, unknown>)?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value;
}

// 解析到 jail 内真实路径：存在的直接 realpath；不存在的对父目录 realpath 再拼 basename
function jailed(workdirReal: string, p: string): string {
  const abs = resolve(workdirReal, p);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    real = resolve(realpathSync(dirname(abs)), basename(abs));
  }
  if (real !== workdirReal && !real.startsWith(workdirReal + sep)) {
    throw new Error(`path escapes workdir: ${p}`);
  }
  return real;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(resolve(dir, entry.name));
    } else if (entry.isFile()) {
      yield resolve(dir, entry.name);
    }
  }
}

// 文本读出：太大 / 已知二进制后缀 / 解码出替换符（U+FFFD）的一律跳过，grep 据此静默略过
function readPlainText(file: string): string | undefined {
  const stat = statSync(file);
  const dot = file.lastIndexOf(".");
  const suffix = dot === -1 ? "" : file.slice(dot).toLowerCase();
  if (stat.size > READ_MAX_BYTES || SKIP_SUFFIXES.has(suffix)) return undefined;
  const text = readFileSync(file, "utf8");
  return text.includes("�") ? undefined : text;
}

export function createFsBindings(workdir: string): BindingTable {
  const workdirReal = realpathSync(resolve(workdir));

  return {
    read: async (args) => {
      const real = jailed(workdirReal, strArg(args, "path"));
      const stat = statSync(real);
      if (!stat.isFile()) throw new Error(`not a file: ${strArg(args, "path")}`);
      if (stat.size > READ_MAX_BYTES) {
        throw new Error(`file too large (${stat.size} bytes > ${READ_MAX_BYTES})`);
      }
      return readFileSync(real, "utf8");
    },
    grep: async (args) => {
      const pattern = strArg(args, "pattern");
      const scope =
        typeof (args as Record<string, unknown>)?.path === "string"
          ? jailed(workdirReal, strArg(args, "path"))
          : workdirReal;
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        throw new Error(`invalid pattern: ${pattern}`);
      }
      const hits: string[] = [];
      outer: for (const file of walk(scope)) {
        const text = readPlainText(file);
        if (text === undefined) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            hits.push(`${file.slice(workdirReal.length + 1)}:${i + 1}: ${lines[i]}`);
            if (hits.length >= GREP_MAX_RESULTS) {
              hits.push(`…（已截断：达到 ${GREP_MAX_RESULTS} 条上限）`);
              break outer;
            }
          }
        }
      }
      return hits;
    },
    glob: async (args) => {
      const pattern = strArg(args, "pattern");
      let found: string[];
      try {
        found = globSync(pattern, { cwd: workdirReal }) as string[];
      } catch {
        throw new Error(`invalid glob: ${pattern}`);
      }
      return found.slice(0, GLOB_MAX_RESULTS);
    },
    edit: async (args) => {
      const real = jailed(workdirReal, strArg(args, "path"));
      const oldString = strArg(args, "old_string");
      const newString = strArg(args, "new_string");
      const text = readFileSync(real, "utf8");
      const count = text.split(oldString).length - 1;
      if (count === 0) throw new Error("old_string not found");
      if (count > 1) throw new Error(`old_string matches ${count} places — must be unique`);
      const tmp = `${real}.ptc-${randomUUID()}`;
      writeFileSync(tmp, text.replace(oldString, newString), "utf8");
      renameSync(tmp, real); // 原子落盘：半途不写坏原文件
      return { edited: real.slice(workdirReal.length + 1) };
    },
  };
}
