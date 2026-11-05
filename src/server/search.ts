/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): search adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when several keys are
 *    present the order is Tavily → Brave → Exa → Firecrawl → Ollama →
 *    SearXNG);
 *    without a pin, the first keyed engine wins.
 *  - An explicit choice does NOT silently fall back to another engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * Fork addition (2026-11-03): a sixth, KEYLESS engine — a self-hosted
 * SearXNG instance, configured by its base URL (SEARXNG_URL) and last in
 * the auto-detect order. Its requests pass through a process-wide gate
 * (serialized, spaced, briefly cached) to keep upstream scraping polite.
 * The keyed engines get the same 30-minute in-memory result cache (no
 * spacing), so a repeated query doesn't spend the paid allowance.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import {
	SEARCH_ENGINES,
	searchEngineInfo,
	type SearchEngineId,
	type SearchHit,
	type SearchProvider,
	type SearchStatus,
} from "../core/search.ts";
import { normalizeBaseUrl } from "../core/settings.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Invalid JSON must not echo provider response bodies into tool results. */
async function searchJson(response: Response, label: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${label} search API returned an invalid response`);
	}
}

/** Exa's Search API returns highlights when requested. Its result snippets
 * are normalized to the same bounded, provider-neutral shape as the other
 * adapters. Do not expose error bodies, which may contain credentials. */
export function exaProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "exa",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.exa.ai/search", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				body: JSON.stringify({ query, type: "auto", numResults: Math.min(100, Math.max(1, Math.floor(count))), contents: { highlights: true } }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Exa search API ${resp.status}`);
			const data = await searchJson(resp, "Exa");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Exa search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; highlights?: unknown; text?: unknown };
				if (typeof row.url !== "string" || !row.url.trim()) return [];
				try {
					const protocol = new URL(row.url).protocol;
					if (protocol !== "http:" && protocol !== "https:") return [];
				} catch { return []; }
				const highlights = Array.isArray(row.highlights) ? row.highlights.filter((v): v is string => typeof v === "string").join(" ") : "";
				const snippet = highlights || (typeof row.text === "string" ? row.text : "");
				return [{ title: typeof row.title === "string" && row.title ? row.title : row.url, url: row.url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 500) }];
			});
		},
	};
}

/** Firecrawl's v2 search API: no scrapeOptions, so web_fetch still owns
 *  page bodies. Wire shape checked against the official 2026-11-03 snapshot;
 *  live account access and pricing are not inferred from configuration. */
