import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Stable } from '../src/stable.js';
import { Credential } from '../src/credential.js';
import { EpisodeResolver } from '../src/identity.js';
import { reconciler } from '../src/scheduler.js';

test('scheduler admits enabled shows fairly and preserves pagination', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'psb-scheduler-'));
	const path = join(dir, 'db');
	const transport = async (url: string | URL | Request) => {
		const parsed = new URL(url.toString());
		if (parsed.pathname === '/login') return Response.json({ user: { accessToken: 'service' } });
		if (parsed.pathname === '/api/libraries') return Response.json({ libraries: [{ id: 'podcasts', mediaType: 'podcast' }] });
		if (parsed.pathname === '/api/libraries/podcasts/items') {
			const page = Number(parsed.searchParams.get('page'));
			const ids = page === 0 ? Array.from({ length: 20 }, (_, i) => `show-${i}`) : ['show-20'];
			return Response.json({ total: 21, results: ids.map(id => ({ id })) });
		}
		const id = parsed.pathname.split('/').at(-1) ?? '';
		return Response.json({ id, media: { feedURL: 'https://feed.example/rss', episodes: [{ id: 'episode' }] } });
	};
	const stable = new Stable('https://stable.example', transport);
	const credential = new Credential(stable.base, 'user', 'pass', transport);
	const resolver = { resolve: async (item: { id: string }) => ({ showKey: item.id, episodes: [{ id: 'episode', episodeKey: `${item.id}-episode`, identity: 'file' }] }) } as EpisodeResolver;
	let store: Store | undefined;
	try {
		store = new Store(path);
		for (let i = 0; i <= 20; i++) store.observeResolved(`show-${i}`, { showKey: `show-${i}`, episodes: [{ id: 'episode', episodeKey: `show-${i}-episode`, identity: 'file' }] });
		for (let i = 0; i <= 20; i++) store.setEnabled(`show-${i}`, true);
		const reconcile = reconciler(stable, credential, resolver);
		await reconcile(store, new AbortController().signal);
		assert.equal(store.jobs('show-0').length, 1);
		assert.equal(store.jobs('show-20').length, 0);
		assert.equal(store.schedulerPage('podcasts'), 1);
		await reconcile(store, new AbortController().signal);
		assert.equal(store.jobs('show-20').length, 1);
		assert.equal(store.schedulerPage('podcasts'), 0);
	} finally { if (store) await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('shared content serves another item without analysis job', () => {
	const store = new Store(':memory:');
	try {
		const sha = 'b'.repeat(64);
		for (const [itemId, showKey] of [['first', 'first-show'], ['shared', 'shared-show']]) {
			store.observeResolved(itemId, { showKey, episodes: [{ id: 'episode', episodeKey: itemId, identity: 'same-file' }] });
			store.setEnabled(itemId, true);
		}
		store.cacheHash('first', 'episode', 'same-file', sha);
		store.setContent(sha, { status: 'no_difference', segments: [] });
		store.cacheHash('shared', 'episode', 'same-file', sha);
		assert.equal(store.analysis('shared').episode?.status, 'no_difference');
		assert.equal(store.jobs('shared').filter(job => job.analysisRuns > 0).length, 0);
	} finally { store.close(); }
});
