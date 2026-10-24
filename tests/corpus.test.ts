import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisCorpus } from "../src/corpus";

test("SQLite corpus refuses entry beyond five versions and reports exact inventory shape", async () => {
	const dir = await mkdtemp(join(tmpdir(), "psb-corpus-"));
	const corpus = new AnalysisCorpus(join(dir, "corpus.sqlite"), 10 * 1024 * 1024 * 1024);
	try {
		const input = (n: number) => ({ itemId: "item", episodeId: "episode", data: Buffer.from(`audio-${n}`), fingerprint: Array.from({ length: 500 }, (_, i) => i + n * 1000), duration: 60, provider: "apple" as const, route: "direct" as const });
		for (let i = 0; i < 5; i++) assert.equal(corpus.retain(input(i)).status, "retained");
		assert.deepEqual(corpus.retain(input(5)), { status: "paused", reason: "episode_limit" });
		const inventory = corpus.inventory("item", "episode");
		assert.deepEqual(Object.keys(inventory).sort(), ["collectionPaused", "count", "limitBytes", "reason", "totalBytes", "version", "versions"].sort());
		assert.equal(inventory.version, 2);
		assert.equal(inventory.count, 5);
		assert.equal(inventory.collectionPaused, true);
		const loaded = corpus.load("item", "episode");
		assert.equal(loaded.versions[0].frameBytes > 0, true);
	} finally { corpus.close(); await rm(dir, { recursive: true, force: true }); }
});
