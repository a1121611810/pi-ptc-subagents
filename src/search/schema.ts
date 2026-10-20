/**
 * The schemas the DeepSeek search module's two faces share.
 *
 * One schema, two faces: the pi tool declares it as its `parameters` and its `outputSchema`, and
 * the PTC binding validates a program's arguments against the SAME `parameters` before calling
 * the same implementation. Two schema copies would be two facts, and the second one would drift
 * the first time a parameter was added.
 *
 * These live apart from `contract.ts` (which is the vocabulary) because they are the one place
 * that depends on typebox, and because `runtime/bindings.ts` needs them without wanting the
 * pi-facing parts of the tool.
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

/** A schema that accepts a string or null. */
type Nullable<T extends TSchema> = TUnion<[T, TNull]>;

/**
 * One search result, in DeepSeek's own ten fields.
 *
 * **The three nullable fields are nullable on purpose.** `site_name`, `site_icon` and `date`
 * are `null` when the API has nothing to say — `date` in particular, because a page's
 * publication time is often unknown — and a schema that declared them as plain strings would
 * make the API's own answer fail validation.
 */
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
  url: Type.String({ description: "The page URL — the only source identifier in the payload." }),
  snippet: Type.String({ description: "Short summary (100-200 characters), meant for display." }),
  summary: Type.String({
    description: "Long summary (600-800 characters), meant for a model to read.",
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

/** The payload both faces deliver. */
export type WebDsSearchPageSchema = TObject<{ title: TString; content: TString }>;

export type WebDsSearchPayloadSchema = TObject<{
  operation: TUnion<[TLiteral<"search">, TLiteral<"fetch">]>;
  results: TArray<WebDsSearchResultSchema>;
  page: Nullable<WebDsSearchPageSchema>;
}>;

export const WEB_DS_SEARCH_PAYLOAD_SCHEMA: WebDsSearchPayloadSchema = Type.Object({
  operation: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
  results: Type.Array(WEB_DS_SEARCH_RESULT_SCHEMA),
  page: Type.Union([Type.Object({ title: Type.String(), content: Type.String() }), Type.Null()], {
    description: "The fetched page; null for a search.",
  }),
});

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
  url: TOptional<TString>;
}>;

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
  url: Type.Optional(
    Type.String({
      description:
        "Instead of searching, fetch this one page as Markdown. Up to 8192 characters, http(s), and it must not carry a username or password.",
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
