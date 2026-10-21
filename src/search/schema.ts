/**
 * The schemas the search tool declares.
 *
 * **The search module has ONE face — a model-facing tool inside a dispatched child — so these are
 * its only schemas.** The tool declares its arguments to pi natively (`parameters`), and its
 * result shape natively too (`outputSchema`), which is what lets the child's own model call it
 * and read the answer without a program in between.
 *
 * It lives apart from `contract.ts` (which is the vocabulary) because it is the one place that
 * depends on typebox.
 */
import { Type } from "typebox";
import type {
  TArray,
  TBoolean,
  TLiteral,
  TNull,
  TNumber,
  TObject,
  TOptional,
  TSchema,
  TString,
  TUnion,
} from "typebox";

/**
 * A schema that also accepts `null`.
 *
 * **A local alias because typebox has no `Nullable` type helper.** The runtime value is built with
 * `Type.Union([...Type.Null()])`, and this is its type-level twin — the two must agree, which is
 * why the alias is derived from `TUnion` rather than hand-written as `T | null`.
 */
type Nullable<T extends TSchema> = TUnion<[T, TNull]>;

/**
 * The arguments.
 *
 * **`query` and `url` are alternatives, and the schema says so in prose because JSON Schema
 * cannot express "exactly one of" here.** The two are discriminated at runtime
 * (`toSearchParams` in `search/run.ts`): a call with both, or with neither, is refused with a
 * sentence rather than sent to the API to be rejected there.
 */
export type WebDsSearchParametersSchema = TObject<{
  query: TOptional<TString>;
  count: TOptional<TNumber>;
  ori_question: TOptional<TString>;
  localization: TOptional<TString>;
  need_content: TOptional<TBoolean>;
  open: TOptional<TString>;
  find: TOptional<TObject<{ url: TString; pattern: TString }>>;
}>;

export type WebDsSearchResultSchema = TObject<{
  rerank_score: TNumber;
  title: TString;
  url: TString;
  snippet: TString;
  summary: TString;
  content: TString;
  site_name: Nullable<TString>;
  site_icon: Nullable<TString>;
  date: Nullable<TString>;
  authority: TNumber;
}>;

export const WEB_DS_SEARCH_RESULT_SCHEMA: WebDsSearchResultSchema = Type.Object({
  rerank_score: Type.Number({ description: "Relevance score 0-3; 1.5 or above is a good result." }),
  title: Type.String({ description: "The page title." }),
  url: Type.String({ description: "The page URL — the only source identifier in a result." }),
  snippet: Type.String({
    description:
      "Short, query-related digest (measured 105-414 characters). This is what the overview shows.",
  }),
  summary: Type.String({
    description:
      "DeepSeek's own digest of the whole page. Measured 191-4757 characters, and often a page dump rather than a summary — one `open` away, not in the overview.",
  }),
  content: Type.String({ description: "Page body; empty unless need_content was requested." }),
  site_name: Type.Union([Type.String(), Type.Null()]),
  site_icon: Type.Union([Type.String(), Type.Null()]),
  date: Type.Union([Type.String(), Type.Null()], {
    description: "Publication time, RFC 3339 UTC.",
  }),
  authority: Type.Number({
    description: "Authority tier 0-4 (-1 unknown); 3 or above is highly authoritative.",
  }),
});

export type WebDsSearchPageSchema = TObject<{
  title: TString;
  content: TString;
  source: TOptional<TUnion<[TLiteral<"body">, TLiteral<"summary">]>>;
}>;

/** One place a `find` matched inside a page. */
export type WebDsSearchMatchSchema = TObject<{
  url: TString;
  line: TNumber;
  text: TString;
}>;

export const WEB_DS_SEARCH_MATCH_SCHEMA: WebDsSearchMatchSchema = Type.Object({
  url: Type.String({ description: "The page the match is in." }),
  line: Type.Number({ description: "The 1-based line number inside that page's text." }),
  text: Type.String({ description: "The matching line, as it appears in the page." }),
});

export type WebDsSearchPayloadSchema = TObject<{
  operation: TUnion<[TLiteral<"search">, TLiteral<"fetch">, TLiteral<"find">]>;
  results: TArray<WebDsSearchResultSchema>;
  page: Nullable<WebDsSearchPageSchema>;
  matches: TOptional<TArray<WebDsSearchMatchSchema>>;
  matchTotal: TOptional<TNumber>;
  pattern: TOptional<TString>;
}>;

export const WEB_DS_SEARCH_PAYLOAD_SCHEMA: WebDsSearchPayloadSchema = Type.Object({
  operation: Type.Union([Type.Literal("search"), Type.Literal("fetch"), Type.Literal("find")]),
  results: Type.Array(WEB_DS_SEARCH_RESULT_SCHEMA),
  page: Type.Union(
    [
      Type.Object({
        title: Type.String(),
        content: Type.String(),
        source: Type.Optional(Type.Union([Type.Literal("body"), Type.Literal("summary")])),
      }),
      Type.Null(),
    ],
    { description: "The page; null for a search or a find." },
  ),
  matches: Type.Optional(Type.Array(WEB_DS_SEARCH_MATCH_SCHEMA)),
  matchTotal: Type.Optional(Type.Number()),
  pattern: Type.Optional(Type.String()),
});

export const WEB_DS_SEARCH_PARAMETERS: WebDsSearchParametersSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        'What to search for. 1-128 characters. Supports site:, -site:, "quoted phrases", lang:, after:, before:.',
    }),
  ),
  count: Type.Optional(
    Type.Number({
      description: "How many results to return, 1-50. Defaults to 10. Does not change the price.",
    }),
  ),
  ori_question: Type.Optional(
    Type.String({
      description:
        "The original user question behind this search, 1-128 characters. Helps the engine read the intent.",
    }),
  ),
  localization: Type.Optional(
    Type.String({
      description: "An IP address used to prefer localised results. Empty by default.",
    }),
  ),
  need_content: Type.Optional(
    Type.Boolean({
      description:
        "Whether to include each page's body in `content`. Costs nothing extra, but makes the payload large.",
    }),
  ),
  open: Type.Optional(
    Type.String({
      description:
        "Instead of searching, open one page: you get that page's text. Give a url from a previous search and it costs nothing; give any other url and it is fetched. The url may be up to 8192 characters long — that is the URL's limit, not the page's; it must be http(s) and carry no username or password.",
    }),
  ),
  find: Type.Optional(
    Type.Object({
      url: Type.String({
        description:
          "The page to look inside. A url from a previous search costs nothing; any other url is fetched.",
      }),
      pattern: Type.String({
        description:
          "What to look for. A plain substring, case-insensitive. You get the line numbers where it appears.",
      }),
    }),
  ),
});

/** The TypeScript counterpart of {@link WEB_DS_SEARCH_RESULT_SCHEMA}, for consumers. */
export type WebDsSearchResultSchemaType = {
  rerank_score: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  authority: number;
};
