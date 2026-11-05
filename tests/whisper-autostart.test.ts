import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { CONTAINER, dockerBinary, ensureWhisper, whisperTarget } from "../electron/whisper-autostart.cjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-whisper-autostart-"));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function files(engine: string | undefined, whisperUrl: string | undefined) {
	const dir = fs.mkdtempSync(path.join(TMP, "case-"));
	const settingsFile = path.join(dir, "settings.json");
	const authFile = path.join(dir, "auth.json");
	if (engine) fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, dictation: { engine } }));
	if (whisperUrl) fs.writeFileSync(authFile, JSON.stringify({ WHISPER_URL: whisperUrl }));
	return { settingsFile, authFile };
}

describe("whisperTarget", () => {
	it("applies only to the whisper engine with a loopback URL", () => {
		assert.equal(whisperTarget({ ...files("whisper", "http://localhost:8000/v1/"), env: {} }), "http://localhost:8000");
		assert.equal(whisperTarget({ ...files("whisper", "http://127.0.0.1:9000"), env: {} }), "http://127.0.0.1:9000");
		assert.equal(whisperTarget({ ...files("deepgram", "http://localhost:8000"), env: {} }), null, "Deepgram users never start Docker");
		assert.equal(whisperTarget({ ...files(undefined, "http://localhost:8000"), env: {} }), null, "no settings = default engine");
		assert.equal(whisperTarget({ ...files("whisper", "http://gpu-box.lan:8000"), env: {} }), null, "a remote server isn't ours to start");
		assert.equal(whisperTarget({ ...files("whisper", undefined), env: {} }), null);
		assert.equal(whisperTarget({ ...files("whisper", "not a url"), env: {} }), null);
	});

	it("real env wins over auth.json (the server's own precedence)", () => {
		const f = files("whisper", "http://gpu-box.lan:8000");
		assert.equal(whisperTarget({ ...f, env: { WHISPER_URL: "http://localhost:8001" } }), "http://localhost:8001");
	});
});

describe("ensureWhisper", () => {
	const down = async () => { throw new TypeError("fetch failed"); };
	const scripted = (results: Record<string, boolean>) => {
		const calls: string[] = [];
		return {
			calls,
			exec: async (_bin: string, args: string[]) => {
				const key = args.slice(0, 2).join(" ");
				calls.push(key);
				return { ok: results[key] ?? false, out: results[key] ? "" : `${key} failed` };
			},
		};
	};
	const base = (extra: object) => ({ ...files("whisper", "http://localhost:8000"), env: {}, log: () => {}, docker: "docker", ...extra });

	it("skips entirely (no docker calls) when autostart doesn't apply", async () => {
		const s = scripted({});
		assert.equal(await ensureWhisper({ ...base({ exec: s.exec }), ...files("deepgram", "http://localhost:8000") }), "skipped");
		assert.deepEqual(s.calls, []);
	});

	it("does nothing when the server already answers", async () => {
		const s = scripted({});
		assert.equal(await ensureWhisper(base({ exec: s.exec, fetchImpl: async () => new Response("") })), "running");
		assert.deepEqual(s.calls, []);
	});

	it("starts the existing container when the daemon is up", async () => {
		const s = scripted({ "info --format": true, [`start ${CONTAINER}`]: true });
		assert.equal(await ensureWhisper(base({ exec: s.exec, fetchImpl: down })), "started");
		assert.deepEqual(s.calls, ["info --format", `start ${CONTAINER}`]);
	});

	it("launches Docker Desktop first when the daemon is down", async () => {
		const s = scripted({ "desktop start": true, [`start ${CONTAINER}`]: true });
		assert.equal(await ensureWhisper(base({ exec: s.exec, fetchImpl: down })), "started");
		assert.deepEqual(s.calls, ["info --format", "desktop start", `start ${CONTAINER}`]);
	});

	it("reports, never throws, when Docker or the container is missing", async () => {
		const lines: string[] = [];
		assert.equal(await ensureWhisper(base({ exec: scripted({}).exec, fetchImpl: down, log: (l: string) => lines.push(l) })), "no-docker");
		assert.equal(await ensureWhisper(base({ exec: scripted({ "info --format": true }).exec, fetchImpl: down, log: (l: string) => lines.push(l) })), "no-container");
		assert.match(lines.at(-1)!, /docker compose up -d/);
	});
});

it("dockerBinary prefers a known install path, falling back to PATH", () => {
	assert.equal(dockerBinary("darwin", (p: string) => p === "/opt/homebrew/bin/docker"), "/opt/homebrew/bin/docker");
	assert.equal(dockerBinary("win32", () => true), "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe");
	assert.equal(dockerBinary("linux", () => false), "docker");
});
