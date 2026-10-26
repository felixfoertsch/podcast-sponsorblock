import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Stable } from '../src/stable.js';
import { Credential } from '../src/credential.js';
import { EpisodeResolver } from '../src/identity.js';
import { reconciler } from '../src/scheduler.js';

test('scheduler discovers new downloaded RSS episode without browser request', async () => {
	const store = new Store(':memory:'); let added = false;
	const transport: typeof fetch = async input => {
		const path = new URL(input.toString()).pathname;
		if (path === '/login') return Response.json({ user: { accessToken: 'service' } });
		if (path === '/api/libraries') return Response.json({ libraries: [{ id: 'lib', mediaType: 'podcast' }] });
		if (path === '/api/libraries/lib/items') return Response.json({ total: 1, results: [{ id: 'abs-item' }] });
		return Response.json({ media: { feedURL: 'https://feed.example/rss', episodes: [{ id: 'old', guid: 'old-rss', audioFile: { ino: 1, metadata: { size: 10, mtimeMs: 1 } } }, ...(added ? [{ id: 'new', guid: 'new-rss', audioFile: { ino: 2, metadata: { size: 20, mtimeMs: 2 } } }] : [])] } });
	};
	const stable = new Stable('http://audiobookshelf:80', transport);
	const resolver = new EpisodeResolver(async () => Buffer.from('<rss><channel><podcast:guid>portable-show</podcast:guid></channel></rss>'));
	try {
		store.observeResolved('abs-item', await resolver.resolve(await stable.item('abs-item', 'service')));
		store.setEnabled('abs-item', true);
		const reconcile = reconciler(stable, new Credential(stable.base, 'service', 'password', transport), resolver);
		await reconcile(store, new AbortController().signal);
		assert.deepEqual(store.jobs('abs-item').map(j => j.episodeId), ['old']);
		added = true;
		await reconcile(store, new AbortController().signal);
		assert.equal(store.jobs('abs-item').find(j => j.episodeId === 'new')?.status, 'queued');
		assert.equal(store.resolution('abs-item', 'new')?.episodeKey, '["portable-show","new-rss"]');
		store.setEnabled('abs-item', false);
		store.setEnabled('abs-item', true);
		await reconcile(store, new AbortController().signal);
		assert.equal(store.jobs('abs-item').find(j => j.episodeId === 'old')?.status, 'queued');
	} finally { await store.close(); }
});
