import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store";
import { startQueue } from "../src/queue";

function setup(): { dir: string; store: Store } {
	const dir = mkdtempSync(join(tmpdir(), "psb-queue-"));
	const store = new Store(join(dir, "db.sqlite"));
	store.observeResolved("item", { showKey: "show", episodes: [{ id: "ep", episodeKey: "episode", identity: "file-v1" }] });
	return { dir, store };
}
const waitFor = async (predicate: () => boolean): Promise<void> => {
	for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.fail("timed out waiting for queue state");
};

test("consent gates idempotent enqueue and capacity counts queued plus running", () => {
	const { dir, store } = setup();
	try {
		assert.throws(() => store.enqueue("show", "ep"), /consent_required/);
		store.setEnabled("item", true);
		const first = store.enqueue("item", "ep");
		assert.equal(store.enqueue("item", "ep").id, first.id);
		for (let i = 0; i < 31; i++) {
			const itemId = `item-${i}`;
			store.observeResolved(itemId, { showKey: "show", episodes: [{ id: "ep", episodeKey: `episode-${i}`, identity: `file-${i}` }] });
			store.enqueue(itemId, "ep");
		}
		store.observeResolved("overflow", { showKey: "show", episodes: [{ id: "ep", episodeKey: "overflow", identity: "file-overflow" }] });
		assert.throws(() => store.enqueue("overflow", "ep"), /queue_full/);
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("worker executes aliased job and disable cancels active work", async () => {
	const { dir, store } = setup();
	try {
		store.setEnabled("item", true); store.enqueue("item", "ep");
		let seen = "";
		startQueue(store, async (job, signal) => { seen = `${job.itemId}/${job.episodeId}`; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); });
		await waitFor(() => seen !== "");
		assert.equal(seen, "item/ep"); store.setEnabled("item", false);
		await waitFor(() => store.jobs("item")[0]?.status === "cancelled");
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("analysis reuses hash and content cache across opted-in items", () => {
	const { dir, store } = setup();
	try {
		const sha = "a".repeat(64);
		store.setEnabled("item", true);
		store.cacheHash("item", "ep", "file-v1", sha);
		store.setContent(sha, { status: "candidates", segments: [{ start: 1, end: 2 }] });
		assert.equal(store.cachedHash("item", "ep"), sha);
		assert.deepEqual(store.analysis("item").ep?.segments, [{ start: 1, end: 2 }]);
		store.observeResolved("shared-item", { showKey: "show", episodes: [{ id: "shared-ep", episodeKey: "shared", identity: "file-v1" }] });
		store.setEnabled("shared-item", true);
		assert.equal(store.cachedHash("shared-item", "shared-ep"), sha);
		assert.deepEqual(store.analysis("shared-item")["shared-ep"]?.segments, [{ start: 1, end: 2 }]);
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
