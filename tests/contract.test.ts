import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stable } from '../src/stable.js';
import { Store } from '../src/store.js';
import { AnalysisCorpus } from '../src/corpus.js';
import { createApp } from '../src/app.js';
import { createFeedRoutes } from '../src/feed-routes.js';
import { analysisSchema, consentSchema, enqueueRequestSchema, enqueueSchema, jobStatusSchema, corpusSchema, summarySchema, recentFeedSchema } from '../contract/api.js';
import fixtures from '../contract/fixtures.json';

test('contract fixtures parse as API schemas', () => {
	assert.equal(analysisSchema.parse(fixtures.analysis).episodes['episode-id'].status, 'stale');
	assert.deepEqual(consentSchema.parse(fixtures.consent), { enabled: true });
	assert.deepEqual(enqueueRequestSchema.parse(fixtures.enqueueRequest), {});
	assert.equal(enqueueSchema.parse(fixtures.enqueue).queued, true);
	assert.equal(summarySchema.parse(fixtures.summary).source, 'feed');
	assert.equal(recentFeedSchema.parse(fixtures.recent).limit, 50);
	assert.equal(corpusSchema.parse(fixtures.corpus).version, 2);
	assert.deepEqual(jobStatusSchema.parse(fixtures.status).jobs, []);
});

test('runtime route responses parse against contract schemas', async () => {
	const user = { id: 'admin', type: 'admin' as const, isActive: true, permissions: {} };
	const access = `x.${Buffer.from(JSON.stringify({ type: 'access' })).toString('base64url')}.x`;
	const stable = new Stable('https://stable.example', async (input) => {
		const url = new URL(input.toString());
		if (url.pathname === '/api/me') return Response.json(user);
		if (url.pathname === '/api/items/item') return Response.json({ media: { episodes: [{ id: 'episode' }] } });
		if (url.pathname === '/api/libraries/lib') return Response.json({ id: 'lib' });
		if (url.pathname === '/api/libraries/lib/items') return Response.json({ results: [] });
		throw new Error(`unexpected stable route ${url.pathname}`);
	});
	const store = new Store(':memory:');
	store.setEnabled('item', true);
	store.enqueue('item', 'episode');
	const corpus = new AnalysisCorpus(':memory:');
	const app = createApp(stable, store, corpus);
	const feed = createFeedRoutes(stable);
	const headers = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };
	try {
		const call = async (url: string, init?: RequestInit) => app.request(url, { ...init, headers: { ...headers, ...init?.headers } });
		analysisSchema.parse(await (await call('/api/items/item/analysis')).json());
		jobStatusSchema.parse(await (await call('/api/items/item/analysis/status')).json());
		consentSchema.parse(await (await call('/api/podcasts/item/ad-analysis')).json());
		const queued = await call('/api/podcasts/item/episode/episode/ad-analysis', { method: 'POST', body: '{}' });
		assert.equal(queued.status, 202);
		enqueueSchema.parse(await queued.json());
		corpusSchema.parse(await (await call('/api/podcasts/item/episode/episode/ad-analysis/corpus')).json());
		const summaryStable = new Stable('https://stable.example', async input => {
			const url = new URL(input.toString());
			if (url.pathname === '/api/me') return Response.json({ ...user, mediaProgress: [] });
			if (url.pathname === '/api/items/item') return Response.json({ media: { episodes: [{ id: 'episode', title: 'Episode', enclosureURL: 'https://cdn.example/episode.mp3' }] } });
			throw new Error(`unexpected summary route ${url.pathname}`);
		});
		const summaryFeed = createFeedRoutes(summaryStable);
		const summary = await summaryFeed.request('/api/podcasts/item/episode-summary', { headers: { Authorization: `Bearer ${access}` } });
		summarySchema.parse(await summary.json());
		const recent = await feed.request('/api/libraries/lib/recent-episodes', { headers: { Authorization: `Bearer ${access}` } });
		recentFeedSchema.parse(await recent.json());
	} finally { corpus.close(); store.close(); }
});
