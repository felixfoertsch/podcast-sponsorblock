import { z } from 'zod';
export const segmentSchema = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).passthrough().refine(s => s.end > s.start);
export const episodeAnalysisSchema = z.object({ status: z.string(), version: z.string().nullable(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), segments: z.array(segmentSchema), adAnalysisEnabled: z.boolean() }).passthrough();
export const analysisSchema = z.object({ episodes: z.record(z.string(), episodeAnalysisSchema) });
export const consentSchema = z.object({ enabled: z.boolean() }).strict();
export const enqueueRequestSchema = z.object({}).strict();
export const enqueueSchema = z.object({ queued: z.boolean() });
export const summarySchema = z.object({ total: z.number().int().nonnegative(), unplayed: z.number().int().nonnegative(), source: z.enum(['feed','downloaded']) });
export const recentFeedSchema = z.object({ episodes: z.array(z.record(z.string(),z.unknown())), limit: z.number().int().min(1).max(200), page: z.number().int().nonnegative(), feedUnavailable:z.boolean(), feedTruncated:z.boolean() }).passthrough();
export const corpusSchema = z.object({ version:z.literal(2),count:z.number().int().nonnegative(),totalBytes:z.number().int().nonnegative(),limitBytes:z.number().int().positive(),collectionPaused:z.boolean(),reason:z.string().nullable(),versions:z.array(z.record(z.string(),z.unknown())) });
export const jobStatusSchema = z.object({ jobs:z.array(z.object({id:z.number().int(),itemId:z.string(),episodeId:z.string(),status:z.string(),attempts:z.number().int().nonnegative()}).passthrough()) });
export const paths = {
	analysis:'/api/items/:itemId/analysis', status:'/api/items/:itemId/analysis/status',
	consent:'/api/podcasts/:itemId/ad-analysis', enqueue:'/api/podcasts/:itemId/episode/:episodeId/ad-analysis',
	corpus:'/api/podcasts/:itemId/episode/:episodeId/ad-analysis/corpus',
	summary:'/api/podcasts/:itemId/episode-summary', recent:'/api/libraries/:id/recent-episodes?includeFeed=1', debug:'/api/debug',
} as const;
