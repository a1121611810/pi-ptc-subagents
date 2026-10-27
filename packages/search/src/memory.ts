import type { SearchMatch } from "./provider.ts";
import { SEARCH_MEMORY_MAX_CHARS, SEARCH_MEMORY_MAX_ENTRIES } from "./provider.ts";

// 结果记忆：最近 5 次搜索；open/find 命中记忆则免费 serve（不白烧一次请求）
export interface SearchMemory {
  remember(query: string, matches: SearchMatch[]): void;
  /** open 成功后存正文；后续 find/open 命中记忆免费 serve */
  storeText(url: string, text: string): void;
  lookup(url: string): string | undefined;
}

// url 宽松匹配：scheme+host 同、path 去尾斜杠、不计 fragment、query 同或一方为空
export function urlsLooselyEqual(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.host !== ub.host || ua.protocol !== ub.protocol) return false;
    if (ua.pathname.replace(/\/$/, "") !== ub.pathname.replace(/\/$/, "")) return false;
    return ua.search === ub.search || ua.search === "" || ub.search === "";
  } catch {
    return a === b;
  }
}

interface MemoryEntry {
  query: string;
  matches: SearchMatch[];
  textByUrl: Map<string, string>;
  chars: number;
}

export function createSearchMemory(): SearchMemory {
  const entries: MemoryEntry[] = [];
  // 审计 F5：非搜索结果 URL 的兜底桶——直接 open 的页没有搜索条目可挂，正文存这里（lookup 两桶都查）
  const looseTexts = new Map<string, string>();
  let looseChars = 0;
  let totalChars = 0;

  const trim = () => {
    while (totalChars > SEARCH_MEMORY_MAX_CHARS) {
      // 超字符预算先淘汰兜底桶最老的（直接 open 的正文是大头；桶空才动搜索条目）
      const oldest = looseTexts.keys().next();
      if (!oldest.done) {
        const len = looseTexts.get(oldest.value)?.length ?? 0;
        looseChars -= len;
        totalChars -= len;
        looseTexts.delete(oldest.value);
        continue;
      }
      const evicted = entries.shift();
      if (!evicted) break;
      totalChars -= evicted.chars;
    }
    while (entries.length > SEARCH_MEMORY_MAX_ENTRIES) {
      const evicted = entries.shift();
      if (!evicted) break;
      totalChars -= evicted.chars;
    }
  };

  return {
    remember(query, matches) {
      entries.push({ query, matches, textByUrl: new Map(), chars: query.length });
      trim();
    },
    storeText(url, text) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        const match = entry.matches.find((m) => urlsLooselyEqual(m.url, url));
        if (!match) continue;
        entry.textByUrl.set(match.url, text);
        entry.chars += text.length;
        totalChars += text.length;
        trim();
        return;
      }
      // F5：搜索结果里没这个 URL——进兜底桶（覆盖同 key 先回吐旧账）
      looseChars -= looseTexts.get(url)?.length ?? 0;
      looseTexts.set(url, text);
      looseChars += text.length;
      totalChars += text.length;
      trim();
    },
    lookup(url) {
      for (let i = entries.length - 1; i >= 0; i--) {
        for (const [stored, text] of entries[i]!.textByUrl) {
          if (urlsLooselyEqual(stored, url)) return text;
        }
      }
      for (const [stored, text] of [...looseTexts].reverse()) {
        if (urlsLooselyEqual(stored, url)) return text;
      }
      return undefined;
    },
  };
}
