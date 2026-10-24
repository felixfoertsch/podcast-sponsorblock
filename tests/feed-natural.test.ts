import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecentFeedService, type FeedItem } from '../src/feeds.js';

test('feed identity survives ABS IDs and signed enclosure query changes; null ABS guid deduplicates', async () => {
	const recent = createRecentFeedService({ fetch: async () => ({ showGuid: 'portable-show', episodes: [{ guid: 'rss-guid', title: 'Episode', enclosure: { url: 'https://cdn.example/episode.mp3?signature=first' } }] }) });
	const call = (itemId: string, downloaded: boolean) => recent('token', 'library', {}, {
		getAccessiblePodcasts: async () => [{ libraryItemId: itemId, podcastId: itemId, feedURL: 'https://feed.example/rss', podcast: {} }],
		getDownloadedEpisodes: async () => downloaded ? [{ id: 'changed-abs-episode', libraryItemId: itemId, podcastId: itemId, title: 'Episode', guid: null, enclosure: { url: 'https://cdn.example/episode.mp3?signature=second' }, enclosureURL: 'https://cdn.example/episode.mp3?signature=second', publishedAt: null, duration: 60, downloaded: true, podcast: {} } as FeedItem] : [],
		canAccessItem: () => true,
	}, new AbortController().signal);
	const first = await call('abs-first', false);
	const second = await call('abs-second', false);
	assert.equal(first.episodes[0].id, second.episodes[0].id);
	assert.equal(first.episodes[0].episodeKey, '["portable-show","rss-guid"]');
	const downloaded = await call('abs-third', true);
	assert.equal(downloaded.episodes.length, 1);
	assert.equal(downloaded.episodes[0].downloaded, true);
	assert.equal(downloaded.episodes[0].episodeKey, first.episodes[0].episodeKey);
});
