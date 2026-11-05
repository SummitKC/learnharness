/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the search adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	resolveSearchEngineFor,
	tavilyProvider,
	braveProvider,
	exaProvider,
	firecrawlProvider,
	ollamaProvider,
	searxngProvider,
	createSearxngGate,
	createSearchCache,
	withSearchCache,
	type SearxngGate,
} from "../src/server/search.ts";
import { SEARCH_ENGINES, isSearchEngineId, type SearchEngineId, type SearchHit, type SearchProvider } from "../src/core/search.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");

		const fc = resolveSearchEngineFor(undefined, { firecrawl: "fc-throwaway-key-000001" });
		assert.ok(fc.available);
		assert.equal(fc.engine, "firecrawl");
		assert.match(fc.reason, /auto/);
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("Tavily and Brave keep their priority over Firecrawl", () => {
		const all = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
			firecrawl: "fc-throwaway-key-000001",
		});
		assert.equal(all.engine, "tavily");
		const braveAndFc = resolveSearchEngineFor(undefined, {
			brave: "brave-throwaway-key-00001",
			firecrawl: "fc-throwaway-key-000001",
		});
		assert.equal(braveAndFc.engine, "brave");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});

	it("auto-detects an Exa key, preserving existing engine priority", () => {
		assert.equal(resolveSearchEngineFor(undefined, { exa: "exa-test-key" }).engine, "exa");
		assert.equal(resolveSearchEngineFor(undefined, { exa: "exa-test-key", brave: "brave-key" }).engine, "brave");
		assert.equal(resolveSearchEngineFor(undefined, { exa: "exa-test-key", brave: "brave-key", tavily: "tavily-key" }).engine, "tavily");
	});

	it("honors an Exa pin and refuses to silently fall back", () => {
		assert.equal(resolveSearchEngineFor("exa", { exa: "exa-test-key", tavily: "tavily-key" }).engine, "exa");
		const missing = resolveSearchEngineFor("exa", { tavily: "tavily-key" });
		assert.equal(missing.available, false);
		assert.match(missing.reason, /EXA_API_KEY/);
	});

	it("a Firecrawl pin without its key names FIRECRAWL_API_KEY", () => {
		const out = resolveSearchEngineFor("firecrawl", { tavily: "tvly-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /FIRECRAWL_API_KEY/);

		const pinned = resolveSearchEngineFor("firecrawl", {
			tavily: "tvly-throwaway-key-00001",
			firecrawl: "fc-throwaway-key-000001",
		});
		assert.equal(pinned.engine, "firecrawl");
		assert.match(pinned.reason, /chosen/);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});

describe("exaProvider", () => {
	it("sends the documented request and maps bounded highlights to search hits", async () => {
		const provider = exaProvider("exa-secret-test-key", stubFetch({ results: [
			{ title: "Example", url: "https://example.com/a", highlights: ["first\nline", "second"] },
			{ url: "https://example.com/b", highlights: [], text: "x".repeat(600) },
			{ title: "Missing URL" }, { url: "javascript:alert(1)" }, null,
		] }, (url, init) => {
			assert.equal(url, "https://api.exa.ai/search");
			assert.equal(init.method, "POST");
			assert.equal((init.headers as Record<string, string>)["x-api-key"], "exa-secret-test-key");
			assert.deepEqual(JSON.parse(init.body as string), { query: "test query", type: "auto", numResults: 5, contents: { highlights: true } });
			assert.ok(init.signal);
		}));
		assert.deepEqual(await provider.search("test query", 5), [
			{ title: "Example", url: "https://example.com/a", snippet: "first line second" },
			{ title: "https://example.com/b", url: "https://example.com/b", snippet: "x".repeat(500) },
		]);
	});

	it("clamps counts to Exa's range", async () => {
		const counts: number[] = [];
		const provider = exaProvider("key", stubFetch({ results: [] }, (_url, init) => counts.push(JSON.parse(init.body as string).numResults)));
		await provider.search("q", 0);
		await provider.search("q", 200);
		assert.deepEqual(counts, [1, 100]);
	});

	it("reports HTTP and malformed-response failures without exposing the key", async () => {
		const key = "exa-secret-test-key";
		const denied = exaProvider(key, async () => new Response(`bad ${key}`, { status: 429 }));
		await assert.rejects(denied.search("q", 5), (error: Error) => /Exa search API 429/.test(error.message) && !error.message.includes(key));
		const malformed = exaProvider(key, async () => new Response(JSON.stringify({ results: null }), { status: 200 }));
		await assert.rejects(malformed.search("q", 5), /invalid response/);
	});
});

describe("firecrawlProvider (wire shape per docs.firecrawl.dev, verified 2026-10-29)", () => {
	it("POSTs api.firecrawl.dev/v2/search with Bearer auth + query/limit, no scrape", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", stubFetch(
			{
				success: true,
				data: {
					web: [
						{ title: "Example", url: "https://example.com/c", description: "line1\nline2", position: 1 },
						{ url: "https://example.com/untitled", description: "no title" },
						{ title: "No URL", description: "dropped" },
					],
				},
			},
			(url, init) => {
				assert.equal(url, "https://api.firecrawl.dev/v2/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer fc-throwaway-key-000001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.limit, 5);
				// A bare search — scraping each hit would cost extra credits.
				assert.equal(body.scrapeOptions, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [
			{ title: "Example", url: "https://example.com/c", snippet: "line1 line2" },
			{ title: "https://example.com/untitled", url: "https://example.com/untitled", snippet: "no title" },
		]);
	});

	it("reports HTTP status without exposing the provider error body", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", async () =>
			new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid token" }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Firecrawl search API 401$/);
	});

	it("reports HTTP status without exposing a non-JSON error body", async () => {
		const provider = firecrawlProvider("fc-throwaway-key-000001", async () =>
			new Response("Payment Required", { status: 402 }),
		);
		await assert.rejects(provider.search("q", 5), /Firecrawl search API 402$/);
	});
});

// Search-only subset of chiranjivsethi's PR #81, source commit a216fa8.
// No fetchPage, local model server, or model pricing is part of this adapter.
describe("ollamaProvider (hosted search only)", () => {
	it("POSTs ollama.com/api/web_search with Bearer auth and bounded snippets", async () => {
		const provider = ollamaProvider("ollama-fake-key-123456", stubFetch({ results: [
			{ title: "Ollama", url: "https://ollama.com", content: "line1\nline2" },
			{ url: "https://example.org", content: "x".repeat(600) },
			{ content: "no URL" }, { url: "javascript:alert(1)" }, null,
		] }, (url, init) => {
			assert.equal(url, "https://ollama.com/api/web_search");
			assert.equal(init.method, "POST");
			assert.equal((init.headers as Record<string, string>).authorization, "Bearer ollama-fake-key-123456");
			assert.deepEqual(JSON.parse(init.body as string), { query: "test query", max_results: 5 });
			assert.ok(init.signal);
		}));
		assert.deepEqual(await provider.search("test query", 5), [
			{ title: "Ollama", url: "https://ollama.com", snippet: "line1 line2" },
			{ title: "https://example.org", url: "https://example.org", snippet: "x".repeat(500) },
		]);
		assert.equal("fetchPage" in provider, false);
	});
});

describe("six-engine catalog and resolution", () => {
	it("pins the approved Automatic order independently of table-driven tests", () => {
		assert.deepEqual(SEARCH_ENGINES.map(({ id }) => id), ["tavily", "brave", "exa", "firecrawl", "ollama", "searxng"]);
		assert.equal(isSearchEngineId("chatgpt"), false);
		assert.equal(isSearchEngineId("deepseek"), false);
		for (const value of [null, {}, 1, "", "toString"]) assert.equal(isSearchEngineId(value), false);
	});

	it("resolves every combination of configured keys without changing precedence", () => {
		for (let mask = 0; mask < 2 ** SEARCH_ENGINES.length; mask++) {
			const configured = SEARCH_ENGINES.filter((_, index) => mask & (1 << index));
			const keys = Object.fromEntries(configured.map(({ id }) => [id, `fake-${id}`]));
			const result = resolveSearchEngineFor(undefined, keys);
			assert.equal(result.engine, configured[0]?.id ?? null, `key mask ${mask}`);
			assert.equal(result.available, configured.length > 0);
		}
	});

	for (const { id, envVar } of SEARCH_ENGINES) {
		it(`${id}: an explicit pin wins, but a missing pinned key never falls back`, () => {
			const keys: Partial<Record<SearchEngineId, string>> = Object.fromEntries(SEARCH_ENGINES.map(({ id }) => [id, `fake-${id}`]));
			assert.equal(resolveSearchEngineFor(id, keys).engine, id);
			delete keys[id];
			const missing = resolveSearchEngineFor(id, keys);
			assert.equal(missing.available, false);
			assert.equal(missing.engine, null);
			assert.ok(missing.reason.includes(envVar));
		});
	}
});

const NEW_ADAPTERS = [
	{ label: "Exa", create: exaProvider, body: { results: [] }, field: "numResults", max: 100 },
	{ label: "Firecrawl", create: firecrawlProvider, body: { success: true, data: { web: [] } }, field: "limit", max: 100 },
	{ label: "Ollama", create: ollamaProvider, body: { results: [] }, field: "max_results", max: 10 },
] as const;

for (const { label, create, body, field, max } of NEW_ADAPTERS) {
	describe(`${label}: search adapter failure/shape contract`, () => {
		it("returns an empty result array for a successful empty search", async () => {
			assert.deepEqual(await create("fake-key", stubFetch(body, () => {})).search("q", 5), []);
		});
		it("sends integer counts within the provider range", async () => {
			const counts: number[] = [];
			const provider = create("fake-key", stubFetch(body, (_url, init) => counts.push(JSON.parse(init.body as string)[field])));
			for (const count of [1, 5, 10, 200, 0, 2.8]) await provider.search("q", count);
			assert.deepEqual(counts, [1, 5, 10, max, 1, 2]);
		});
		it("rejects malformed envelopes and invalid JSON without echoing bodies", async () => {
			for (const invalid of [null, {}, [], { results: null }, { success: false, error: "fake-secret-123456" }]) {
				const provider = create("fake-secret-123456", async () => new Response(JSON.stringify(invalid)));
				await assert.rejects(provider.search("q", 5), { message: `${label} search API returned an invalid response` });
			}
			const provider = create("fake-secret-123456", async () => new Response("invalid fake-secret-123456"));
			await assert.rejects(provider.search("q", 5), { message: `${label} search API returned an invalid response` });
		});
		it("reports auth, quota, rate-limit and server failures without response bodies or retries", async () => {
			for (const status of [401, 402, 429, 500]) {
				let calls = 0;
				const provider = create("fake-secret-123456", async () => {
					calls++;
					return new Response("fake-secret-123456", { status });
				});
				await assert.rejects(provider.search("q", 5), { message: `${label} search API ${status}` });
				assert.equal(calls, 1);
			}
		});
	});
}

it("Firecrawl drops invalid result rows and normalizes only search descriptions", async () => {
	const provider = firecrawlProvider("fc-fake-key-123456789", stubFetch({ success: true, data: { web: [
		null, 1, { url: "file:///tmp/private" }, { url: "not a URL" },
		{ title: 42, url: "https://example.org", description: "x".repeat(700), markdown: "not returned" },
		{ url: "https://example.com", description: 123 },
	] } }, () => {}));
	assert.deepEqual(await provider.search("q", 5), [
		{ title: "https://example.org", url: "https://example.org", snippet: "x".repeat(500) },
		{ title: "https://example.com", url: "https://example.com", snippet: "" },
	]);
});

// ── keyed-engine result cache (fork addition, 2026-11-03) ───────────────────

/** A fake keyed engine that records every request and returns `count` hits. */
function recordingEngine(id: "tavily" | "brave", opts: { fail?: () => boolean } = {}) {
	const calls: Array<{ query: string; count: number }> = [];
	const provider: SearchProvider = {
		id,
		async search(query, count) {
			calls.push({ query, count });
			if (opts.fail?.()) throw new Error(`${id} search API 500: boom`);
			return Array.from({ length: count }, (_, i): SearchHit => ({ title: `${query} ${i}`, url: `https://e.com/${i}`, snippet: "s" }));
		},
	};
	return { provider, calls };
}

describe("withSearchCache (Tavily/Brave: repeats don't spend the paid allowance)", () => {
	it("a repeated query is answered from cache — one paid request; the id is preserved", async () => {
		const { provider, calls } = recordingEngine("brave");
		const cached = withSearchCache(provider, createSearchCache());
		assert.equal(cached.id, "brave");
		assert.equal((await cached.search("linear algebra eigenvalues", 5)).length, 5);
		assert.equal((await cached.search("linear algebra eigenvalues", 5)).length, 5);
		assert.equal(calls.length, 1);
	});

	it("fills with the tool maximum (10) once, so any later count ≤ 10 is served locally", async () => {
		const { provider, calls } = recordingEngine("brave");
		const cached = withSearchCache(provider, createSearchCache());
		assert.equal((await cached.search("q", 3)).length, 3);
		assert.deepEqual(calls, [{ query: "q", count: 10 }], "asked for 10 — same price per request");
		assert.equal((await cached.search("q", 10)).length, 10);
		assert.equal(calls.length, 1);
	});

	it("different queries and different engines never share entries", async () => {
		const cache = createSearchCache();
		const brave = recordingEngine("brave");
		const tavily = recordingEngine("tavily");
		await withSearchCache(brave.provider, cache).search("q", 5);
		await withSearchCache(brave.provider, cache).search("other", 5);
		await withSearchCache(tavily.provider, cache).search("q", 5);
		assert.equal(brave.calls.length, 2);
		assert.equal(tavily.calls.length, 1);
	});

	it("failures are never cached — the next call asks again", async () => {
		let fail = true;
		const { provider, calls } = recordingEngine("brave", { fail: () => fail });
		const cached = withSearchCache(provider, createSearchCache());
		await assert.rejects(cached.search("q", 5), /brave search API 500/);
		fail = false;
		assert.equal((await cached.search("q", 5)).length, 5);
		assert.equal(calls.length, 2);
	});

	it("concurrent identical queries share ONE paid request", async () => {
		const { provider, calls } = recordingEngine("tavily");
		const cached = withSearchCache(provider, createSearchCache());
		const [a, b] = await Promise.all([cached.search("q", 2), cached.search("q", 6)]);
		assert.equal(a.length, 2);
		assert.equal(b.length, 6);
		assert.equal(calls.length, 1);
	});

	it("an expired entry is fetched again", async () => {
		let t = 0;
		const { provider, calls } = recordingEngine("brave");
		const cached = withSearchCache(provider, createSearchCache({ ttlMs: 30 * 60_000, now: () => t }));
		await cached.search("q", 5);
		t += 31 * 60_000;
		await cached.search("q", 5);
		assert.equal(calls.length, 2);
	});
});

// ── SearXNG (fork addition, 2026-11-03) ─────────────────────────────────────

describe("resolveSearchEngineFor with SearXNG (keyless, configured by URL)", () => {
	const URL_ = "http://localhost:8080";

	it("a URL alone is enough — SearXNG auto-activates", () => {
		const out = resolveSearchEngineFor(undefined, { searxng: URL_ });
		assert.ok(out.available);
		assert.equal(out.engine, "searxng");
		assert.equal(out.key, URL_);
		assert.match(out.reason, /auto/);
	});

	it("auto order: a paid key still wins over SearXNG", () => {
		assert.equal(resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001", searxng: URL_ }).engine, "tavily");
		assert.equal(resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001", searxng: URL_ }).engine, "brave");
	});

	it("the explicit SearXNG pin wins over present paid keys", () => {
		const out = resolveSearchEngineFor("searxng", { tavily: "tvly-throwaway-key-00001", searxng: URL_ });
		assert.equal(out.engine, "searxng");
		assert.match(out.reason, /chosen/);
	});

	it("pinned SearXNG without a URL is unavailable and says to set SEARXNG_URL — no fallback", () => {
		const out = resolveSearchEngineFor("searxng", { tavily: "tvly-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /URL is missing/);
		assert.match(out.reason, /SEARXNG_URL/);
	});

	it("nothing configured: the reason mentions the SearXNG option", () => {
		assert.match(resolveSearchEngineFor(undefined, {}).reason, /SearXNG URL/);
	});
});

/** A gate with no spacing — adapter tests exercise the wire, not the clock. */
const instantGate = (): SearxngGate => createSearxngGate({ minIntervalMs: 0, sleep: async () => {} });

/** A stub fetch that counts calls and answers each one via `reply`. */
function countingFetch(reply: (url: string) => Response | Promise<Response>) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fn = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		return reply(url);
	};
	return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("searxngProvider (wire shape per docs.searxng.org/dev/search_api.html, checked 2026-11-03)", () => {
	it("GETs {base}/search with q, format=json, categories=general; maps + filters + slices to count", async () => {
		const { fn, calls } = countingFetch(() =>
			json({
				results: [
					{ title: "One", url: "https://example.com/1", content: "first\nline" },
					{ title: "", url: "https://example.com/2" },
					{ title: "No URL", content: "dropped" },
					{ title: "Three", url: "https://example.com/3", content: "third" },
				],
				unresponsive_engines: [],
			}),
		);
		const provider = searxngProvider("http://localhost:8080/", fn, instantGate());
		assert.equal(provider.id, "searxng");
		const hits = await provider.search("test query", 2);
		assert.deepEqual(hits, [
			{ title: "One", url: "https://example.com/1", snippet: "first line" },
			{ title: "https://example.com/2", url: "https://example.com/2", snippet: "" },
		]);
		assert.equal(calls.length, 1);
		const sent = new URL(calls[0]!.url);
		assert.equal(sent.origin + sent.pathname, "http://localhost:8080/search", "trailing slash normalized");
		assert.equal(sent.searchParams.get("q"), "test query");
		assert.equal(sent.searchParams.get("format"), "json");
		assert.equal(sent.searchParams.get("categories"), "general");
		assert.equal((calls[0]!.init.headers as Record<string, string>).accept, "application/json");
	});

	it("keeps a path prefix (instance served under /searxng)", async () => {
		const { fn, calls } = countingFetch(() => json({ results: [] }));
		await searxngProvider("https://home.lan/searxng/", fn, instantGate()).search("q", 5);
		assert.ok(calls[0]!.url.startsWith("https://home.lan/searxng/search?"), calls[0]!.url);
	});

	it("an invalid base URL fails clearly without any request", async () => {
		const { fn, calls } = countingFetch(() => json({ results: [] }));
		await assert.rejects(searxngProvider("localhost:8080", fn, instantGate()).search("q", 5), /not a valid http\(s\) base URL/);
		assert.equal(calls.length, 0);
	});

	it("403 explains the JSON-format setting", async () => {
		const { fn } = countingFetch(() => new Response("Forbidden", { status: 403 }));
		await assert.rejects(searxngProvider("http://localhost:8080", fn, instantGate()).search("q", 5), /JSON output is likely disabled.*search\.formats/);
	});

	it("429 points at the instance's limiter", async () => {
		const { fn } = countingFetch(() => new Response("Too Many Requests", { status: 429 }));
		await assert.rejects(searxngProvider("http://localhost:8080", fn, instantGate()).search("q", 5), /SearXNG 429.*limiter/);
	});

	it("other statuses surface as-is", async () => {
		const { fn } = countingFetch(() => new Response("boom", { status: 500 }));
		await assert.rejects(searxngProvider("http://localhost:8080", fn, instantGate()).search("q", 5), /SearXNG 500: boom/);
	});

	it("a non-JSON body (not a SearXNG instance) fails clearly", async () => {
		const { fn } = countingFetch(() => new Response("<html>hello</html>", { status: 200 }));
		await assert.rejects(searxngProvider("http://localhost:8080", fn, instantGate()).search("q", 5), /non-JSON/);
	});

	it("a network failure says the instance is unreachable", async () => {
		const provider = searxngProvider("http://localhost:8080", async () => {
			throw new TypeError("fetch failed");
		}, instantGate());
		await assert.rejects(provider.search("q", 5), /SearXNG unreachable at http:\/\/localhost:8080 — is the instance running\? \(fetch failed\)/);
	});

	it("zero results while upstream engines failed is an ERROR naming them (not 'nothing exists')", async () => {
		const { fn } = countingFetch(() =>
			json({ results: [], unresponsive_engines: [["google", "CAPTCHA"], ["duckduckgo", "timeout"]] }),
		);
		await assert.rejects(
			searxngProvider("http://localhost:8080", fn, instantGate()).search("q", 5),
			/no results — its upstream engines failed \(google: CAPTCHA; duckduckgo: timeout\).*do not retry right away/,
		);
	});

	it("zero results with every engine healthy is a plain empty list", async () => {
		const { fn } = countingFetch(() => json({ results: [], unresponsive_engines: [] }));
		assert.deepEqual(await searxngProvider("http://localhost:8080", fn, instantGate()).search("q", 5), []);
	});

	it("results arriving despite some failed engines are returned (partial is fine)", async () => {
		const { fn } = countingFetch(() =>
			json({ results: [{ title: "T", url: "https://e.com/", content: "s" }], unresponsive_engines: [["google", "CAPTCHA"]] }),
		);
		assert.equal((await searxngProvider("http://localhost:8080", fn, instantGate()).search("q", 5)).length, 1);
	});
});

describe("searxngProvider + gate: in-memory cache and request sharing (D7)", () => {
	const page = json({
		results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://e.com/${i}`, content: "s" })),
	});

	it("a repeated query is served from cache — one request; a different count reslices the cached list", async () => {
		const gate = instantGate();
		const { fn, calls } = countingFetch(() => page.clone());
		const provider = searxngProvider("http://localhost:8080", fn, gate);
		assert.equal((await provider.search("same", 3)).length, 3);
		assert.equal((await provider.search("same", 8)).length, 8);
		assert.equal(calls.length, 1);
		await provider.search("different", 3);
		assert.equal(calls.length, 2);
	});

	it("the cache is per instance URL", async () => {
		const gate = instantGate();
		const { fn, calls } = countingFetch(() => page.clone());
		await searxngProvider("http://localhost:8080", fn, gate).search("same", 3);
		await searxngProvider("http://localhost:9090", fn, gate).search("same", 3);
		assert.equal(calls.length, 2);
	});

	it("failures are never cached — the next call asks again", async () => {
		const gate = instantGate();
		let fail = true;
		const { fn, calls } = countingFetch(() => (fail ? new Response("boom", { status: 500 }) : page.clone()));
		const provider = searxngProvider("http://localhost:8080", fn, gate);
		await assert.rejects(provider.search("q", 5));
		fail = false;
		assert.equal((await provider.search("q", 5)).length, 5);
		assert.equal(calls.length, 2);
	});

	it("concurrent identical queries share ONE request", async () => {
		const gate = instantGate();
		const { fn, calls } = countingFetch(() => page.clone());
		const provider = searxngProvider("http://localhost:8080", fn, gate);
		const [a, b] = await Promise.all([provider.search("same", 2), provider.search("same", 4)]);
		assert.equal(a.length, 2);
		assert.equal(b.length, 4);
		assert.equal(calls.length, 1);
	});
});

describe("createSearxngGate (D7 cache bounds, D8 spacing)", () => {
	/** A fake clock: sleep() records the wait and advances time. */
	function fakeClock() {
		let t = 1_000_000;
		const waits: number[] = [];
		return {
			now: () => t,
			advance: (ms: number) => {
				t += ms;
			},
			sleep: async (ms: number) => {
				waits.push(ms);
				t += ms;
			},
			waits,
		};
	}

	it("spaces request starts ≥ minIntervalMs apart; an idle gap needs no wait", async () => {
		const clock = fakeClock();
		const gate = createSearxngGate({ minIntervalMs: 1_500, now: clock.now, sleep: clock.sleep });
		const starts: number[] = [];
		const job = async () => {
			starts.push(clock.now());
		};
		await Promise.all([gate.schedule(job), gate.schedule(job), gate.schedule(job)]);
		assert.deepEqual(clock.waits, [1_500, 1_500]);
		assert.deepEqual(starts.map((s) => s - starts[0]!), [0, 1_500, 3_000]);
		clock.advance(10_000);
		await gate.schedule(job);
		assert.equal(clock.waits.length, 2, "no wait after an idle gap");
	});

	it("runs one at a time: the next call starts only after the previous one settles", async () => {
		const gate = createSearxngGate({ minIntervalMs: 0, sleep: async () => {} });
		const log: string[] = [];
		let release!: () => void;
		const first = gate.schedule(
			() =>
				new Promise<void>((resolve) => {
					log.push("first:start");
					release = () => {
						log.push("first:end");
						resolve();
					};
				}),
		);
		const second = gate.schedule(async () => {
			log.push("second:start");
		});
		await new Promise((r) => setTimeout(r, 5));
		assert.deepEqual(log, ["first:start"], "second waits while first is in flight");
		release();
		await Promise.all([first, second]);
		assert.deepEqual(log, ["first:start", "first:end", "second:start"]);
	});

	it("a failed call does not jam the queue", async () => {
		const gate = createSearxngGate({ minIntervalMs: 0, sleep: async () => {} });
		await assert.rejects(gate.schedule(async () => {
			throw new Error("upstream down");
		}));
		assert.equal(await gate.schedule(async () => "next"), "next");
	});

	it("entries expire after ttlMs", () => {
		const clock = fakeClock();
		const gate = createSearxngGate({ ttlMs: 30 * 60_000, now: clock.now });
		gate.remember("k", [{ title: "t", url: "https://e.com/", snippet: "s" }]);
		clock.advance(29 * 60_000);
		assert.ok(gate.cached("k"), "still fresh");
		clock.advance(2 * 60_000);
		assert.equal(gate.cached("k"), undefined, "expired");
	});

	it("capacity evicts the least recently USED entry", () => {
		const gate = createSearxngGate({ maxEntries: 2 });
		const hit = [{ title: "t", url: "https://e.com/", snippet: "s" }];
		gate.remember("a", hit);
		gate.remember("b", hit);
		assert.ok(gate.cached("a"), "touch a — b is now the oldest");
		gate.remember("c", hit);
		assert.ok(gate.cached("a"));
		assert.equal(gate.cached("b"), undefined, "b evicted");
		assert.ok(gate.cached("c"));
	});
});
