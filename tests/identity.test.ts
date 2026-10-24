import assert from "node:assert/strict";
import test from "node:test";
import { episodeKey, normalizeEnclosureUrl, normalizeFeedUrl, showKey } from "../src/identity";

test("canonicalizes feed and enclosure URLs without losing semantic feed queries", () => {
	assert.equal(normalizeFeedUrl("HTTP://EXAMPLE.COM/Feed?z=2&utm_source=x&a=1#top"), "http://example.com/Feed?a=1&z=2");
	assert.equal(normalizeEnclosureUrl("HTTPS://EXAMPLE.COM/Ep.MP3?token=secret#part"), "https://example.com/Ep.MP3");
	assert.throws(() => normalizeFeedUrl("https://user:pass@example.com/feed"));
	assert.throws(() => normalizeEnclosureUrl("file:///episode.mp3"));
});

test("builds collision-safe stable keys and requires an episode identity", () => {
	assert.equal(showKey("https://example.com/feed", " pod-1 "), "pod-1");
	assert.equal(episodeKey("pod-1", " ep-1 "), '["pod-1","ep-1"]');
	assert.equal(episodeKey("pod-1", undefined, "https://EXAMPLE.com/a.mp3?x=1"), '["pod-1","https://example.com/a.mp3"]');
	assert.throws(() => episodeKey("pod-1"));
});

test("resolves changed ABS episode IDs against parsed RSS GUID and preserves keys", async () => {
	const { EpisodeResolver } = await import("../src/identity");
	const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><podcast:guid>show-guid</podcast:guid><item><guid>rss-guid</guid><title>Episode title</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><enclosure url="https://cdn.example/ep.mp3?signature=one" type="audio/mpeg"/></item></channel></rss>`;
	const resolver = new EpisodeResolver(async () => Buffer.from(xml));
	const item = (id: string, guid: string | null) => ({ media: { feedURL: "https://EXAMPLE.com/feed?utm_campaign=x", episodes: [{ id, guid, title: "Episode title", publishedAt: Date.parse("2024-01-01T00:00:00Z"), enclosureURL: "https://cdn.example/ep.mp3?different=two", audioFile: { ino: 3, metadata: { size: 10, mtimeMs: 1 } } }] } });
	const first = await resolver.resolve(item("abs-1", null));
	const second = await resolver.resolve(item("abs-2", "abs-local-guid"));
	assert.equal(first.showKey, "show-guid");
	assert.equal(first.episodes[0].episodeKey, second.episodes[0].episodeKey);
	assert.equal(first.episodes[0].id, "abs-1");
	assert.equal(first.episodes[0].identity, '["3",10,1]');
});

test("uses normalized enclosure fallback when RSS GUID absent", async () => {
	const { EpisodeResolver } = await import("../src/identity");
	const resolver = new EpisodeResolver(async () => Buffer.from("<rss><channel><item><title>Loose</title><enclosure url='https://cdn.example/a.mp3'/></item></channel></rss>"));
	const result = await resolver.resolve({ media: { feedURL: "https://example.com/feed", episodes: [{ id: "ep", title: "Loose", enclosureURL: "https://cdn.example/a.mp3?download=1" }] } });
	assert.equal(result.episodes[0].episodeKey, '["https://example.com/feed","https://cdn.example/a.mp3"]');
});
