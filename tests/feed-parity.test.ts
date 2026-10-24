import assert from 'node:assert/strict';
import fixture from './fixtures/feed-parity.json';
import test from 'node:test';
import { createRecentFeedService, type FeedItem, type FeedSource } from '../src/feeds.js';


test('recent feed output matches fork-derived response fields', async () => {
	const podcast = { id: 'podcast-1' };
	const source: FeedSource = { libraryItemId: 'item-1', podcastId: 'podcast-1', feedURL: 'https://feed.example/rss', podcast };
	const downloaded = fixture.recent.downloaded as FeedItem[];
	const recent = createRecentFeedService({ fetch: async () => ({ episodes: fixture.recent.feeds.map((episode: { guid: string; title: string; url: string; publishedAt: number; durationSeconds: number }) => ({ guid: episode.guid, title: episode.title, enclosure: { url: episode.url }, publishedAt: episode.publishedAt, durationSeconds: episode.durationSeconds })) }) });
	const response = await recent('token', 'library-1', { limit: fixture.recent.limit, page: fixture.recent.page }, {
		getAccessiblePodcasts: async () => [source],
		getDownloadedEpisodes: async () => downloaded,
		canAccessItem: () => true,
	}, new AbortController().signal);
	assert.deepEqual(response.episodes.map((episode) => episode.id), fixture.recent.expected);
	assert.deepEqual({ limit: response.limit, page: response.page, feedUnavailable: response.feedUnavailable, feedTruncated: response.feedTruncated }, { limit: fixture.recent.limit, page: fixture.recent.page, feedUnavailable: fixture.recent.feedUnavailable, feedTruncated: fixture.recent.feedTruncated });
	assert.deepEqual(response.episodes[1], { id: 'feed:item-1:guid-2', podcastId: 'podcast-1', title: 'Feed newest', enclosure: { url: 'https://media.example/two.mp3' }, enclosureURL: 'https://media.example/two.mp3', guid: 'guid-2', publishedAt: 200, duration: 120, libraryItemId: 'item-1', downloaded: false, podcast });
});


