/**
 * The one implementation both faces call.
 *
 * The DeepSeek search module appears on two program faces (ADR-0047): the **codemode** face
 * (a pi tool with `exposure: "codemode"`) and the **PTC binding** face (`tools["web.ds.search"]`).
 * Two faces means two places where a bug could be fixed in one and not the other, so the
 * request, the quota accounting, the error text and the payload rendering all live HERE, and
 * both faces are thin wrappers that call this and hand its result over in their own envelope.
 *
 * **What each face ends up holding** is the same payload in two wrappers:
 *
 * | face      | the payload arrives as                                     |
 * | --------- | ---------------------------------------------------------- |
 * | codemode  | `structuredContent` — the object itself (pi swaps the text out) |
 * | binding   | `details` — the object, next to a readable index in `content[0].text` |
 *
 * The codemode script therefore reads `results.length === 0` rather than a sentence, and the
 * binding program reads `result.details.results`. Neither is told about the other: the two
 * faces are separate surfaces, and the one place they agree is this module.
 *
 * ## The quota is reserved, not counted
 *
 * A call that FAILS must not consume the quota — DeepSeek does not bill a failed request, and
 * charging a program for a timeout it could not avoid would make the cap a tax on bad luck.
 * But a call that is still in flight must hold a slot, or ten concurrent calls would all pass
 * the limit check before any of them had counted. So a call **reserves** a slot before it
 * starts and either commits it (success) or releases it (failure), and the limit is therefore
 * a hard ceiling on concurrent usage while the counter only ever grows on success.
 */
import type { DeepSeekClient } from "./client.ts";
import type { SearchQuota } from "./quota.ts";
import {
  SEARCH_NO_RESULTS_TEXT,
  SEARCH_QUOTA_EXHAUSTED_TEXT,
  SEARCH_UNAVAILABLE_NOTICE,
  type WebDsSearchPayload,
} from "./contract.ts";

/** What the module accepts: a search, or a fetch of one known URL. */
export type WebDsSearchParams =
  | {
      query: string;
      count?: number;
      ori_question?: string;
      localization?: string;
      need_content?: boolean;
    }
  | { url: string };

/** The result of one call: the payload, or the model-facing sentence that says why there is none. */
export type WebDsSearchOutcome =
  | { ok: true; payload: WebDsSearchPayload }
  | { ok: false; text: string };

/** Everything a call needs that is not the request itself. */
export interface WebDsSearchDeps {
  /**
   * The HTTP client — **absent when no credential resolved.**
   *
   * That absence is the ONE source of truth for "the capability is registered but unusable":
   * the tool's description, the binding contract and the failure a call returns all read it
   * from here, so they cannot disagree about whether search is available. A call made without
   * a client is refused with the unavailable notice and **consumes no quota** — no request
   * left the machine, so there is nothing to charge for.
   */
  client?: DeepSeekClient;
  /** The session's quota. Shared by both faces, because the quota is per SESSION. */
  quota: SearchQuota;
  /**
   * The quota's ceiling, quoted in the exhausted message so the model can say how many it had.
   * `0` means unlimited, and the message is not used in that case.
   */
  maxCallsPerSession: number;
}

/**
 * Run one search-module call: reserve a quota slot, hit the API, and settle the slot honestly.
 *
 * The failure channel carries a SENTENCE, never a status code: the program that reads it has to
 * decide between retrying, changing the source, recharging and giving up, and only a sentence
 * says which. The sentences are the shared constants in `contract.ts`, so the same status code
 * cannot mean one thing on the codemode face and another on the binding face.
 */
