/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Search engines are pluggable behind ONE seam: the settings record names a
 * preferred engine (agent.search.engine — optional), keys live in the auth
 * store (the curated key catalog), and the server composes the live adapter.
 * Fork addition (2026-11-03): SearXNG, a self-hosted keyless engine —
 * configured by its instance URL (SEARXNG_URL) instead of an API key.
 *
 * Owner decisions baked here:
 *  - NO default engine in the factory record: an engine is live iff its
 *    key is present. With a key, the engine auto-activates (the user never
 *    chooses an engine to make search work — setting the key is enough);
 *    agent.search.engine is only an explicit preference.
 *  - Nothing silently falls back: no engine live = search is honestly
 *    unavailable (the tool says so). Research remains available keylessly
 *    through web_fetch for known URLs.
 *
 * Pure types, the engine table + protocol docs only (browser-safe, no node
 * imports): the adapters are server-side (src/server/search.ts) and arrive
 * as injected dependencies — the agent-layer tool depends on THIS port only.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** Search engines in automatic preference order. Keep existing preferences
 * stable when adding an engine: an explicit pin always wins. `credential`
 * is what the engine's auth-store/env var holds — an API key, or (SearXNG,
 * fork addition 2026-11-03) a self-hosted instance's base URL. SearXNG is
 * last: a paid key, when present, still wins. */
export const SEARCH_ENGINES = [
	{ id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY", credential: "API key" },
	{ id: "brave", label: "Brave", envVar: "BRAVE_API_KEY", credential: "API key" },
	{ id: "exa", label: "Exa", envVar: "EXA_API_KEY", credential: "API key" },
	{ id: "firecrawl", label: "Firecrawl", envVar: "FIRECRAWL_API_KEY", credential: "API key" },
	{ id: "ollama", label: "Ollama", envVar: "OLLAMA_API_KEY", credential: "API key" },
	{ id: "searxng", label: "SearXNG", envVar: "SEARXNG_URL", credential: "URL" },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** One engine's catalog row (label, env var, credential kind). */
export type SearchEngineInfo = (typeof SEARCH_ENGINES)[number];

/** The read/write guards' membership check (settings record + PUT body). */
export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return SEARCH_ENGINES.some((engine) => engine.id === value);
}

/** The catalog row for a known engine id. */
export function searchEngineInfo(id: SearchEngineId): SearchEngineInfo {
	return SEARCH_ENGINES.find((engine) => engine.id === id)!;
}

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}
