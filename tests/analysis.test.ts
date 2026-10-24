import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeEpisode, type AnalysisClient, type Result } from "../src/analysis";

test("analysis adapter publishes only after authorized source and consent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "psb-analysis-"));
	try {
		const path = join(dir, "source.mp3");
		await writeFile(path, "bounded audio fixture");
		let published = false;
		const client: AnalysisClient = {
			getAuthorizedSource: async () => ({ path, duration: 60, identity: "fixture" }),
			isEnabled: async () => true,
			publish: async (_job, sha, result) => {
				assert.match(sha, /^[a-f0-9]{64}$/);
				assert.equal(result.status, "no_difference");
				published = true;
			},
		};
		const result: Result = { status: "no_difference", segments: [] };
		assert.equal(await analyzeEpisode(client, async () => result, { itemId: "i", episodeId: "e", fileId: "f" }, new AbortController().signal), result);
		assert.equal(published, true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
