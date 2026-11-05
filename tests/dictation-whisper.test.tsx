/**
 * Local-Whisper dictation: the engine preference, the pure helpers (WAV
 * framing, language mapping), the /api/stt/transcribe proxy, and the batch
 * run in useDictation (record → stop → one POST → deferred flush).
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, test } from "node:test";
import { parseHTML } from "linkedom";

for (const v of ["WHISPER_URL", "WHISPER_MODEL", "DEEPGRAM_API_KEY", "LH_IGNORE_ENV_KEYS"]) delete process.env[v];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-whisper-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_DATA_DIR = TMP;
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const { encodeWav, whisperLanguage, isDictationEngine } = await import("../src/core/dictation.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { parseDictationSettingsBody } = await import("../src/server/settings-body.ts");
const { createDictationLanguageStore } = await import("../components/dictation-preference.ts");

describe("engine preference", () => {
	it("defaults to Deepgram and stores each field independently", () => {
		assert.equal(resolveSettings(null).dictation.engine, "deepgram");
		assert.equal(resolveSettings({ version: 1, dictation: { language: "pl" } }).dictation.engine, "deepgram");
		const record = sanitizeUserSettings({ version: 1, dictation: { language: "xx", engine: "whisper" } });
		assert.deepEqual(record?.dictation, { engine: "whisper" }, "a bad language never drops a good engine");
		assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { engine: "nope" } })?.dictation, {});
		assert.ok(isDictationEngine("whisper") && !isDictationEngine("openai"));
	});

	it("the section parser validates the engine", () => {
		assert.deepEqual(parseDictationSettingsBody({ language: "en", engine: "whisper" }),
			{ ok: true, settings: { language: "en", engine: "whisper" } });
		assert.deepEqual(parseDictationSettingsBody({ language: "en" }), { ok: true, settings: { language: "en" } });
		assert.equal(parseDictationSettingsBody({ engine: "nope" }).ok, false);
	});

	it("every write carries both fields — an engine switch keeps the language and vice versa", async () => {
		const bodies: unknown[] = [];
		const store = createDictationLanguageStore(async (_url, init) => {
			if (init?.method === "PUT") {
				const body = JSON.parse(init.body as string);
				bodies.push(body);
				return Response.json({ settings: { version: 1, dictation: body } });
			}
			return Response.json({ settings: { version: 1, dictation: { language: "pl" } } });
		});
		assert.deepEqual(await (store.load(), store.getConfig()), { language: "pl", engine: "deepgram" });
		assert.equal(await store.saveEngine("whisper"), true);
		assert.equal(await store.save("fr"), true);
		assert.deepEqual(bodies, [{ language: "pl", engine: "whisper" }, { language: "fr", engine: "whisper" }]);
		assert.deepEqual(await store.getConfig(), { language: "fr", engine: "whisper" });
	});
});

describe("pure helpers", () => {
	it("maps app languages to Whisper's ISO-639-1 codes; multilingual auto-detects", () => {
		assert.equal(whisperLanguage("multi"), undefined);
		assert.equal(whisperLanguage("en-GB"), "en");
		assert.equal(whisperLanguage("zh-Hant"), "zh");
		assert.equal(whisperLanguage("es-419"), "es");
		assert.equal(whisperLanguage("sv"), "sv");
	});

	it("encodeWav writes a canonical 16kHz mono linear16 header + the frames in order", () => {
		const a = new Int16Array([1, 2]).buffer;
		const b = new Int16Array([3]).buffer;
		const wav = encodeWav([a, b]);
		const v = new DataView(wav);
		const tag = (at: number) => String.fromCharCode(...new Uint8Array(wav, at, 4));
		assert.equal(wav.byteLength, 44 + 6);
		assert.deepEqual([tag(0), tag(8), tag(12), tag(36)], ["RIFF", "WAVE", "fmt ", "data"]);
		assert.equal(v.getUint32(4, true), 36 + 6);
		assert.equal(v.getUint16(20, true), 1); // PCM
		assert.equal(v.getUint16(22, true), 1); // mono
		assert.equal(v.getUint32(24, true), 16000);
		assert.equal(v.getUint32(28, true), 32000);
		assert.equal(v.getUint16(34, true), 16);
		assert.equal(v.getUint32(40, true), 6);
		assert.deepEqual([...new Int16Array(wav, 44, 3)], [1, 2, 3]);
	});
});

describe("/api/stt/transcribe", async () => {
	const route = await import("../app/api/stt/transcribe/route.ts");
	const realFetch = globalThis.fetch;
	let upstream: { url: string; init?: RequestInit }[] = [];
	const stub = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
		upstream = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			upstream.push({ url: String(url), init });
			return impl(String(url), init);
		}) as typeof fetch;
	};
	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.WHISPER_URL;
		delete process.env.WHISPER_MODEL;
	});
	const post = (bytes = 100, query = "?language=pl") => route.POST(new Request(`http://localhost/api/stt/transcribe${query}`, {
		method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(bytes),
	}));

	it("is 503 (the keyless signal) without WHISPER_URL", async () => {
		assert.equal((await route.GET()).status, 503);
		assert.equal((await post()).status, 503);
	});

	it("preflight pings /v1/models (any HTTP answer = up), 502 when unreachable", async () => {
		process.env.WHISPER_URL = "http://localhost:8000/v1/";
		stub(async () => new Response("nope", { status: 404 }));
		assert.equal((await route.GET()).status, 200);
		assert.equal(upstream[0]!.url, "http://localhost:8000/v1/models", "trailing /v1/ normalized");
		stub(async () => { throw new TypeError("fetch failed"); });
		const res = await route.GET();
		assert.equal(res.status, 502);
		assert.match(((await res.json()) as { message: string }).message, /unreachable at http:\/\/localhost:8000/);
	});

	it("forwards the WAV as OpenAI-compatible multipart and returns trimmed text", async () => {
		process.env.WHISPER_URL = "http://localhost:8000";
		process.env.WHISPER_MODEL = "custom/model";
		stub(async () => Response.json({ text: "  Hello there. " }));
		const res = await post();
		assert.deepEqual(await res.json(), { text: "Hello there." });
		assert.equal(upstream[0]!.url, "http://localhost:8000/v1/audio/transcriptions");
		const form = upstream[0]!.init!.body as FormData;
		assert.equal(form.get("model"), "custom/model");
		assert.equal(form.get("language"), "pl");
		assert.equal(form.get("response_format"), "json");
		assert.equal((form.get("file") as File).size, 100);
	});

	it("omits language for auto-detect and rejects junk language params", async () => {
		process.env.WHISPER_URL = "http://localhost:8000";
		stub(async () => Response.json({ text: "x" }));
		await post(100, "");
		assert.equal((upstream[0]!.init!.body as FormData).get("language"), null);
		await post(100, "?language=en%26model=evil");
		assert.equal((upstream[0]!.init!.body as FormData).get("language"), null);
	});

	it("maps a 404 to a download-the-model hint and skips header-only bodies", async () => {
		process.env.WHISPER_URL = "http://localhost:8000";
		stub(async () => new Response("model not found", { status: 404 }));
		const res = await post();
		assert.equal(res.status, 502);
		assert.match(((await res.json()) as { message: string }).message, /model "Systran\/faster-whisper-large-v3" not found/);
		assert.deepEqual(await (await post(44)).json(), { text: "" });
		assert.equal(upstream.length, 1, "no upstream call for an empty capture");
	});
});

/* ── The batch run inside useDictation ─────────────────────────────────── */

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static count = 0;
	readyState = 0;
	constructor() { super(); Socket.count++; }
	send() {}
	close() {}
}
class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static last: Worklet | null = null;
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {}
	disconnect() {}
}

