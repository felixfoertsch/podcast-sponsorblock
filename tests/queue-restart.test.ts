import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { startQueue } from '../src/queue.js';

test('restart retries interrupted running job once, then worker drains successfully', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'psb-restart-'));
	const path = join(dir, 'db');
	let store: Store | undefined;
	try {
		store = new Store(path);
		store.observeResolved('item', { showKey: 'show', episodes: [{ id: 'episode', episodeKey: 'episode', identity: 'file' }] });
		store.setEnabled('item', true);
		store.enqueue('item', 'episode');
		await store.close(); store = undefined;
		let db = new Database(path);
		db.prepare("UPDATE jobs SET status='running',attempts=1").run(); db.close();
		store = new Store(path);
		assert.equal(store.jobs('item')[0].status, 'queued');
		let processed = 0;
		const pump = startQueue(store, async () => { processed++; });
		const deadline = Date.now() + 2000;
		while (store.jobs('item')[0].status !== 'complete' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(processed, 1);
		assert.equal(store.jobs('item')[0].status, 'complete');
		store.stop(); await pump; await store.close(); store = undefined;
		db = new Database(path);
		db.prepare("UPDATE jobs SET status='running',attempts=2").run(); db.close();
		store = new Store(path);
		assert.equal(store.jobs('item')[0].status, 'interrupted');
	} finally {
		if (store) await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