export function firecrawlProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "firecrawl",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.firecrawl.dev/v2/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, limit: Math.min(100, Math.max(1, Math.floor(count))) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Firecrawl search API ${resp.status}`);
			const data = await searchJson(resp, "Firecrawl");
			if (!data || typeof data !== "object" || (data as { success?: unknown }).success !== true) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			const payload = (data as { data?: unknown }).data;
			if (!payload || typeof payload !== "object" || !Array.isArray((payload as { web?: unknown }).web)) {
				throw new Error("Firecrawl search API returned an invalid response");
			}
			return (payload as { web: unknown[] }).web.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; description?: unknown };
				return searchHit(row.title, row.url, row.description);
			});
		},
	};
}

/** Hosted search only, adapted from chiranjivsethi's PR #81 (a216fa8).
 *  No local model URL, model registration, or provider-backed page fetch. */
export function ollamaProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "ollama",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://ollama.com/api/web_search", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ query, max_results: Math.min(10, Math.max(1, Math.floor(count))) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`Ollama search API ${resp.status}`);
			const data = await searchJson(resp, "Ollama");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("Ollama search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; content?: unknown };
				return searchHit(row.title, row.url, row.content);
			});
		},
	};
}

/** Match Exa's bounded result contract for the other new adapters. */
function searchHit(title: unknown, url: unknown, snippet: unknown): SearchHit[] {
	if (typeof url !== "string" || !url.trim()) return [];
	try {
		const protocol = new URL(url).protocol;
		if (protocol !== "http:" && protocol !== "https:") return [];
	} catch { return []; }
	return [{
		title: typeof title === "string" && title ? title : url,
		url,
		snippet: typeof snippet === "string" ? snippet.replace(/\s+/g, " ").trim().slice(0, 500) : "",
	}];
}

// ── result cache (every engine) ─────────────────────────────────────────────

/** A small in-memory result cache — RAM only, never disk; cleared on
 *  restart. Researchers repeat queries across angles and jobs; each repeat
 *  served from here is one search that never reaches the engine (a paid
 *  allowance for the keyed engines, upstream scraping for SearXNG). */
export interface SearchCache {
	/** Fresh cached hits for this key (refreshes its recency), else undefined. */
	cached(key: string): SearchHit[] | undefined;
	remember(key: string, hits: SearchHit[]): void;
	/** Share one in-flight run per key: a caller asking for a key already
	 *  being fetched gets that same promise instead of a second request. */
	once(key: string, fn: () => Promise<SearchHit[]>): Promise<SearchHit[]>;
}

export interface SearchCacheOptions {
	/** How long a cached result stays fresh (default 30 min). */
	ttlMs?: number;
	/** Capacity in queries; least recently used evicted first (default 200 ≈ 2 MB). */
	maxEntries?: number;
	now?: () => number;
}

export function createSearchCache(opts: SearchCacheOptions = {}): SearchCache {
	const ttlMs = opts.ttlMs ?? 30 * 60_000;
	const maxEntries = opts.maxEntries ?? 200;
	const now = opts.now ?? Date.now;
	// Map iteration order = insertion order: re-inserting on use makes the
	// first key the least recently used one.
	const cache = new Map<string, { at: number; hits: SearchHit[] }>();
	const inflight = new Map<string, Promise<SearchHit[]>>();
	return {
		cached(key) {
			const entry = cache.get(key);
			if (!entry) return undefined;
			cache.delete(key);
			if (now() - entry.at > ttlMs) return undefined;
			cache.set(key, entry);
			return entry.hits;
		},
		remember(key, hits) {
			cache.delete(key);
			cache.set(key, { at: now(), hits });
			while (cache.size > maxEntries) {
				const oldest = cache.keys().next().value;
				if (oldest === undefined) break;
				cache.delete(oldest);
			}
		},
		once(key, fn) {
			const running = inflight.get(key);
			if (running) return running;
			const run = fn().finally(() => inflight.delete(key));
			inflight.set(key, run);
			return run;
		},
	};
}

/** How many hits a cached keyed-engine request asks for: the web_search
 *  tool's maximum, so ONE paid request can answer any later count for the
 *  same query. Brave bills per request and Tavily's basic search costs one
 *  credit whatever max_results is, so asking for 10 costs the same as 5.
 *  Exa, Firecrawl and hosted Ollama are filled the same way (10 is also
 *  Ollama's own ceiling). */
const CACHE_FILL_COUNT = 10;

/** Wrap a keyed engine (Tavily/Brave/Exa/Firecrawl/Ollama) with the result cache: a repeated
 *  query within the TTL is answered locally and never spends the engine's
 *  allowance. Keyed by engine + query, so switching engines never serves
 *  another engine's results. Failures are never cached. No request spacing
 *  here — that is SearXNG's (scraping) concern, not a paid API's. */
export function withSearchCache(provider: SearchProvider, cache: SearchCache = sharedSearchCache()): SearchProvider {
	return {
		id: provider.id,
		async search(query: string, count: number): Promise<SearchHit[]> {
			const key = `${provider.id}\n${query}`;
			const fresh = cache.cached(key);
			if (fresh) return fresh.slice(0, count);
			const hits = await cache.once(key, async () => {
				const result = await provider.search(query, Math.max(count, CACHE_FILL_COUNT));
				cache.remember(key, result);
				return result;
			});
			return hits.slice(0, count);
		},
	};
}

/** ONE keyed-engine cache per process — anchored on globalThis so a dev-mode
 *  module reload doesn't empty it (searchProvider() composes fresh adapters
 *  per call). */
const SEARCH_CACHE = Symbol.for("learnharness.search-cache");
function sharedSearchCache(): SearchCache {
	const g = globalThis as { [SEARCH_CACHE]?: SearchCache };
	return (g[SEARCH_CACHE] ??= createSearchCache());
}

// ── SearXNG (fork addition, 2026-11-03) ─────────────────────────────────────

/** Spacing + caching in front of a SearXNG instance. SearXNG scrapes its
 *  upstream engines (Google, Bing, DuckDuckGo, …), which CAPTCHA/rate-limit
 *  bursts — a researcher job fires several searches back to back, and
 *  several jobs can run at once. So: requests go out ONE AT A TIME, at
 *  least `minIntervalMs` apart across every caller (D8), and recent results
 *  are reused from the result cache (D7). */
export interface SearxngGate extends SearchCache {
	/** Run `fn` after every earlier scheduled call has settled and the
	 *  minimum interval since the previous start has passed. */
	schedule<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SearxngGateOptions extends SearchCacheOptions {
	/** Minimum gap between request starts (default 1500 ms). */
	minIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export function createSearxngGate(opts: SearxngGateOptions = {}): SearxngGate {
	const minIntervalMs = opts.minIntervalMs ?? 1_500;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let tail: Promise<unknown> = Promise.resolve();
	let lastStart: number | null = null;
	return {
		...createSearchCache(opts),
		schedule(fn) {
			const run = tail.then(async () => {
				if (lastStart !== null) {
					const wait = lastStart + minIntervalMs - now();
					if (wait > 0) await sleep(wait);
				}
				lastStart = now();
				return fn();
			});
			// The queue survives failures: the next caller waits on settlement only.
			tail = run.catch(() => undefined);
			return run;
		},
	};
}

/** ONE gate per process, shared by every provider instance (searchProvider()
 *  composes a fresh adapter per call) — anchored on globalThis so a dev-mode
 *  module reload doesn't reset the spacing or the cache. */
const SEARXNG_GATE = Symbol.for("learnharness.searxng-gate");
function sharedSearxngGate(): SearxngGate {
	const g = globalThis as { [SEARXNG_GATE]?: SearxngGate };
	return (g[SEARXNG_GATE] ??= createSearxngGate());
}

/** SearXNG: GET {base}/search?q=…&format=json&categories=general.
 *  Per docs.searxng.org/dev/search_api.html (checked 2026-11-03): `json`
 *  must be listed under search.formats in the instance's settings.yml, else
 *  403; there is NO result-count parameter (we slice). The response fields
 *  — results[].{title, url, content} and unresponsive_engines as
 *  [name, reason] pairs — come from SearXNG's source, not that docs page.
 *  `categories=general` keeps each query to the general web engines (fewer
 *  upstream requests). Never retries: retrying into a CAPTCHA/rate limit is
 *  what lengthens upstream blocks. */
export function searxngProvider(
	baseUrl: string,
	fetchFn: FetchLike = fetch,
	gate: SearxngGate = sharedSearxngGate(),
): SearchProvider {
	const base = normalizeBaseUrl(baseUrl);
	return {
		id: "searxng",
		async search(query: string, count: number): Promise<SearchHit[]> {
			if (!base) {
				throw new Error(`SEARXNG_URL "${baseUrl}" is not a valid http(s) base URL (e.g. http://localhost:8080)`);
			}
			const cacheKey = `${base}\n${query}`;
			const fresh = gate.cached(cacheKey);
			if (fresh) return fresh.slice(0, count);
			const hits = await gate.once(cacheKey, () =>
				gate.schedule(async () => {
					const result = await searxngRequest(base, query, fetchFn);
					gate.remember(cacheKey, result);
					return result;
				}),
			);
			return hits.slice(0, count);
		},
	};
}

