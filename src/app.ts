import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Stable, HttpError, permitsAdminWrite, type User } from './stable.js';
import type { Store } from './store.js';
export type AuthEnv = { Variables: { token: string; user: User } };
export function createApp(stable: Stable, store: Store, corpus?: { inventory(itemId: string, episodeId: string): unknown }, verifySource?: (itemId: string, episodeId: string) => Promise<string>) {
	const app = new Hono<AuthEnv>();
	const writes = new Map<string, { start: number; count: number }>();
	app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.message : 'internal_error' }, error instanceof HttpError ? error.status as 401 : 500));
	app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff'); await next(); });
	app.get('/healthz', c => c.json({ status: 'ok' }));
	app.use('/api/*', bodyLimit({ maxSize: 64 * 1024 }));
	app.use('/api/*', async (c, next) => {
		const match = /^Bearer ([^\s]+)$/i.exec(c.req.header('Authorization') ?? '');
		if (!match || match[1].length > 8192) return c.json({ error: 'unauthorized' }, 401);
		const write = !['GET', 'HEAD'].includes(c.req.method);
		const user = await stable.validate(match[1], write);
		c.set('token', match[1]); c.set('user', user);
		if (write) {
			const key = user.id;
			const now = Date.now();
			let bucket = writes.get(key);
			if (!bucket || now - bucket.start >= 60000) { bucket = { start: now, count: 0 }; writes.set(key, bucket); }
			if (++bucket.count > 60) return c.json({ error: 'rate_limited' }, 429);
			if (writes.size > 1000) writes.delete(writes.keys().next().value!);
			if (!permitsAdminWrite(match[1], user)) return c.json({ error: 'forbidden' }, 403);
			if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
			const origin = c.req.header('Origin');
			if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'origin_denied' }, 403);
		}
		await next();
	});
	app.get('/api/items/:itemId/analysis', async c => {
		await stable.item(c.req.param('itemId'), c.get('token'));
		const itemId = c.req.param('itemId');
		const episodes = store.analysis(itemId);
		if (verifySource) {
			for (const [episodeId, result] of Object.entries(episodes)) {
				if (!result.adAnalysisEnabled || !result.sourceSha256) continue;
				try {
					const hash = await verifySource(itemId, episodeId);
					store.verifySource(itemId, episodeId, hash);
				} catch { store.invalidateSource(itemId, episodeId, 'unavailable'); }
			}
		}
		const response = store.analysis(itemId);
		return c.json({ episodes: response });
	});
	app.get('/api/items/:itemId/analysis/status', async c => {
		await stable.item(c.req.param('itemId'), c.get('token'));
		return c.json({ jobs: store.jobs(c.req.param('itemId')) });
	});
	app.get('/api/podcasts/:itemId/ad-analysis', async c => {
		await stable.item(c.req.param('itemId'), c.get('token'));
		return c.json({ enabled: store.enabled(c.req.param('itemId')) });
	});
	app.post('/api/podcasts/:itemId/ad-analysis', async c => {
		await stable.item(c.req.param('itemId'), c.get('token'));
		const body = z.object({ enabled: z.boolean() }).strict().safeParse(await c.req.json());
		if (!body.success) return c.json({ error: 'invalid_body' }, 400);
		store.setEnabled(c.req.param('itemId'), body.data.enabled);
		return c.json(body.data);
	});
	app.post('/api/podcasts/:itemId/episode/:episodeId/ad-analysis', async c => {
		const item = await stable.item(c.req.param('itemId'), c.get('token'));
		const media = z.object({ episodes: z.array(z.object({ id: z.string() })) }).safeParse(item.media);
		if (!media.success || !media.data.episodes.some(e => e.id === c.req.param('episodeId'))) return c.json({ error: 'episode_not_found' }, 404);
		if (!z.object({}).strict().safeParse(await c.req.json()).success) return c.json({ error: 'invalid_body' }, 400);
		if (!store.enabled(c.req.param('itemId'))) return c.json({ queued: false }, 409);
		try { store.enqueue(c.req.param('itemId'), c.req.param('episodeId')); return c.json({ queued: true }, 202); }
		catch { return c.json({ queued: false }, 409); }
	});
	app.get('/api/podcasts/:itemId/episode/:episodeId/ad-analysis/corpus', async c => {
		if (!permitsAdminWrite(c.get('token'), await stable.validate(c.get('token'), true))) return c.json({ error: 'forbidden' }, 403);
		await stable.item(c.req.param('itemId'), c.get('token'));
		if (!corpus) return c.json({ collectionPaused: true, reason: 'corpus_unavailable' }, 503);
		return c.json(corpus.inventory(c.req.param('itemId'), c.req.param('episodeId')));
	});
	return app;
}
