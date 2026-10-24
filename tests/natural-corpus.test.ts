import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnalysisCorpus } from "../src/corpus";

test("corpus stores natural show and episode keys and persists deduplication", async () => {
	const dir = await mkdtemp(join(tmpdir(), "psb-natural-corpus-"));
	const path = join(dir, "corpus.sqlite");
	const showKey = `urn:podcast:show:${"s".repeat(16_000)}`;
	const episodeKey = `https://example.test/episode/${"e".repeat(16_000)}`;
	const input = { showKey, episodeKey, data: Buffer.from("audio"), fingerprint: [1, 2, 3], duration: 60, provider: "apple" as const, route: "direct" as const };
	const corpus = new AnalysisCorpus(path);
	let closed = false;
	try {
		const retained = corpus.retain(input);
		assert.equal(retained.status, "retained");
		assert.equal(corpus.inventory(showKey, episodeKey).count, 1);
		corpus.close();
		closed = true;

		const db = new Database(path, { readonly: true });
		const columns = db.prepare("PRAGMA table_info(analysis_corpus_versions)").all() as Array<{ name: string }>;
		assert.deepEqual(columns.filter(({ name }) => ["item_id", "episode_id", "server_id"].includes(name)), []);
		db.close();

		const reopened = new AnalysisCorpus(path);
		try {
			assert.deepEqual(reopened.retain(input), { ...retained, status: "duplicate" });
			assert.equal(reopened.load(showKey, episodeKey).versions[0].showKey, showKey);
		} finally { reopened.close(); }
	} finally {
		if (!closed) corpus.close();
		await rm(dir, { recursive: true, force: true });
	}
});
