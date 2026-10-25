import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { Stable } from '../src/stable.js';
import { Store } from '../src/store.js';

for (const [origin, status] of [
	['https://podcast.foertsch.family', 200],
	['https://foreign.example', 403],
	['https://podcast.foertsch.family.foreign.example', 403],
	['http://podcast.foertsch.family', 403],
	['http://localhost', 200],
	[undefined, 200],
] as const) {
	test(`write origin ${origin ?? '(missing)'} returns ${status}`, async () => {
		const store = new Store(':memory:');
		const stable = new Stable('http://audiobookshelf:80', async () => Response.json({ id: 'admin', type: 'admin', isActive: true, permissions: {} }));
		const app = createApp(stable, store, undefined, undefined, ['https://podcast.foertsch.family']);
		app.post('/api/origin-check', c => c.json({ ok: true }));
		const token = `e.${Buffer.from('{"type":"access"}').toString('base64url')}.s`;
		try {
			const response = await app.request('/api/origin-check', { method: 'POST', headers: {
				Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
				'X-Forwarded-Host': 'foreign.example', 'X-Forwarded-Proto': 'https',
				...(origin ? { Origin: origin } : {}),
			}, body: '{}' });
			assert.equal(response.status, status);
			assert.deepEqual(await response.json(), status === 200 ? { ok: true } : { error: 'origin_denied' });
		} finally { await store.close(); }
	});
}