async function searxngRequest(base: string, query: string, fetchFn: FetchLike): Promise<SearchHit[]> {
	const url = new URL(`${base}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("categories", "general");
	let resp: Response;
	try {
		resp = await fetchFn(url.toString(), {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(`SearXNG unreachable at ${base} — is the instance running? (${cause})`);
	}
	if (!resp.ok) {
		const body = (await resp.text()).slice(0, 200);
		if (resp.status === 403) {
			throw new Error(`SearXNG 403 — JSON output is likely disabled; add "json" to search.formats in the instance's settings.yml (${body})`);
		}
		if (resp.status === 429) {
			throw new Error(`SearXNG 429 — rate-limited by the instance's own limiter; disable it on a private instance (${body})`);
		}
		throw new Error(`SearXNG ${resp.status}: ${body}`);
	}
	const text = await resp.text();
	let data: {
		results?: Array<{ title?: string; url?: string; content?: string }>;
		unresponsive_engines?: unknown[];
	};
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`SearXNG returned non-JSON — is ${base} a SearXNG instance? (${text.slice(0, 200)})`);
	}
	const hits = (data.results ?? [])
		.filter((r) => typeof r.url === "string" && r.url)
		.map((r) => ({
			title: r.title || r.url || "",
			url: r.url ?? "",
			snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
		}));
	// Zero results while upstream engines failed is a FAILURE, not "nothing
	// exists" — say which engines, so the researcher reports a blocked
	// search instead of concluding the topic has no sources (D5).
	const failed = (data.unresponsive_engines ?? []).map((e) =>
		Array.isArray(e) ? e.filter((part) => typeof part === "string" && part).join(": ") : String(e),
	);
	if (hits.length === 0 && failed.length > 0) {
		throw new Error(
			`SearXNG returned no results — its upstream engines failed (${failed.join("; ")}). ` +
				"They are usually suspended for a while after a CAPTCHA or rate limit; do not retry right away.",
		);
	}
	return hits;
}

