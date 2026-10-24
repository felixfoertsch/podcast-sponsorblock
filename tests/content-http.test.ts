import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Stable } from '../src/stable.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

test('content read requires stable authentication and validates hash', async () => {
	const store = new Store(':memory:');
	const stable = new Stable('http://audiobookshelf:80', async () => Response.json({ id: 'user', type: 'user', isActive: true, permissions: {} }));
	const app = createApp(stable, store);
	const sha = 'a'.repeat(64);
	try {
		store.setContent(sha, { status: 'no_difference', segments: [] });
		assert.equal((await app.request(`/api/content/${sha}`)).status, 401);
		const headers = { Authorization: 'Bearer validated-by-stable' };
		assert.equal((await app.request('/api/content/invalid', { headers })).status, 400);
		assert.deepEqual(await (await app.request(`/api/content/${sha}`, { headers })).json(), { detectorVersion: '1', status: 'no_difference', segments: [] });
		assert.throws(() => new Stable('http://external.example'), /invalid_stable_base/);
		assert.throws(() => new Stable('http://audiobookshelf:8080'), /invalid_stable_base/);
	} finally { await store.close(); }
});
