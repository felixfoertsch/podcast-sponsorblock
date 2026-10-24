import { serve } from '@hono/node-server';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { env } from './env.js';
import { Stable } from './stable.js';
import { Credential } from './credential.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { downloadSource } from './source.js';
import { analyzeCandidates } from './analyzer.js';
import { AnalysisCorpus } from './corpus.js';
import { transport } from './analyzerTransport.js';
import { reconciler } from './scheduler.js';
import { createFeedRoutes } from './feed-routes.js';
import { createDebugRoutes } from './debug-server.js';

async function main() {
	await mkdir(env.PSB_DATA_DIR, { recursive: true, mode: 0o700 });
	const stable = new Stable(env.PSB_STABLE_URL);
	const credential = new Credential(env.PSB_STABLE_URL, env.PSB_STABLE_USERNAME, env.PSB_STABLE_PASSWORD);
	const store = new Store(join(env.PSB_DATA_DIR, 'sidecar.sqlite'), { serverId: env.PSB_STABLE_URL, scheduler: reconciler(stable, credential) });
	const corpus = new AnalysisCorpus(join(env.PSB_DATA_DIR, 'sidecar.sqlite'));
	const app = createApp(stable, store, corpus);
	app.route('/', createFeedRoutes(stable));
	const debug = createDebugRoutes(stable, env.PSB_DATA_DIR);
	app.route('/api/debug', debug);
	await store.start(async (job, signal) => {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(20 * 60 * 1000)]);
		if (!store.enabled(job.itemId)) throw new Error('consent_required');
		const source = await downloadSource(stable, credential, job.itemId, job.episodeId, bounded);
		try {
			const item = z.object({ media: z.object({ metadata: z.object({ title: z.string(), author: z.string().optional(), itunesId: z.union([z.string(), z.number()]).optional() }) }) }).parse(source.item);
			const ep = z.object({ title: z.string(), guid: z.string().optional(), pubDate: z.string().optional(), enclosure: z.object({ url: z.string() }) }).parse(source.episode);
			const result = await analyzeCandidates({ sourcePath: source.path, duration: source.duration, itemId: job.itemId, episodeId: job.episodeId, corpus, item: { ...item.media.metadata, itunesId: item.media.metadata.itunesId?.toString() }, episode: { ...ep, publishedAt: ep.pubDate }, transport, signal: bounded });
			if (bounded.aborted || !store.enabled(job.itemId)) throw new Error('cancelled');
			// Re-download stable bytes before publication; metadata/ETag cannot prove timeline.
			const current = await downloadSource(stable, credential, job.itemId, job.episodeId, bounded);
			try { if (current.sha256 !== source.sha256) throw new Error('source_changed'); } finally { await current.cleanup(); }
			store.setResult(job.itemId, job.episodeId, { status: result.status, sourceSha256: source.sha256, version: '1', segments: result.segments, adAnalysisEnabled: true, applicable: ['candidates', 'no_difference'].includes(result.status) });
		} finally { await source.cleanup(); }
	});
	if (env.PSB_SCHEDULER_ENABLED === '1') store.startScheduler();
	const server = serve({ fetch: app.fetch, port: env.PORT });
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { store.stop(); server.close(() => { debug.close(); corpus.close(); store.close(); process.exit(0); }); });
}
void main().catch(() => { console.error('startup_failed'); process.exitCode = 1; });