// ── engine resolution ───────────────────────────────────────────────────────

/** The engine's configured value (env-or-file; env wins) — an API key, or
 *  SearXNG's base URL. null when unset, which by owner decision means NOT
 *  LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = SEARCH_ENGINES.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** Every engine's live key, read fresh (the resolver's input). */
function engineKeys(): Partial<Record<SearchEngineId, string>> {
	const keys: Partial<Record<SearchEngineId, string>> = {};
	for (const { id } of SEARCH_ENGINES) {
		const key = engineKey(id);
		if (key) keys[id] = key;
	}
	return keys;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be configured; absent pin →
 *  first configured engine in preference order (SEARCH_ENGINES: Tavily →
 *  Brave → Exa → Firecrawl → Ollama → SearXNG). Never throws. `key` is the engine's configured value —
 *  SearXNG's is its base URL. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			const { envVar, credential } = searchEngineInfo(pinned);
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its ${credential} is missing — set the ${envVar} ${credential === "URL" ? "URL" : "key"}`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of SEARCH_ENGINES) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily, Brave, Exa, Firecrawl, or Ollama search API key, or a SearXNG URL",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	return { available, engine, reason };
}

/** Search status only — research itself remains available without a key. */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || !resolved.key) return null;
	switch (resolved.engine) {
		case "tavily":
			return withSearchCache(tavilyProvider(resolved.key));
		case "brave":
			return withSearchCache(braveProvider(resolved.key));
		case "exa":
			return withSearchCache(exaProvider(resolved.key));
		case "firecrawl":
			return withSearchCache(firecrawlProvider(resolved.key));
		case "ollama":
			return withSearchCache(ollamaProvider(resolved.key));
		case "searxng":
			return searxngProvider(resolved.key);
		default:
			return null;
	}
}
