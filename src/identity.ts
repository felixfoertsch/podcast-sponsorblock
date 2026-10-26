import { parseStringPromise } from "xml2js";
import { fileIdentity } from "./store";
import { MAX_FEED_BYTES, request } from "./analyzerTransport";

const TRACKING = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid)$/i;
function safeUrl(value: string): URL {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("unsafe_url");
	url.protocol = url.protocol.toLowerCase();
	url.hostname = url.hostname.toLowerCase();
	return url;
}
export function normalizeFeedUrl(value: string): string {
	const url = safeUrl(value);
	url.hash = "";
	for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
	url.searchParams.sort();
	return url.href;
}
export function normalizeEnclosureUrl(value: string): string {
	const url = safeUrl(value);
	url.search = "";
	url.hash = "";
	return url.href;
}
export function showKey(feedUrl: string, podcastGuid?: unknown): string {
	const guid = typeof podcastGuid === "string" ? podcastGuid.trim() : "";
	return guid || normalizeFeedUrl(feedUrl);
}
export function episodeKey(key: string, guid?: unknown, enclosureUrl?: string): string {
	const rssGuid = typeof guid === "string" ? guid.trim() : "";
	const identity = rssGuid || (enclosureUrl ? normalizeEnclosureUrl(enclosureUrl) : "");
	if (!identity) throw new Error("episode_identity_missing");
	return JSON.stringify([key, identity]);
}

type FeedRow = { guid: string | null; title: string; publishedAt: number | null; enclosure: string };
type FeedData = { guid: string | null; rows: FeedRow[] };
type FetchFeed = (url: string, signal: AbortSignal, maxBytes: number) => Promise<Buffer>;
const scalar = (value: unknown): string => Array.isArray(value) ? scalar(value[0]) : typeof value === "string" ? value : value && typeof value === "object" ? scalar((value as Record<string, unknown>)._ ) : "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function defaultFetch(url: string): Promise<Buffer> {
	return (await request(url, MAX_FEED_BYTES, 10_000)).data;
}

export class EpisodeResolver {
	private cache = new Map<string, { expires: number; data: FeedData }>();
	constructor(private readonly fetchFeed: FetchFeed = async url => defaultFetch(url)) {}
	private async feed(url: string): Promise<FeedData> {
		const normalized = normalizeFeedUrl(url);
		const existing = this.cache.get(normalized);
		if (existing && existing.expires > Date.now()) return existing.data;
		const xml = (await this.fetchFeed(normalized, AbortSignal.timeout(10_000), MAX_FEED_BYTES)).toString("utf8");
		if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error("response_too_large");
		if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("unsafe_xml");
		const parsed = record(await parseStringPromise(xml, { explicitArray: true, strict: true, explicitRoot: true, trim: true }));
		const channel = record(record(parsed.rss).channel instanceof Array ? (record(parsed.rss).channel as unknown[])[0] : record(parsed.rss).channel);
		const rows: FeedRow[] = (Array.isArray(channel.item) ? channel.item : []).map(value => {
			const row = record(value), enclosure = record(Array.isArray(row.enclosure) ? row.enclosure[0] : row.enclosure);
			const attrs = record(enclosure.$);
			const date = Date.parse(scalar(row.pubDate));
			let url = '';
			try { if (typeof attrs.url === 'string') url = normalizeEnclosureUrl(new URL(attrs.url, normalized).href); } catch { /* Invalid RSS row cannot poison remaining episodes. */ }
			return { guid: scalar(row.guid).trim() || null, title: scalar(row.title).trim(), publishedAt: Number.isFinite(date) ? date : null, enclosure: url };
		}).filter(row => row.enclosure);
		const guid = scalar(channel["podcast:guid"] ?? channel["{https://podcastindex.org/namespace/1.0}guid"]).trim() || null;
		const data = { guid, rows };
		this.cache.delete(normalized);
		this.cache.set(normalized, { expires: Date.now() + 600_000, data });
		while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
		return data;
	}
	async resolve(item: unknown): Promise<{ showKey: string; episodes: Array<{ id: string; episodeKey: string; identity: string | null }> }> {
		const media = record(record(item).media);
		const metadata = record(media.metadata);
		const feedUrl = typeof media.feedURL === "string" ? media.feedURL : typeof metadata.feedUrl === "string" ? metadata.feedUrl : "";
		if (!feedUrl) throw new Error("feed_url_missing");
		const feed = await this.feed(feedUrl);
		const show = showKey(feedUrl, feed.guid);
		const episodes = (Array.isArray(media.episodes) ? media.episodes : []).flatMap(value => {
			const ep = record(value), id = typeof ep.id === "string" ? ep.id : "";
			const enclosure = typeof ep.enclosureURL === "string" ? ep.enclosureURL : typeof record(ep.enclosure).url === "string" ? record(ep.enclosure).url as string : "";
			let normalized = '';
			try { normalized = enclosure ? normalizeEnclosureUrl(enclosure) : ''; } catch { return []; }
			let matches = normalized ? feed.rows.filter(row => row.enclosure === normalized) : [];
			if (matches.length !== 1) {
				const title = typeof ep.title === "string" ? ep.title : "";
				const date = typeof ep.publishedAt === "number" ? ep.publishedAt : null;
				const normalizedTitle = title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
				matches = normalizedTitle && date !== null ? feed.rows.filter(row => row.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === normalizedTitle && row.publishedAt === date) : [];
			}
			const guid = matches.length === 1 && matches[0].guid ? matches[0].guid : typeof ep.guid === "string" && ep.guid.trim() ? ep.guid : undefined;
			try { const key = episodeKey(show, guid, matches.length === 1 ? matches[0].enclosure : enclosure); return id ? [{ id, episodeKey: key, identity: fileIdentity(value) }] : []; }
			catch { return []; }
		});
		return { showKey: show, episodes };
	}
}
