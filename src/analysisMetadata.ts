import { z } from 'zod';

const itemSchema = z.object({
	media: z.object({
		metadata: z.object({
			title: z.string(),
			author: z.string().optional(),
			itunesId: z.union([z.string(), z.number()]).nullish(),
		}),
	}),
});
const episodeSchema = z.object({
	title: z.string(),
	guid: z.string().nullish(),
	pubDate: z.string().nullish(),
	enclosure: z.object({ url: z.string() }),
});

export function parseAnalysisMetadata(item: unknown, episode: unknown) {
	const parsedItem = itemSchema.parse(item).media.metadata;
	const parsedEpisode = episodeSchema.parse(episode);
	return {
		item: { ...parsedItem, itunesId: parsedItem.itunesId?.toString() },
		episode: { ...parsedEpisode, guid: parsedEpisode.guid ?? undefined, pubDate: parsedEpisode.pubDate ?? undefined },
	};
}
