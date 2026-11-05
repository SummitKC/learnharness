/**
 * Local Whisper dictation (the self-hosted alternative to Deepgram).
 *
 * WHISPER_URL is the base URL of any OpenAI-compatible speech-to-text
 * server — the bundled recipe is speaches in Docker (docker/whisper/) — and
 * lives server-side like SEARXNG_URL (auth.json in the desktop app,
 * .env.local in dev). WHISPER_MODEL optionally overrides the model id.
 *
 * Unlike Deepgram, audio DOES pass through this server: the renderer holds
 * one WAV per run and POSTs it here on stop. Proxying keeps the URL
 * server-side and sidesteps CORS on the user's container; everything stays
 * on the machine.
 *
 *   GET  → preflight, run at dictation start (concurrent with the mic):
 *          503 when unconfigured, 502 when the server is unreachable — the
 *          learner hears about a stopped container BEFORE speaking.
 *   POST → body: audio/wav; ?language=<ISO-639-1> (omit = auto-detect)
 *          → 200 {text} | 4xx/5xx {message}
 */
import { keyValue } from "@/src/server";

export const dynamic = "force-dynamic";

const DEFAULT_MODEL = "Systran/faster-whisper-large-v3";
/** ~10 min of 16kHz linear16 mono is 19.2 MB; leave headroom for the header. */
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 2500;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Accept "http://host:8000", "http://host:8000/", or ".../v1". */
function apiBase(raw: string): string {
	return raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function config(): { base: string; model: string } | Response {
	const url = keyValue("WHISPER_URL");
	if (!url) {
		return Response.json(
			{ message: "No WHISPER_URL — add it to auth.json (desktop) or .env.local (dev)." },
			{ status: 503 },
		);
	}
	return { base: apiBase(url), model: keyValue("WHISPER_MODEL")?.trim() || DEFAULT_MODEL };
}

export async function GET() {
	const c = config();
	if (c instanceof Response) return c;
	try {
		// Any HTTP answer proves the server is up; only a network failure fails.
		await fetch(`${c.base}/v1/models`, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
		return Response.json({ ok: true, model: c.model });
	} catch {
		return Response.json({ message: `Whisper server unreachable at ${c.base}` }, { status: 502 });
	}
}

export async function POST(request: Request) {
	const c = config();
	if (c instanceof Response) return c;

	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_AUDIO_BYTES) {
		return Response.json({ message: "Recording too long for local Whisper" }, { status: 413 });
	}
	const audio = await request.arrayBuffer();
	if (audio.byteLength > MAX_AUDIO_BYTES) {
		return Response.json({ message: "Recording too long for local Whisper" }, { status: 413 });
	}
	if (audio.byteLength <= 44) return Response.json({ text: "" }); // header only — nothing captured

	const form = new FormData();
	form.append("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
	form.append("model", c.model);
	form.append("response_format", "json");
	form.append("temperature", "0");
	const language = new URL(request.url).searchParams.get("language");
	if (language && /^[a-z]{2,3}$/.test(language)) form.append("language", language);

	let res: Response;
	try {
		res = await fetch(`${c.base}/v1/audio/transcriptions`, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
		});
	} catch (e) {
		const timedOut = e instanceof DOMException && e.name === "TimeoutError";
		return Response.json(
			{ message: timedOut ? "Whisper transcription timed out" : `Whisper server unreachable at ${c.base}` },
			{ status: 502 },
		);
	}
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 200);
		const message = res.status === 404
			? `Whisper model "${c.model}" not found on the server — download it first (see docker/whisper/README.md)`
			: `Whisper transcription failed (${res.status}): ${detail}`;
		return Response.json({ message }, { status: 502 });
	}
	const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
	if (!data || typeof data.text !== "string") {
		return Response.json({ message: "Whisper returned no transcript" }, { status: 502 });
	}
	return Response.json({ text: data.text.trim() });
}
