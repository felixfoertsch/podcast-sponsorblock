import assert from "node:assert/strict";
import { createRecentFeedService } from "../src/feeds";

async function main() {
	{
		let fetches = 0;
		const recent = createRecentFeedService({ async fetch() { fetches++; return { episodes: [{ guid: "g", title: "new", enclosure: { url: "https://pod.test/a" }, publishedAt: 3 }, { guid: "old", title: "downloaded", enclosure: { url: "https://pod.test/b" }, publishedAt: 2 }] }; } });
		const result = await recent("token", "lib", { limit: 1, page: 0 }, {
			async getAccessiblePodcasts() { return [{ libraryItemId: "item", podcastId: "p", feedURL: "https://pod.test/rss", podcast: {} }]; },
			async getDownloadedEpisodes() { return [{ id: "d", libraryItemId: "item", podcastId: "p", title: "old", enclosure: { url: "https://pod.test/b" }, enclosureURL: "https://pod.test/b", guid: "old", publishedAt: 2, duration: 1, downloaded: true, podcast: {} }]; },
			canAccessItem() { return true; },
		}, new AbortController().signal);
		assert.equal(result.episodes.length, 1);
		assert.equal(result.episodes[0]?.guid, "g");
		assert.equal(fetches, 1);
	}
}
void main();
