import assert from "node:assert/strict";
import test from "node:test";
import { catalogEndpoint, catalogResults } from "../src/analyzerTransport";

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
