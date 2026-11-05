/*
 * whisper-autostart — bring the local Whisper container up on app open.
 *
 * Best-effort and NON-BLOCKING: boot never waits on Docker, and every
 * failure is one log line (userData/logs/main.log). Runs only when it can
 * matter:
 *   - the dictation engine is "whisper" (settings.json), and
 *   - WHISPER_URL (real env wins, else auth.json) points at THIS machine —
 *     a remote server isn't ours to start.
 * Steps: already answering? done. Docker daemon down? `docker desktop start`
 * (Docker Desktop's own CLI; waits until the engine is up). Then
 * `docker start learnharness-whisper` — the container docker/whisper/
 * compose.yaml creates on its first `docker compose up -d`. The compose
 * file is not shipped inside the app, so that first `up` stays a one-time
 * manual step (it also owns the model-cache volume).
 *
 * The container is left running on quit: speaches loads models lazily and
 * its restart policy is unless-stopped, so a later open is instant.
 */
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const CONTAINER = "learnharness-whisper";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Packaged apps (macOS Finder launches especially) don't get the shell's
 *  PATH — try Docker's usual install locations before the bare name.
 *  @param {string} [platform]
 *  @param {(p: string) => boolean} [exists]
 *  @returns {string} */
function dockerBinary(platform = process.platform, exists = fs.existsSync) {
	const candidates = platform === "win32"
		? ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"]
		: platform === "darwin"
			? ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]
			: ["/usr/bin/docker", "/usr/local/bin/docker"];
	return candidates.find((p) => exists(p)) ?? "docker";
}

function readJSON(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * The base URL to start for, or null when autostart doesn't apply.
 * @param {{ settingsFile: string, authFile: string, env?: Record<string, string | undefined> }} opts
 * @returns {string | null}
 */
function whisperTarget({ settingsFile, authFile, env = process.env }) {
	if (readJSON(settingsFile)?.dictation?.engine !== "whisper") return null;
	const raw = env.WHISPER_URL ?? readJSON(authFile)?.WHISPER_URL;
	if (typeof raw !== "string" || !raw.trim()) return null;
	try {
		const url = new URL(raw.trim());
		if (!LOOPBACK.has(url.hostname)) return null;
		return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
	} catch {
		return null;
	}
}

function run(bin, args, timeoutMs) {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			resolve({ ok: !error, out: String(stderr || stdout || error?.message || "").trim() });
		});
	});
}

async function answering(base, fetchImpl = fetch) {
	try {
		await fetchImpl(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) });
		return true;
	} catch {
		return false;
	}
}

/**
 * Returns the outcome (for logs/tests): "skipped" | "running" | "started" |
 * "no-docker" | "no-container".
 * @param {{
 *   settingsFile: string, authFile: string, log: (line: string) => void,
 *   env?: Record<string, string | undefined>,
 *   exec?: (bin: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean, out: string }>,
 *   fetchImpl?: typeof fetch, docker?: string,
 * }} opts
 * @returns {Promise<"skipped" | "running" | "started" | "no-docker" | "no-container">}
 */
async function ensureWhisper({ settingsFile, authFile, log, env, exec = run, fetchImpl, docker = dockerBinary() }) {
	const base = whisperTarget({ settingsFile, authFile, env });
	if (!base) return "skipped";
	if (await answering(base, fetchImpl)) {
		log(`whisper: already up at ${base}`);
		return "running";
	}
	if (!(await exec(docker, ["info", "--format", "{{.ServerVersion}}"], 15_000)).ok) {
		log("whisper: Docker engine not running — starting Docker Desktop");
		const desktop = await exec(docker, ["desktop", "start", "--timeout", "120"], 150_000);
		if (!desktop.ok) {
			log(`whisper: could not start Docker Desktop (${desktop.out.slice(0, 200)}) — start it manually`);
			return "no-docker";
		}
	}
	const started = await exec(docker, ["start", CONTAINER], 60_000);
	if (!started.ok) {
		log(`whisper: \`docker start ${CONTAINER}\` failed (${started.out.slice(0, 200)}) — run \`docker compose up -d\` once in docker/whisper/`);
		return "no-container";
	}
	log(`whisper: started ${CONTAINER} (${base})`);
	return "started";
}

module.exports = { ensureWhisper, whisperTarget, dockerBinary, CONTAINER };
