import type { SearchMatch } from "./provider.ts";
import { SEARCH_MEMORY_MAX_CHARS, SEARCH_MEMORY_MAX_ENTRIES } from "./provider.ts";

// 结果记忆：最近 5 次搜索；open/find 命中记忆则免费 serve（不白烧一次请求）
export interface SearchMemory {
  remember(query: string, matches: SearchMatch[]): void;
  /** open 成功后存正文；后续 find/open 命中记忆免费 serve */
  storeText(url: string, text: string): void;
  lookup(url: string): string | undefined;
  findInText(url: string, pattern: string): string[] | undefined;
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
  let totalChars = 0;

  const trim = () => {
    while (entries.length > SEARCH_MEMORY_MAX_ENTRIES || totalChars > SEARCH_MEMORY_MAX_CHARS) {
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
    },
    lookup(url) {
      for (let i = entries.length - 1; i >= 0; i--) {
        for (const [stored, text] of entries[i]!.textByUrl) {
          if (urlsLooselyEqual(stored, url)) return text;
        }
      }
      return undefined;
    },
    findInText(url, pattern) {
      const text = this.lookup(url);
      if (text === undefined) return undefined;
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "i");
      } catch {
        return [];
      }
      return text.split("\n").filter((line) => regex.test(line));
    },
  };
}
