import axios from "axios";
import ssrfFilter from "ssrf-req-filter";
import analysisProxy from "../vendor/adAnalysisProxy.js";

export const MAX_FEED_BYTES = 16 * 1024 * 1024;
export type CatalogItem = { title: string; author?: string; itunesId?: string };
export type EpisodeLike = { guid?: string; title?: string; publishedAt?: string; enclosure: { url: string } };
export type Candidate = { url: string; title: string; author?: string };

export function catalogEndpoint(provider: "apple" | "gpodder", media: CatalogItem): string {
	if (provider === "apple" && media.itunesId && /^[1-9][0-9]{0,19}$/.test(media.itunesId)) return `https://itunes.apple.com/lookup?id=${media.itunesId}&entity=podcast`;
	const query = encodeURIComponent(`${media.title} ${media.author || ""}`.trim());
	return provider === "apple" ? `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=5&term=${query}` : `https://gpodder.net/search.json?q=${query}`;
}

export function catalogResults(provider: "apple" | "gpodder", payload: unknown): Candidate[] {
	const rows: unknown = provider === "apple" ? (payload as { results?: unknown })?.results : payload;
	if (!Array.isArray(rows) || rows.length > (provider === "gpodder" ? 20 : 5)) throw new Error("malformed_catalog");
	return rows.slice(0, 5).map((row: unknown) => {
		if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("malformed_catalog");
		const r = row as Record<string, unknown>;
		const url = provider === "apple" ? r.feedUrl : r.url;
		const title = provider === "apple" ? r.collectionName : r.title;
		const author = provider === "apple" ? r.artistName : r.author;
		if (typeof url !== "string" || typeof title !== "string" || (author != null && typeof author !== "string")) throw new Error("malformed_catalog");
		return { url, title, ...(typeof author === "string" ? { author } : {}) };
	});
}

export async function request(url: string, limit = 2 * 1024 * 1024, timeout = 10_000, signal = new AbortController().signal): Promise<{ data: Buffer; url: string }> {
	const configured = analysisProxy.configuration();
	const deadline = Date.now() + timeout;
	for (let redirects = 0; redirects <= 4; redirects++) {
		if (signal.aborted) throw new Error("cancelled");
		const parsed = new URL(url);
		if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("unsafe_url");
		const agents = configured ? await analysisProxy.agents(parsed, configured, signal) : { httpAgent: ssrfFilter(parsed.href), httpsAgent: ssrfFilter(parsed.href) };
		let response;
		try {
			response = await axios.get(parsed.href, { signal, proxy: false, maxRedirects: 0, timeout: Math.max(1, deadline - Date.now()), responseType: "arraybuffer", maxContentLength: limit, maxBodyLength: limit, validateStatus: () => true, ...agents, headers: { "User-Agent": "audiobookshelf", "Accept-Encoding": "identity" } });
		} catch (e) {
			const error = e as { code?: string; message?: string };
			if (signal.aborted || error.code === "ECONNABORTED") throw new Error("request_timeout");
			if (error.message?.includes("maxContentLength")) throw new Error("response_too_large");
			throw new Error(configured ? "proxy_failed_or_blocked" : "request_failed_or_blocked");
		} finally { agents.httpAgent.destroy(); agents.httpsAgent.destroy(); }
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			if (!response.headers.location || redirects === 4) throw new Error("redirect_limit");
			url = new URL(response.headers.location, parsed).href;
			continue;
		}
		if (response.status < 200 || response.status >= 300) throw new Error("http_error");
		const data = Buffer.from(response.data);
		if (data.length > limit) throw new Error("response_too_large");
		return { data, url: parsed.href };
	}
	throw new Error("redirect_limit");
}

export const transport = {
	get: request,
	async candidates(provider: "apple" | "gpodder", item: CatalogItem, signal: AbortSignal) {
		const { data } = await request(catalogEndpoint(provider, item), 2 * 1024 * 1024, 10_000, signal);
		return JSON.parse(data.toString("utf8")) as unknown;
	},
	async fetchFeed(url: string, signal: AbortSignal): Promise<EpisodeLike[]> {
		const { data } = await request(url, MAX_FEED_BYTES, 10_000, signal);
		const xml = data.toString("utf8");
		const episodes: EpisodeLike[] = [];
		for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
			const body = match[1];
			const enclosure = body.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*>/i)?.[1];
			if (!enclosure) continue;
			const guid = body.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i)?.[1]?.trim();
			const title = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
			const publishedAt = body.match(/<(?:pubDate|published)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published)>/i)?.[1]?.trim();
			episodes.push({ guid, title, publishedAt, enclosure: { url: new URL(enclosure, url).href } });
		}
		return episodes;
	},
};
