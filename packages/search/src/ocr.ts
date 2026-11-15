// DeepSeek OCR：把本地 PDF / Word / PPT / 图片转成文字（官方 POST /v1/tools/ocr，multipart 上传）
// 形状与 web_ds_search 同族：宿主中立核住本包，pi 形状住 entry、Kimi 形状住 kimi-mcp；
// 只活在子代理里（ADR-0003），只在子代理注册（ADR-0002 门禁）。
// 文件会离开本机上传到 DeepSeek 侧——工具描述里必须写明这件事（模型与用户都要知道）。
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { sanitizeText } from "@pi-ptc/tui";
import { redact, retryHint } from "./deepseek.ts";
import type { SearchMemory } from "./memory.ts";
import type { SearchOutcome } from "./provider.ts";
import { SEARCH_TEXT_BUDGET_CHARS } from "./provider.ts";
import type { SearchQuota } from "./quota.ts";
export type OcrRunResult =
  | {
      ok: true;
      text: string;
      /** 官方报告的总页数 */
      pageCount: number;
      /** 实际放进文本的页数 */
      pages: number;
      /** 有页被官方按页截断 */
      truncated: boolean;
      /** 记忆命中（未发请求） */
      cached: boolean;
    }
  | { ok: false; error: string };

const DEFAULT_OCR_API = "https://api.deepseek.com/v1/tools/ocr";
/** 官方口径：单文件 ≤100 MiB、≤1000 页、整体 ≤180s（上传 ≤120s） */
const OCR_MAX_BYTES = 100 * 1024 * 1024;
const OCR_TIMEOUT_MS = 180_000;

export interface OcrPage {
  index: number;
  text: string;
  /** 官方 finish_reason：stop=完整，length=该页被官方截断（文本不完整，必须告知模型） */
  finishReason?: string;
}

export interface OcrResult {
  pageCount: number;
  pages: OcrPage[];
}

export interface OcrProvider {
  readonly id: string;
  /** 识别一个本地文件；root 是工作区边界，越界即拒（fail-closed） */
  ocr(filePath: string, root: string): Promise<SearchOutcome<OcrResult>>;
}

export interface OcrRunContext {
  provider: OcrProvider;
  /** 记忆按真实路径做键：同一份文件重复识别不重复计费 */
  memory: SearchMemory;
  /** 与搜索共用同一份进程级配额（一个进程的 DeepSeek 调用总护栏） */
  quota: SearchQuota;
  /** 工作区边界：只允许这个目录下的文件 */
  root: string;
  /** 模型可见文本预算；告知语不占预算 */
  textBudgetChars?: number;
}

/** 工作区边界校验：先按字面判（越界路径立刻拒，即便文件不存在），再按软链解析后的真实路径判 */
export function resolveJailed(root: string, filePath: string): string {
  const rootReal = realpathSync(resolve(root));
  const lexical = resolve(rootReal, filePath);
  if (lexical !== rootReal && !lexical.startsWith(rootReal + sep)) {
    throw new Error(`路径越出工作区（只允许 ${rootReal} 内的文件）：${filePath}`);
  }
  // 软链指向外部也要拒：字面在工作区内、真实路径在外面
  const real = realpathSync(lexical);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`路径越出工作区（软链指向外部）：${filePath}`);
  }
  return real;
}

// 官方：逐页识别的结果会带版面标记 —— <｜ref｜>包裹的是**正文**（剥标记不剥字），
// <｜box｜>[[…]]<｜box｜>是坐标（整组剥掉）
const OCR_MARKUP = /<[|｜]ref[|｜]>|<[|｜]box[|｜]>\s*\[\[[\s\S]*?\]\]\s*<[|｜]box[|｜]>/g;

export function stripOcrMarkup(text: string): string {
  return text.replace(OCR_MARKUP, "");
}

/** 归约：逐页给正文；超预算的页整页丢弃并明说省略了哪些；官方按页截断的页也要明说 */
export function renderOcrText(result: OcrResult, budgetChars: number, label: string): string {
  const kept: string[] = [];
  const dropped: number[] = [];
  const truncated: number[] = [];
  let used = 0;
  for (const page of result.pages) {
    const pageNo = page.index + 1;
    if (page.finishReason === "length") truncated.push(pageNo);
    const text = stripOcrMarkup(page.text).trim();
    const block = `--- 第 ${pageNo} 页 ---\n${text}`;
    // 第一页永远给（同 search 概览的处置）：否则模型什么都拿不到
    if (kept.length > 0 && used + block.length > budgetChars) {
      dropped.push(pageNo);
      continue;
    }
    kept.push(block);
    used += block.length + 1;
  }
  const lines = [`文件：${label}（共 ${result.pageCount} 页）`, ...kept];
  if (truncated.length > 0) {
    lines.push(`（第 ${truncated.join("、")} 页被官方按页截断，文本不完整）`);
  }
  if (dropped.length > 0) {
    lines.push(
      `（预算内放不下的 ${dropped.length} 页已省略：${dropped.join("、")}——官方按整份文件解析，不支持只识别指定页）`,
    );
  }
  return lines.join("\n");
}