export async function runWebDsSearch(
  deps: WebDsSearchDeps,
  params: WebDsSearchParams,
): Promise<WebDsSearchOutcome> {
  if (deps.client === undefined) {
    // No credential: the call never leaves the machine, so it takes no quota slot either.
    return { ok: false, text: SEARCH_UNAVAILABLE_NOTICE };
  }
  const client = deps.client;
  const reservation = deps.quota.reserve();
  if (reservation === undefined) {
    return {
      ok: false,
      text: SEARCH_QUOTA_EXHAUSTED_TEXT.replace("{limit}", String(deps.maxCallsPerSession)),
    };
  }

  let result: Awaited<ReturnType<DeepSeekClient["search"]>>;
  try {
    result =
      "url" in params
        ? await client.fetchPage({ url: params.url })
        : await client.search({
            query: params.query,
            ...(params.count === undefined ? {} : { count: params.count }),
            ...(params.ori_question === undefined ? {} : { ori_question: params.ori_question }),
            ...(params.localization === undefined ? {} : { localization: params.localization }),
            ...(params.need_content === undefined ? {} : { need_content: params.need_content }),
          });
  } catch (error) {
    // A client that REJECTS is not the production client (it never throws), but the deps
    // interface is public and a caller may supply one that does. The reserved slot goes back
    // here — without it a single throw would silently eat the session's quota for good.
    reservation.release();
    throw error;
  }

  if (!result.ok) {
    // A failed call is not a used call: the slot goes back, so a transient 429 does not eat the
    // program's budget.
    reservation.release();
    return { ok: false, text: result.text };
  }

  reservation.commit();
  return { ok: true, payload: result.payload };
}

/**
 * The model-facing line for a call that SUCCEEDED.
 *
 * **An index, not the data.** The data is in the payload (and, on the binding face, in
 * `details`); this line is what a reader of the transcript sees. It is short on purpose —
 * a search that returned ten pages must not put ten pages of body text into the model's face
 * when the program was going to pick three of them.
 *
 * **The empty case is the interesting one.** A search that matched nothing is HTTP 200 with an
 * empty `results` array — a SUCCESS, not an error — but a program that receives an empty array
 * has to decide whether to rephrase, drop a filter, or give up, and "empty array" does not say
 * which. So the empty case gets its own sentence, quoted from the shared constant so the two
 * faces say it the same way.
 */
export function describeSearchPayload(payload: WebDsSearchPayload): string {
  if (payload.operation === "fetch") {
    const title = payload.page?.title ?? "";
    const length = payload.page?.content?.length ?? 0;
    return title === ""
      ? `fetched ${length} characters`
      : `fetched "${title}" (${length} characters)`;
  }
  if (payload.results.length === 0) {
    return SEARCH_NO_RESULTS_TEXT;
  }
  return payload.results
    .map((result, index) => `${index + 1}. ${result.title} | ${result.url}`)
    .join("\n");
}

/**
 * The arguments, discriminated.
 *
 * **The schema cannot say "exactly one of", so the check is here** — and here rather than in
 * either face, because a call with both `query` and `url` (or with neither) is the same mistake
 * whichever face the program reached it through, and the refusal should read the same either way.
 *
 * The refusals are SENTENCES, not schema errors: they name the two alternatives and say which
 * one was given.
 */
export function toSearchParams(params: unknown): WebDsSearchParams {
  const record = (params ?? {}) as {
    query?: unknown;
    count?: unknown;
    ori_question?: unknown;
    localization?: unknown;
    need_content?: unknown;
    url?: unknown;
  };
  const hasQuery = typeof record.query === "string" && record.query.length > 0;
  const hasUrl = typeof record.url === "string" && record.url.length > 0;
  if (hasQuery && hasUrl) {
    throw new Error(
      "搜索只能给 `query` 或 `url` 其中一个：给了 `query` 就是搜索，给了 `url` 就是抓取那个页面。",
    );
  }
  if (!hasQuery && !hasUrl) {
    throw new Error("搜索需要 `query`（搜）或 `url`（抓取那个页面），至少给一个。");
  }
  if (hasUrl) {
    return { url: record.url as string };
  }
  return {
    query: record.query as string,
    ...(typeof record.count === "number" ? { count: record.count } : {}),
    ...(typeof record.ori_question === "string" ? { ori_question: record.ori_question } : {}),
    ...(typeof record.localization === "string" ? { localization: record.localization } : {}),
    ...(typeof record.need_content === "boolean" ? { need_content: record.need_content } : {}),
  };
}

/**
 * What the PTC tool factories need in order to put the search binding in the table.
 *
 * **Absent means the capability is switched off**, and absent is the default: the switch lives
 * in `ptc.json` and defaults to off (ADR-0048), so a caller that says nothing about search
 * gets no search binding.
 */
export interface WebDsSearchBindingOptions {
  /** The client (absent when no credential resolved), the session's quota, and the ceiling. */
  searchDeps: WebDsSearchDeps;
}
