/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Search engines are pluggable behind ONE seam: the settings record names a
 * preferred engine (agent.search.engine — optional), keys live in the auth
 * store (TAVILY_API_KEY / BRAVE_API_KEY — curated catalog), and the server
 * composes the live adapter. The Google CSE engine retired with this wave
 * (closed to new customers; dies Jan 2027) — replaced by Tavily + Brave.
 * Fork addition (2026-11-03): SearXNG, a self-hosted keyless engine —
 * configured by its instance URL (SEARXNG_URL) instead of an API key.
 *
 * Owner decisions baked here:
 *  - NO default engine in the factory record: an engine is live iff its
 *    key is present. With a key, the engine auto-activates (the user never
 *    chooses an engine to make search work — setting the key is enough);
 *    agent.search.engine is only an explicit preference.
 *  - Nothing silently falls back: no engine live = search is honestly
 *    unavailable (the tool says so; the researcher sub-agent is disabled
 *    by the agent layer on the same signal — that rewiring is the Teacher
 *    stream's, on this port).
 *
 * Pure types, the engine table + protocol docs only (browser-safe, no node imports): the
 * adapters are server-side (src/server/search.ts) and arrive as injected
 * dependencies — the agent-layer tool depends on THIS port only.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** The engine ids, in AUTO-DETECT PREFERENCE order (no pin + several
 *  engines configured → the first configured one wins). SearXNG is last:
 *  a paid key, when present, still wins (fork decision, 2026-11-03). */
export const SEARCH_ENGINE_IDS = ["tavily", "brave", "searxng"] as const;

/** The engine ids this fork ships (the catalog: curated keys + adapters). */
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return (SEARCH_ENGINE_IDS as readonly unknown[]).includes(value);
}

/** Per-engine metadata the server, the settings parsers and the UI share:
 *  the display label, the auth-store/env var that configures the engine,
 *  and what that var holds (an API key, or SearXNG's instance base URL). */
export const SEARCH_ENGINE_INFO: Readonly<
	Record<SearchEngineId, { label: string; envVar: string; credential: "API key" | "URL" }>
> = {
	tavily: { label: "Tavily", envVar: "TAVILY_API_KEY", credential: "API key" },
	brave: { label: "Brave", envVar: "BRAVE_API_KEY", credential: "API key" },
	searxng: { label: "SearXNG", envVar: "SEARXNG_URL", credential: "URL" },
};

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
