import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store";
import { startQueue } from "../src/queue";

function setup(): { dir: string; store: Store } {
	const dir = mkdtempSync(join(tmpdir(), "psb-queue-"));
	return { dir, store: new Store(join(dir, "db.sqlite"), { serverId: "server-a" }) };
}
const waitFor = async (predicate: () => boolean): Promise<void> => {
	for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.fail("timed out waiting for queue state");
};

test("consent gates idempotent enqueue and capacity counts queued plus running", () => {
	const { dir, store } = setup();
	try {
		assert.throws(() => store.enqueue("show", "ep"), /consent_required/);
		store.setEnabled("show", true);
		const first = store.enqueue("show", "ep");
		assert.equal(store.enqueue("show", "ep").id, first.id);
		for (let i = 0; i < 31; i++) store.enqueue("show", `ep${i}`);
		assert.throws(() => store.enqueue("show", "overflow"), /queue_full/);
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("worker executes aliased job and disable cancels active work", async () => {
	const { dir, store } = setup();
	try {
		store.setEnabled("show", true); store.enqueue("show", "ep");
		let seen = "";
		startQueue(store, async (job, signal) => { seen = `${job.itemId}/${job.episodeId}`; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); });
		await waitFor(() => seen !== "");
		assert.equal(seen, "show/ep"); store.setEnabled("show", false);
		await waitFor(() => store.jobs("show")[0]?.status === "cancelled");
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("results are server-scoped and stale results expose no segments", () => {
	const { dir, store } = setup();
	try {
		store.setEnabled("show", true);
		store.setResult("show", "ep", { status: "complete", sourceSha256: "old", version: "v1", segments: [{ start: 1, end: 2 }], adAnalysisEnabled: true, applicable: true });
		store.invalidateSource("show", "ep", "new");
		assert.deepEqual(store.analysis("show").ep?.segments, []);
		assert.throws(() => store.setResult("show", "bad", { status: "complete", sourceSha256: "x", version: "v1", segments: [{ start: 2, end: 3 }, { start: 1, end: 2 }], adAnalysisEnabled: true, applicable: true }), /invalid_segments/);
		const other = new Store(join(dir, "db.sqlite"), { serverId: "server-b" });
		assert.deepEqual(other.analysis("show"), {}); other.close();
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
