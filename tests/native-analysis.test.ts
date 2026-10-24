import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fingerprint } from "../src/analyzer";

const run = promisify(execFile);
test("fpcalc/ffmpeg fingerprint path accepts bounded local audio", { timeout: 240_000 }, async (t) => {
	const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
	const fpcalc = process.env.FPCALC_PATH || "/opt/homebrew/bin/fpcalc";
	try { await run(ffmpeg, ["-version"]); await run(fpcalc, ["-version"]); }
	catch { t.skip("native ffmpeg/fpcalc not installed"); return; }
	const dir = await mkdtemp(join(tmpdir(), "psb-native-"));
	try {
		const audio = join(dir, "tone.wav");
		await run(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-c:a", "libmp3lame", audio]);
		const fp = await fingerprint(audio, dir, "smoke", 60, new AbortController().signal, { FFMPEG_PATH: ffmpeg, FPCALC_PATH: fpcalc });
		assert.ok(fp.length >= 400);
		assert.ok(fp.duration && fp.duration >= 59 && fp.duration <= 61);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
