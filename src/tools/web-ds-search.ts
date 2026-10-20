/**
 * `web_ds_search` — the DeepSeek search module's pi tool (ADR-0047).
 *
 * ## What it is
 *
 * The codemode face of a capability that also appears on the PTC binding face as
 * `tools["web.ds.search"]`. **One implementation, two faces**: both call
 * {@link runWebDsSearch} in `search/run.ts`, which owns the request, the quota accounting, the
 * error text and the payload — so the two faces cannot disagree about any of them.
 *
 * ## Why it is not a model-facing tool
 *
 * `exposure: "codemode"` means pi's codemode scripts may call it while the model is never told
 * about it. That is the shape decision (ADR-0047), and it is load-bearing rather than
 * decorative: this package's thesis is that the model's DIRECT surface stays narrow and the work
 * happens inside a program.
 *
 * **"Not model-facing" is a default, not a guarantee** — and that is measured, not assumed. A
 * live probe found that `tool_search` can find a `codemode`-exposure tool and activate it into
 * the model's declared set (`docs/research/pi-codemode-bridge-live-probe-20261020.md` §7.1-A).
 * There is no pi exposure that is program-reachable but not tool-searchable, so this module
 * cannot prevent it; what it CAN do is say so in the description, which is why the description
 * is not a fixed string but is assembled from the capability's current state.
 *
 * ## Why the result carries `structuredContent`
 *
 * A codemode script receives the tool's `structuredContent` when the tool declares an
 * `outputSchema` and returns one, and receives the text of `content` otherwise. The payload here
 * is structured (ten fields per result), so the tool declares the schema and returns the payload
 * as `structuredContent` — otherwise a script would get one flat string and would have to parse
 * it. `details` carries the same object for the PTC face, which reads it from there.
 *
 * ## Why a failure THROWS
 *
 * **The error is a sentence, and the sentence is the shared constant.** A call that fails throws
 * with the model-facing text, so the two faces reject the same way with the same words. The
 * alternative — returning the error as an ordinary result — was rejected because ADR-0024's
 * binding contract promises that a failing binding call REJECTS, and a program written against
 * that promise would treat a resolved error as data.
 *
 * `AgentToolResult.isError` is deliberately NOT used: the field does not exist on the declared
 * floor (0.86.0's `AgentToolResult` is `content` / `details` / `usage?` / `terminate?`), and a
 * tool that returns it would not typecheck there.
 */
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  SEARCH_UNAVAILABLE_NOTICE,
  WEB_DS_SEARCH_TOOL_NAME,
  type WebDsSearchPayload,
} from "../search/contract.ts";
import { WEB_DS_SEARCH_PARAMETERS, WEB_DS_SEARCH_PAYLOAD_SCHEMA } from "../search/schema.ts";
import {
  describeSearchPayload,
  runWebDsSearch,
  toSearchParams,
  type WebDsSearchDeps,
} from "../search/run.ts";
import { defineCompatTool, type ToolExposure } from "./pi-compat-types.ts";
import { TaskPanelRow } from "./task-panel-render.ts";

/** Mirrors `AnyTool` in `child-report-tool.ts`; written out here rather than imported from there. */
export type AnyTool = ToolDefinition<any, any, any>;

/** The tool's model-facing label. */
export const WEB_DS_SEARCH_LABEL = "Web search (DeepSeek)";

/**
 * The description, assembled from the capability's current state.
 *
 * **It is not a fixed string because the capability has two states the model must be able to
 * tell apart**: available, and registered-but-unusable. A model that can see that search exists
 * but is unavailable can tell the user what is missing; a model that cannot see search at all
 * cannot. The unavailable notice is the same constant the call failure quotes, so the two
 * channels say the same thing.
 */
export function webDsSearchDescription(unavailable: boolean): string {
  const lines = [
    "Search the web through DeepSeek's Search API, or fetch one known page as Markdown.",
    "Pass `query` to search, or `url` to fetch — exactly one of them.",
    "The results come back in `results`, one entry per hit, with DeepSeek's own fields: title, url, snippet, summary, content, authority, rerank_score, date, site_name, site_icon.",
    "`url` is the only source identifier in a result, so build your citations from it yourself.",
    "`summary` is the field written for a model to read; `snippet` is the one written for a UI.",
    "Set `need_content` to include each page's body — it makes the payload large, so ask for it only when you need the text.",
    "A failure comes back as a sentence telling you whether to retry, change the source or recharge — read it and act on it.",
  ];
  if (unavailable) {
    lines.push(SEARCH_UNAVAILABLE_NOTICE);
  }
  return lines.join("\n");
}

/**
 * Build the search tool.
 *
 */
export function createWebDsSearchTool(options: { deps: WebDsSearchDeps }): AnyTool {
  const { deps } = options;
  // ONE source of truth for "registered but unusable": the absence of a client. The description,
  // the contract and the failure a call returns all read it from the same place.
  const unavailable = deps.client === undefined;
  return defineCompatTool({
    name: WEB_DS_SEARCH_TOOL_NAME,
    label: WEB_DS_SEARCH_LABEL,
    description: webDsSearchDescription(unavailable),
    promptSnippet: "Search the web, or fetch a page, through DeepSeek's Search API",
    promptGuidelines: [
      "Prefer `summary` over `content` when you only need to judge a result — `content` is the whole page and it makes the payload large.",
      "A search that matched nothing is not an error: it comes back with an empty `results` and a sentence saying so.",
    ],
    parameters: WEB_DS_SEARCH_PARAMETERS,
    outputSchema: WEB_DS_SEARCH_PAYLOAD_SCHEMA,
    // The codemode face (ADR-0047). Never `direct`: this package's narrowing mode is the reason
    // the model reaches the bound tools from inside a program, and a network-egress tool is the
    // last thing that should be one call away from the model's direct list.
    exposure: "codemode" as ToolExposure,
    renderCall(args: unknown, theme: Theme): TaskPanelRow {
      const params = args as { query?: unknown; url?: unknown } | undefined;
      const label = theme.fg("toolTitle", theme.bold(WEB_DS_SEARCH_LABEL));
      const target =
        typeof params?.query === "string"
          ? params.query
          : typeof params?.url === "string"
            ? params.url
            : "";
      return new TaskPanelRow([
        { left: target === "" ? label : label + " " + theme.fg("dim", target) },
      ]);
    },
    renderResult(
      result: { content?: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
      _options: unknown,
      theme: Theme,
    ): TaskPanelRow {
      const text = (result.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("\n");
      const label = theme.fg("toolTitle", theme.bold(WEB_DS_SEARCH_LABEL));
      return new TaskPanelRow([
        { left: text === "" ? label : label + " " + theme.fg("dim", text) },
      ]);
    },
    async execute(_toolCallId, params) {
      const searchParams = toSearchParams(params);
      const outcome = await runWebDsSearch(deps, searchParams);
      if (!outcome.ok) {
        // The shared sentence, thrown rather than returned: see the module comment.
        throw new Error(outcome.text);
      }
      const payload: WebDsSearchPayload = outcome.payload;
      return {
        content: [{ type: "text" as const, text: describeSearchPayload(payload) }],
        details: payload,
        structuredContent: payload,
      };
    },
  }) as unknown as AnyTool;
}
