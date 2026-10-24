import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { parseStringPromise } from 'xml2js';
import { z } from 'zod';
import { request } from './analyzerTransport.js';
import { createRecentFeedService, type FeedItem, type FeedSource } from './feeds.js';
import { Stable } from './stable.js';
import { normalizeEnclosureUrl } from './identity.js';
import type { AuthEnv } from './app.js';
const mediaSchema = z.object({ feedURL: z.string().nullable().optional(), episodes: z.array(z.object({ id: z.string(), title: z.string(), guid: z.string().nullable().optional(), enclosureURL: z.string().optional(), enclosure: z.object({ url: z.string().optional() }).passthrough().nullable().optional(), publishedAt: z.number().nullable().optional(), duration: z.number().optional() }).passthrough()).default([]), metadata: z.record(z.string(), z.unknown()).optional() }).passthrough();
const record = z.record(z.string(), z.unknown());
function feedUrl(media: ReturnType<typeof mediaSchema.parse>): string | null { const value = media.metadata?.feedUrl ?? media.feedURL; return typeof value === 'string' ? value : null; }
function scalar(value: unknown): string { if (Array.isArray(value)) return scalar(value[0]); if (typeof value === 'string') return value; if (value && typeof value === 'object') return scalar((value as Record<string, unknown>)._); return ''; }
export function createFeedRoutes(stable: Stable, feedTransport = { async fetch(url: string, signal: AbortSignal, maxBytes: number) {
	const { data } = await request(url, maxBytes, 10000, signal);
	const xml = data.toString('utf8');
	if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('unsafe_xml');
	const parsed: unknown = await parseStringPromise(xml, { explicitArray: true, strict: true });
	const root = record.parse(parsed); const rss = record.parse(root.rss); const channel = record.parse((rss.channel as unknown[])[0]);
	const rows = Array.isArray(channel.item) ? channel.item : [];
	const channelGuid = scalar(channel['podcast:guid'] ?? channel['{https://podcastindex.org/namespace/1.0}guid']) || null;
	return { showGuid: channelGuid, episodes: rows.map(row => {
		const ep = record.parse(row); const enc = Array.isArray(ep.enclosure) ? record.parse(ep.enclosure[0]) : {}; const attrs = enc.$ ? record.parse(enc.$) : {};
		const date = Date.parse(scalar(ep.pubDate));
		return { title: scalar(ep.title), guid: scalar(ep.guid) || null, enclosure: { url: scalar(attrs.url) }, publishedAt: Number.isFinite(date) ? date : null, durationSeconds: 0 };
	}) };
} }) {
	const app = new Hono<AuthEnv>();
	const recent = createRecentFeedService(feedTransport);
	app.get('/api/podcasts/:itemId/episode-summary', async c => {
		const item = await stable.item(c.req.param('itemId'), c.get('token')); const media = mediaSchema.parse(item.media);
		const me = record.parse(await stable.request('/api/me', c.get('token')));
		const progress = z.array(z.object({ episodeId: z.string().nullable().optional(), mediaItemId: z.string().optional(), isFinished: z.boolean() }).passthrough()).parse(me.mediaProgress ?? me.mediaProgresses ?? []);
		const finished = new Set(progress.filter(p => p.isFinished).map(p => p.episodeId ?? p.mediaItemId));
		const url = feedUrl(media);
		if (url) {
			try {
				const feed = await feedTransport.fetch(url, AbortSignal.timeout(10000), 16 * 1024 * 1024);
				let unplayed = 0;
				for (const ep of feed.episodes) { const downloaded = media.episodes.find(d => (ep.guid && d.guid === ep.guid) || (d.enclosure?.url ?? d.enclosureURL) === ep.enclosure.url); if (!downloaded || !finished.has(downloaded.id)) unplayed++; }
				return c.json({ total: feed.episodes.length, unplayed, source: 'feed' });
			} catch { /* Fork-compatible downloaded fallback. */ }
		}
		return c.json({ total: media.episodes.length, unplayed: media.episodes.filter(e => !finished.has(e.id)).length, source: 'downloaded' });
	});
	app.get('/api/libraries/:id/recent-episodes', async c => {
		const token = c.get('token'), libraryId = c.req.param('id');
		const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), page: z.coerce.number().int().nonnegative().default(0) }).safeParse(c.req.query());
		if (!query.success) return c.json({ error: 'invalid_pagination' }, 400);
		await stable.request(`/api/libraries/${encodeURIComponent(libraryId)}`, token);
		const items = new Map<string, ReturnType<typeof mediaSchema.parse>>();
		const result = await recent(token, libraryId, query.data, {
			getAccessiblePodcasts: async (_token, limit) => {
				const response = z.object({ results: z.array(z.object({ id: z.string(), mediaType: z.string().optional() })) }).parse(await stable.request(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${limit}&page=0`, token));
				const sources: FeedSource[] = [];
				for (const row of response.results) {
					if (row.mediaType && row.mediaType !== 'podcast') continue;
					try { const item = await stable.item(row.id, token); const media = mediaSchema.parse(item.media); items.set(row.id, media); sources.push({ libraryItemId: row.id, podcastId: row.id, feedURL: feedUrl(media), podcast: media, showGuid: null }); } catch { /* No access, no disclosure. */ }
				}
				return sources;
			},
			canAccessItem: (_token, id) => items.has(id),
			getDownloadedEpisodes: async (_token, ids) => ids.flatMap(id => (items.get(id)?.episodes ?? []).map(ep => ({ ...ep, podcastId: id, libraryItemId: id, guid: ep.guid ?? null, enclosure: { url: ep.enclosure?.url ?? ep.enclosureURL ?? '' }, enclosureURL: ep.enclosure?.url ?? ep.enclosureURL ?? '', publishedAt: ep.publishedAt ?? null, duration: ep.duration ?? 0, downloaded: true, podcast: items.get(id) }) as FeedItem)),
		}, AbortSignal.timeout(30000));
		// Browser route IDs remain library-scoped; episode identity stays RSS-natural.
		for (const ep of result.episodes) if (!ep.downloaded) ep.id = `feed:${ep.libraryItemId}:${createHash('sha256').update(String(ep.id)).digest('hex')}`;
		return c.json(result);
	});
	return app;
}
