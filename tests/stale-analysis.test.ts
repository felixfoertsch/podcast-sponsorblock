import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('disabled show hides cached content while enabled show can use shared content', () => {
	const store = new Store(':memory:');
	try {
		const sha = 'a'.repeat(64);
		store.observeResolved('first', { showKey: 'show-a', episodes: [{ id: 'episode', episodeKey: 'one', identity: 'file' }] });
		store.observeResolved('second', { showKey: 'show-b', episodes: [{ id: 'episode', episodeKey: 'two', identity: 'file' }] });
		store.cacheHash('first', 'episode', 'file', sha);
		store.setContent(sha, { status: 'candidates', segments: [{ start: 2, end: 3 }] });
		store.setEnabled('first', true);
		store.setEnabled('second', false);
		assert.deepEqual(store.analysis('first').episode?.segments, [{ start: 2, end: 3 }]);
		assert.equal(store.analysis('second').episode?.applicable, false);
		assert.deepEqual(store.analysis('second').episode?.segments, []);
	} finally { store.close(); }
});

test('changed resolution cancels prior job identity', () => {
	const store = new Store(':memory:');
	try {
		store.observeResolved('item', { showKey: 'show', episodes: [{ id: 'episode', episodeKey: 'old', identity: 'file-old' }] });
		store.setEnabled('item', true);
		store.enqueue('item', 'episode');
		store.observeResolved('item', { showKey: 'show', episodes: [{ id: 'episode', episodeKey: 'new', identity: 'file-new' }] });
		assert.deepEqual(store.jobs('item'), []);
		assert.throws(() => store.cacheHash('item', 'episode', 'file-old', 'a'.repeat(64)), /source_changed/);
	} finally { store.close(); }
});
