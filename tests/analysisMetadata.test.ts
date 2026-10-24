import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAnalysisMetadata } from '../src/analysisMetadata.js';

test('accepts stock Audiobookshelf null optional metadata', () => {
	const result = parseAnalysisMetadata(
		{ media: { metadata: { title: 'Podcast', itunesId: null } } },
		{ title: 'Episode', guid: null, pubDate: null, enclosure: { url: 'https://example.test/audio.mp3' } },
	);
	assert.deepEqual(result.item, { title: 'Podcast', itunesId: undefined });
	assert.deepEqual(result.episode, { title: 'Episode', guid: undefined, pubDate: undefined });
});

test('accepts missing enclosure and rejects nonnull invalid optional metadata', () => {
	const item = { media: { metadata: { title: 'Podcast', itunesId: false } } };
	const episode = { title: 'Episode', guid: 42, enclosure: { url: 'https://example.test/audio.mp3' } };
	assert.throws(() => parseAnalysisMetadata(item, { ...episode, guid: undefined }));
	assert.throws(() => parseAnalysisMetadata({ media: { metadata: { title: 'Podcast', itunesId: null } } }, episode));
	assert.deepEqual(parseAnalysisMetadata({ media: { metadata: { title: 'Podcast', itunesId: null } } }, { title: 'Episode', guid: null, enclosure: null }).episode, { title: 'Episode', guid: undefined, pubDate: undefined });
});
