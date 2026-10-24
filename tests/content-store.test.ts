import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const sha = 'a'.repeat(64);
const resolved = (id: string, identity: string) => ({ showKey: 'show-guid', episodes: [{ id, episodeKey: '["show-guid","rss-guid"]', identity }] });
test('identical audio reuses portable result with zero second analysis runs', async () => {
	const store = new Store(':memory:');
	try {
		store.observeResolved('abs-a', resolved('ep-a', 'file-a'));
		store.setEnabled('abs-a', true);
		store.enqueue('abs-a', 'ep-a');
		store.cacheHash('abs-a', 'ep-a', 'file-a', sha);
		store.setContent(sha, { status: 'candidates', segments: [{ start: 1, end: 2 }] });
		store.observeResolved('abs-b', resolved('ep-b', 'file-b'));
		store.enqueue('abs-b', 'ep-b');
		store.cacheHash('abs-b', 'ep-b', 'file-b', sha);
		assert.equal(store.analysis('abs-b')['ep-b'].applicable, true);
		assert.deepEqual(store.content(sha), { detectorVersion: '1', status: 'candidates', segments: [{ start: 1, end: 2 }] });
		assert.equal(store.jobs('abs-b')[0].analysisRuns, 0);
		store.observeResolved('abs-b', resolved('ep-b', 'changed-file'));
		assert.equal(store.analysis('abs-b')['ep-b'], undefined);
		store.cacheHash('abs-b', 'ep-b', 'changed-file', sha);
		assert.equal(store.analysis('abs-b')['ep-b'].applicable, true);
		store.setEnabled('abs-b', false);
		assert.equal(store.enabled('abs-a'), false);
		assert.equal(store.analysis('abs-a')['ep-a'].applicable, false);
	} finally { await store.close(); }
});
