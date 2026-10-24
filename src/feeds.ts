import { z } from "zod";
import { episodeKey, showKey, normalizeEnclosureUrl } from "./identity.js";

export const episodeSchema = z.object({
	id: z.string(), podcastId: z.string(), title: z.string(), enclosure: z.unknown().nullable(),
	enclosureURL: z.string().url(), guid: z.string().nullable(), publishedAt: z.number().nullable(),
	duration: z.number().nonnegative(), libraryItemId: z.string(), downloaded: z.boolean(), podcast: z.unknown(),
}).passthrough();
export const recentFeedSchema = z.object({
	episodes: z.array(episodeSchema), limit: z.number().int().positive(), page: z.number().int().nonnegative(),
	feedUnavailable: z.boolean(), feedTruncated: z.boolean(),
});
export type FeedEpisode = z.infer<typeof episodeSchema>;
export type FeedItem = Omit<FeedEpisode, "enclosure" | "publishedAt"> & { enclosure: { url?: string } | null; publishedAt: number | null; guid?: string | null };
export type FeedSource = { libraryItemId: string; podcastId: string; feedURL: string | null; podcast: unknown; showGuid?: string | null };
export interface FeedTransport { fetch(url: string, signal: AbortSignal, maxBytes: number): Promise<unknown> }
export interface FeedCallbacks {
	getAccessiblePodcasts(token: string, limit: number): Promise<FeedSource[]>;
	getDownloadedEpisodes(token: string, itemIds: string[]): Promise<FeedItem[]>;
	canAccessItem(token: string, itemId: string): boolean;
}

const MAX_FEEDS = 100;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CACHE = 100;
const SUCCESS_TTL = 30 * 60_000;
const FAILURE_TTL = 60_000;
type CacheEntry = { promise: Promise<unknown | null>; expires: number };

export function createRecentFeedService(transport: FeedTransport, now = Date.now) {
	const cache = new Map<string, CacheEntry>();
	async function getFeed(url: string, signal: AbortSignal) {
		const hit = cache.get(url);
		if (hit && hit.expires > now()) return hit.promise;
		if (hit) cache.delete(url);
		const entry: CacheEntry = { expires: Infinity, promise: Promise.resolve(null) };
		entry.promise = transport.fetch(url, signal, MAX_BYTES).catch(() => null).then((feed) => {
			entry.expires = now() + (feed ? SUCCESS_TTL : FAILURE_TTL);
			return feed;
		});
		cache.set(url, entry);
		while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
		return entry.promise;
	}
	return async function recent(token: string, libraryId: string, query: { limit?: number; page?: number }, callbacks: FeedCallbacks, signal: AbortSignal) {
		const limit = query.limit ?? 50, page = query.page ?? 0;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(page) || page < 0 || page > Math.floor(Number.MAX_SAFE_INTEGER / limit)) throw new Error("invalid_limit_or_page");
		const all = await callbacks.getAccessiblePodcasts(token, MAX_FEEDS + 1);
		const truncated = all.length > MAX_FEEDS;
		const sources = all.slice(0, MAX_FEEDS).filter((x) => callbacks.canAccessItem(token, x.libraryItemId));
		const downloaded = await callbacks.getDownloadedEpisodes(token, sources.map((x) => x.libraryItemId));
		const naturalShows = new Map<string, string>();
		let unavailable = false;
		const extra: FeedItem[] = [];
		for (let i = 0; i < sources.length; i += 4) {
			const results = await Promise.all(sources.slice(i, i + 4).map(async (source) => {
				if (!source.feedURL) return null;
				try { return { source, feed: await getFeed(source.feedURL, signal) as { showGuid?: string | null; episodes?: Array<Record<string, unknown>> } | null }; } catch { return null; }
			}));
			for (const result of results) {
				if (!result?.feed?.episodes) { unavailable = true; continue; }
				const naturalShow = showKey(result.source.feedURL!, result.feed.showGuid ?? result.source.showGuid);
				naturalShows.set(result.source.libraryItemId, naturalShow);
				const local = downloaded.filter(ep => ep.libraryItemId === result.source.libraryItemId);
				const seen = new Set<string>();
				for (const ep of result.feed.episodes) {
					const enclosure = ep.enclosure as { url?: string } | undefined, guid = typeof ep.guid === "string" ? ep.guid : null;
					const url = enclosure?.url;
					if (!url || typeof ep.title !== "string") continue;
					const key = episodeKey(naturalShow, guid, url);
					const match = local.find(d => (guid && d.guid === guid) || normalizeEnclosureUrl(d.enclosure?.url || String(d.enclosureURL)) === normalizeEnclosureUrl(url));
					if (match) { match.episodeKey = key; continue; }
					if (seen.has(key)) continue;
					seen.add(key);
					extra.push({ id: `feed:${key}`, episodeKey: key, podcastId: result.source.podcastId, title: ep.title, enclosure: enclosure ?? null, enclosureURL: url, guid, publishedAt: typeof ep.publishedAt === "number" ? ep.publishedAt : null, duration: typeof ep.durationSeconds === "number" ? Math.max(0, ep.durationSeconds) : 0, libraryItemId: result.source.libraryItemId, downloaded: false, podcast: result.source.podcast });
				}
			}
		}
		const seen = new Set<string>();
		const merged = [...downloaded, ...extra].filter((ep) => { const source = sources.find((s) => s.libraryItemId === ep.libraryItemId); let key: string = typeof ep.episodeKey === 'string' ? ep.episodeKey : String(ep.id); try { if (source?.feedURL && typeof ep.episodeKey !== 'string') key = episodeKey(naturalShows.get(source.libraryItemId) ?? showKey(source.feedURL, source.showGuid), ep.guid, ep.enclosure?.url ?? String(ep.enclosureURL)); } catch { /* Keep malformed legacy row distinct. */ } if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
		return { episodes: merged.slice(page * limit, page * limit + limit), limit, page, feedUnavailable: unavailable, feedTruncated: truncated };
	};
}
