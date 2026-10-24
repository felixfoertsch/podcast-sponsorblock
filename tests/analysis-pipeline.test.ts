import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeCandidates } from "../src/analyzer";
import type { CandidateTransport } from "../src/analyzer";
import { AnalysisCorpus } from "../src/corpus";

test("pipeline refuses to proceed when pinned native fingerprint binary is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "psb-pipeline-"));
	try {
		const source = join(dir, "source.mp3");
		await writeFile(source, "audio placeholder");
		let calls = 0;
		const transport: CandidateTransport = {
			get: async () => { throw new Error("unexpected audio fetch"); },
			fetchFeed: async () => [],
			candidates: async () => { calls++; return []; },
		};
		const corpus = new AnalysisCorpus(join(dir, "corpus.sqlite"));
		const result = await analyzeCandidates({
			sourcePath: source,
			duration: 60,
			episode: { title: "Episode", publishedAt: "2026-01-01", enclosure: { url: "https://example.com/audio.mp3" } },
			item: { title: "Show" },
			itemId: "i", episodeId: "e", corpus,
			transport,
			signal: new AbortController().signal,
			env: { FPCALC_PATH: "/nonexistent" },
		});
		assert.equal(result.status, "failed");
		assert.match(result.reason || "", /ENOENT/);
		assert.equal(calls, 0);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
