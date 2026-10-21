/**
 * `web_ds_search` — the DeepSeek search tool, and it exists **only inside a dispatched child**.
 *
 * ## Why it is a child's tool and not the parent's
 *
 * **The parent is not the one that knows how to search.** It knows how to break a task down and
 * how to judge an answer; the searching is the part that needs judgement about sources, recency
 * and relevance — and that judgement belongs in the child that does the work and reports back.
 * So the capability is *handed to the sub-agent*, exactly the way `ptc_child_report` is handed to
 * the child that owes a report:
 *
 * - `dispatch()` stamps `PI_PTC_DEPTH` on the child process
 *   (`runtime/dispatch.ts`), so a process knows whether it was dispatched;
 * - this tool is registered **only when `ptcDepth > 0`**, which is why a parent session does not
 *   even have it in its registry — not "registered but hidden", **absent**.
 *
 * The consequence worth stating plainly: **a parent session cannot search.** Its only route to
 * the web is to dispatch a child that can. That is the cost (a small question becomes a
 * dispatch round trip), and it is also the point: the parent's context stays clean, and the
 * coupling does not grow, because the parent never depends on this tool's shape — it depends on
 * the dispatch-and-report contract it already has.
 *
 * ## What it is NOT
 *
 * **Not a PTC binding.** A binding would be reachable from any program's binding table, which
 * would put the capability back in the parent's hands. This is a model-facing tool in the child:
 * the child's own model calls it, one call, no program.
 *
 * ## The gate
 *
 * Two conditions, both required: the **switch** (`webDsSearch.enabled` in
 * `~/.pi/agent/ptc.json`, off by default) and **being a dispatched child**. The switch is read
 * once, at extension load, like every other key in that file.
 *
 * A missing DeepSeek credential does NOT remove the tool: the tool stays, says so in its
 * description, and a call fails with a sentence that names what is missing. A model that can see
 * that search exists but is unavailable can tell the user what to fix; a model that cannot see
 * search at all cannot.
 */
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  SEARCH_UNAVAILABLE_NOTICE,
  WEB_DS_SEARCH_TOOL_NAME,
  type WebDsSearchPayload,
} from "../search/contract.ts";
import { WEB_DS_SEARCH_PARAMETERS, WEB_DS_SEARCH_PAYLOAD_SCHEMA } from "../search/schema.ts";
import {
  describePayloadCompactly,
  describeSearchPayload,
  runWebDsSearch,
  toSearchParams,
  type WebDsSearchDeps,
} from "../search/run.ts";
import { defineCompatTool, type ToolExposure } from "./pi-compat-types.ts";
import { TaskPanelRow } from "./task-panel-render.ts";
import { sanitizeText } from "./text.ts";

/** Mirrors `AnyTool` in `child-report-tool.ts`; written out here rather than imported from there. */
export type AnyTool = ToolDefinition<any, any, any>;

/** The tool's model-facing label. */
export const WEB_DS_SEARCH_LABEL = "Web search (DeepSeek)";

/**
 * The description, assembled from the capability's current state.
 *
 * **The unavailable notice is a per-session truth, so the description is built per session.**
 * A model that can see that search exists but is unusable can tell the user what is missing; a
 * model that cannot see search at all cannot.
 */
export function webDsSearchDescription(unavailable: boolean): string {
  const lines = [
    "Search the web through DeepSeek's Search API, or open one page.",
    "**Three actions, one at a time.** `query` searches, `open` opens one page, `find` looks for a string inside one page. Give exactly one of them.",
    "**Call it directly, the way you call any other tool.** It is not a PTC binding, so a program you write cannot call it: `tools.web_ds_search` is not a function.",
    "A search returns an OVERVIEW — one entry per result: title, url, authority, rerank_score, date, and DeepSeek's own short snippet. It does NOT return each page's full text.",
    "**Want a page's substance? Call `open` with that result's url.** It costs nothing when the page came from a search you just did, and one request otherwise.",
    "**Want one passage out of a long page? Call `find` with the url and the string you are looking for** — you get the line numbers where it appears, not the whole page.",
    "`url` is the only source identifier in a result, so build citations from it.",
    "Set `need_content` only when you want each result's whole body — it makes the search's payload much larger.",
    "A fetched page's body may carry backslash escapes before punctuation (`\\|`, `\\-`, `\\.`): that is the API's own formatting, not corruption, and the text is still readable.",
    "A failure comes back as a sentence saying whether to retry, change the source or recharge; read it and act on it.",
  ];
  if (unavailable) {
    lines.push(SEARCH_UNAVAILABLE_NOTICE);
  }
  return lines.join("\n");
}

/**
 * Build the search tool.
 *
 * `unavailable` is the caller's read of "the switch is on but no credential resolved". It is a
 * parameter rather than something read here so the decision stays with the entrypoint, which is
 * where the credential verdict is made.
 */
export function createWebDsSearchTool(options: {
  deps: WebDsSearchDeps;
  unavailable: boolean;
}): AnyTool {
  const { deps, unavailable } = options;
  return defineCompatTool({
    name: WEB_DS_SEARCH_TOOL_NAME,
    label: WEB_DS_SEARCH_LABEL,
    description: webDsSearchDescription(unavailable),
    promptSnippet: "Search the web, or fetch a page, through DeepSeek's Search API",
    promptGuidelines: [
      "Prefer `summary` over `content` when you only need to judge a result — `content` is the whole page and it makes the result large.",
      "A search that matched nothing is not an error: it comes back with an empty `results` and a sentence saying so.",
    ],
    parameters: WEB_DS_SEARCH_PARAMETERS,
    outputSchema: WEB_DS_SEARCH_PAYLOAD_SCHEMA,
    // `direct` on every surface: this tool is SUPPOSED to be model-facing — in the child. The
    // thing that keeps it out of a parent's hands is that the parent never registers it.
    exposure: "direct" as ToolExposure,
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
        { left: target === "" ? label : label + " " + theme.fg("dim", sanitizeText(target)) },
      ]);
    },
    renderResult(
      result: { content?: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
      _options: unknown,
      theme: Theme,
    ): TaskPanelRow {
      // **The row is a count, not the model's text.** The tool's `content` carries the whole
      // result (that is what the model reads), so rendering it here would put ten summaries into
      // one line of a terminal. The row is built from the payload instead.
      const payload = result.details as WebDsSearchPayload | undefined;
      const text =
        payload === undefined || payload === null ? "" : describePayloadCompactly(payload);
      const label = theme.fg("toolTitle", theme.bold(WEB_DS_SEARCH_LABEL));
      return new TaskPanelRow([
        { left: text === "" ? label : label + " " + theme.fg("dim", sanitizeText(text)) },
      ]);
    },
    async execute(_toolCallId, params) {
      const outcome = await runWebDsSearch(deps, toSearchParams(params));
      if (!outcome.ok) {
        // The shared sentence, thrown rather than returned: pi turns a thrown tool error into
        // an error the model reads, and the wording is the same one the binding used to quote.
        throw new Error(outcome.text);
      }
      const payload: WebDsSearchPayload = outcome.payload;
      return {
        content: [{ type: "text" as const, text: describeSearchPayload(payload) }],
        details: payload,
        structuredContent: payload,
      };
    },
  });
}
