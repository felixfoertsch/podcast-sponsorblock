import assert from "node:assert/strict";
import test from "node:test";
import { catalogEndpoint, catalogResults, parseFeed } from "../src/analyzerTransport";

test("RSS XML entities decode before episode matching and enclosure requests", async () => {
	const episodes = await parseFeed('<rss><channel><item><title>Migration Motors &amp; Music</title><guid>g&amp;1</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><enclosure url="https://cdn.example/a?x=1&amp;y=2"/></item></channel></rss>', 'https://feed.example/rss');
	assert.equal(episodes[0].title, 'Migration Motors & Music');
	assert.equal(episodes[0].guid, 'g&1');
	assert.equal(episodes[0].enclosure.url, 'https://cdn.example/a?x=1&y=2');
});

test("gpodder default search result list is accepted and capped to five candidates", () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Podcast ${i}` }));
	assert.deepEqual(catalogResults("gpodder", rows).map(({ title }) => title), ["Podcast 0", "Podcast 1", "Podcast 2", "Podcast 3", "Podcast 4"]);
	assert.match(catalogEndpoint("gpodder", { title: "Planet Money" }), /^https:\/\/gpodder\.net\/search\.json\?q=/);
});

test("gpodder catalog rejects oversized and malformed consumed responses", () => {
	assert.throws(() => catalogResults("gpodder", Array.from({ length: 21 }, () => ({ url: "https://example.com", title: "Podcast" }))), /malformed_catalog/);
	const invalid = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Podcast ${i}` }));
	invalid[4] = { url: "https://example.com/4", title: null as unknown as string };
	assert.throws(() => catalogResults("gpodder", invalid), /malformed_catalog/);
});