/** 官方错误码里 413 是「文件太大」——不可重试，给模型一句能照做的提示 */
function ocrErrorHint(status: number): string {
  if (status === 413) return `文件太大（官方上限 100 MiB）`;
  return retryHint(status);
}

export function createDeepSeekOcrProvider(
  apiKey: string,
  options?: { baseUrl?: string },
): OcrProvider {
  const api = options?.baseUrl ?? DEFAULT_OCR_API;
  return {
    id: "deepseek",
    async ocr(filePath, root) {
      let real: string;
      let bytes: Buffer;
      try {
        real = resolveJailed(root, filePath);
        const stat = statSync(real);
        if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
        if (stat.size > OCR_MAX_BYTES) {
          throw new Error(`文件太大（${stat.size} 字节 > 官方上限 100 MiB）：${filePath}`);
        }
        bytes = readFileSync(real);
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // 官方要求 multipart/form-data：两个必填字段 file 与 purpose，多一个字段就 400
      const form = new FormData();
      form.append("purpose", "text_recognition");
      // Buffer 的底层可能是 SharedArrayBuffer，BlobPart 不收——拷成普通 Uint8Array
      form.append("file", new Blob([Uint8Array.from(bytes)]), basename(real));

      let response: Response;
      try {
        response = await fetch(api, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
        });
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: `network: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const text = await response.text();
      if (!response.ok) {
        const base = redact(text.slice(0, 300), apiKey);
        const hint = ocrErrorHint(response.status);
        return { ok: false, status: response.status, error: hint ? `${base}（${hint}）` : base };
      }

      // 官方：识别期间持续发换行保活 ⇒ 整个响应体是 JSON，前面带换行
      let payload: unknown;
      try {
        payload = JSON.parse(text); // JSON.parse 自带前导空白容忍，不用 trim（变异测试验过）
      } catch {
        return {
          ok: false,
          status: response.status,
          error: `bad json: ${redact(text.slice(0, 200), apiKey)}`,
        };
      }

      // HTTP 200 也可能是错误对象（官方：识别失败/超时返回 error 对象而非结果）
      const errorObj = (payload as { error?: { message?: unknown } }).error;
      if (errorObj) {
        return {
          ok: false,
          status: response.status,
          error: String(errorObj.message ?? "ocr 失败"),
        };
      }

      const rawPages = (payload as { pages?: unknown }).pages;
      if (!Array.isArray(rawPages)) {
        return { ok: false, status: response.status, error: "ocr 响应缺少 pages" };
      }
      const pageCount = Number((payload as { page_count?: unknown }).page_count ?? rawPages.length);
      const pages: OcrPage[] = rawPages.map((item, i) => {
        const page = item as { index?: unknown; text?: unknown; finish_reason?: unknown };
        return {
          index: Number(page.index ?? i),
          text: String(page.text ?? ""),
          finishReason: page.finish_reason === undefined ? undefined : String(page.finish_reason),
        };
      });
      return { ok: true, value: { pageCount, pages } };
    },
  };
}

/** 识别一个本地文件：记忆命中免费（同一份文件不重复计费）→ 配额 → 上传 → 归约 */
export async function runOcr(filePath: string, context: OcrRunContext): Promise<OcrRunResult> {
  const budget = context.textBudgetChars ?? SEARCH_TEXT_BUDGET_CHARS;
  if (filePath.trim() === "") {
    return { ok: false, error: "ocr 动作需要 path" };
  }

  let real: string;
  try {
    real = resolveJailed(context.root, filePath);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const cached = context.memory.lookup(real);
  if (cached !== undefined) {
    return {
      ok: true,
      text: sanitizeText(`（记忆命中，未发请求）\n${cached}`),
      pageCount: 0,
      pages: 0,
      truncated: false,
      cached: true,
    };
  }

  if (!context.quota.tryAcquire()) {
    return { ok: false, error: "DeepSeek 工具配额已用尽（每进程配额，0 = 不限）" };
  }
  const outcome = await context.provider.ocr(real, context.root);
  if (!outcome.ok) {
    context.quota.release(false);
    return { ok: false, error: `ocr 失败（HTTP ${outcome.status}）：${outcome.error}` };
  }
  context.quota.release(outcome.value.pages.length > 0);
  const rendered = renderOcrText(outcome.value, budget, filePath);
  // 空结果不入记忆：官方「200 但没有页」是识别失败的一种形态，不是「这份文件就是空的」。
  // 入记忆的话，同一份文件第二次就命中缓存、永远不再请求官方——一次失败被固化成永久结论。
  if (outcome.value.pages.length > 0) context.memory.storeText(real, rendered);
  return {
    ok: true,
    text: sanitizeText(rendered),
    pageCount: outcome.value.pageCount,
    pages: outcome.value.pages.length,
    truncated: outcome.value.pages.some((p) => p.finishReason === "length"),
    cached: false,
  };
}
