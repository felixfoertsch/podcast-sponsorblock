import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';

test('two byte-identical audio fixtures hash once each; second job has zero analysis runs', async () => {
	const store = new Store(':memory:');
	const bytes = Buffer.from('byte-identical audio fixture');
	let hashes = 0;
	for (const id of ['first', 'second']) {
		store.observeResolved(id, { showKey: id, episodes: [{ id: 'episode', episodeKey: JSON.stringify([id, 'rss-guid']), identity: `file-${id}` }] });
		store.setEnabled(id, true);
		store.enqueue(id, 'episode');
	}
	try {
		void store.start(async job => {
			let sha = store.cachedHash(job.itemId, job.episodeId);
			if (!sha) {
				sha = createHash('sha256').update(bytes).digest('hex'); hashes++;
				store.cacheHash(job.itemId, job.episodeId, `file-${job.itemId}`, sha);
			}
			if (store.content(sha)) return;
			store.markAnalysis(job.id);
			store.setContent(sha, { status: 'candidates', segments: [{ start: 1, end: 2 }] });
		});
		const deadline = Date.now() + 2000;
		while (store.jobs('second')[0].status !== 'complete' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(store.jobs('first')[0].analysisRuns, 1);
		assert.equal(store.jobs('second')[0].analysisRuns, 0);
		assert.equal(store.jobs('second')[0].status, 'complete');
		assert.equal(hashes, 2);
		assert.deepEqual(store.analysis('first').episode.segments, store.analysis('second').episode.segments);
	} finally { await store.close(); }
});