let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

async function whisperFixture(opts: { preflight?: number; transcript?: Response } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = { posts: [] as { url: string; body: ArrayBuffer }[], appends: [] as string[], stops: 0 };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { state.stops++; } }] }) } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation: { language: "pl", engine: "whisper" } } });
			if (url === "/api/stt/token") return Response.json({ message: "keyless" }, { status: 503 });
			if (url === "/api/stt/transcribe" && !init?.method) {
				const status = opts.preflight ?? 200;
				return Response.json(status === 200 ? { ok: true } : { message: "down" }, { status });
			}
			if (url.startsWith("/api/stt/transcribe") && init?.method === "POST") {
				state.posts.push({ url, body: init.body as ArrayBuffer });
				return opts.transcript ?? Response.json({ text: "cześć" });
			}
			throw new Error(`unexpected fetch ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, d] of previous) {
			if (d) Object.defineProperty(globalThis, key, d);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	};
	const { useDictation } = await import("../components/dictation.tsx");
	const { useDictationLanguage } = await import("../components/dictation-preference.ts");
	const { notifySettingsSaved } = await import("../components/settings-signal.ts");
	const { createRoot } = await import("react-dom/client");
	let latest!: ReturnType<typeof useDictation>;
	function Harness() {
		latest = useDictation({ append: (t) => state.appends.push(t) });
		useDictationLanguage();
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	await act(async () => { notifySettingsSaved("dictation"); }); // drop any earlier fixture's cache
	dispose = async () => { await act(async () => { root.unmount(); }); };
	const feed = async (rms: number, frames: number) => {
		await act(async () => {
			const port = Worklet.last!.port;
			port.onmessage!({ data: { type: "level", rms } });
			for (let i = 0; i < frames; i++) port.onmessage!({ data: { type: "audio", buffer: new Int16Array(2048).fill(i + 1).buffer } });
		});
	};
	return { state, get dictation() { return latest; }, feed };
}

test("whisper: records locally, stops into ONE wav POST, and flushes the transcript once", async () => {
	Socket.count = 0;
	const f = await whisperFixture();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording");
	await f.feed(0.2, 3);
	assert.equal(f.state.posts.length, 0, "nothing leaves the machine while recording");
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.posts.length, 1);
	assert.equal(f.state.posts[0]!.url, "/api/stt/transcribe?language=pl");
	assert.equal(f.state.posts[0]!.body.byteLength, 44 + 3 * 2048 * 2);
	assert.deepEqual(f.state.appends, ["cześć"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.stops, 1, "the mic is released");
	assert.equal(Socket.count, 0, "no Deepgram socket on the whisper engine");
});

test("whisper: a silent run is never sent (Whisper invents text on silence)", async () => {
	const f = await whisperFixture();
	await act(async () => { f.dictation.toggle(); });
	await f.feed(0.0001, 5);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.posts.length, 0);
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
});

test("whisper: an unconfigured server fails at START with the keyless line", async () => {
	const { DICTATION_WHISPER_UNSET } = await import("../components/dictation.tsx");
	const f = await whisperFixture({ preflight: 503 });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, DICTATION_WHISPER_UNSET);
});

test("whisper: a failed transcription surfaces the route's message", async () => {
	const f = await whisperFixture({ transcript: Response.json({ message: "Whisper transcription failed (500): boom" }, { status: 502 }) });
	await act(async () => { f.dictation.toggle(); });
	await f.feed(0.2, 1);
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.error, "Whisper transcription failed (500): boom");
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
});
