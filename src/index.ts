import { serve } from '@hono/node-server';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAnalysisMetadata } from './analysisMetadata.js';
import { env } from './env.js';
import { Stable } from './stable.js';
import { Credential } from './credential.js';
import { Store, fileIdentity } from './store.js';
import { createApp } from './app.js';
import { downloadSource } from './source.js';
import { analyzeCandidates } from './analyzer.js';
import { AnalysisCorpus } from './corpus.js';
import { transport } from './analyzerTransport.js';
import { reconciler } from './scheduler.js';
import { createFeedRoutes } from './feed-routes.js';
import { createDebugRoutes } from './debug-server.js';
import { EpisodeResolver } from './identity.js';

async function main() {
	await mkdir(env.PSB_DATA_DIR, { recursive: true, mode: 0o700 });
	const stable = new Stable(env.PSB_STABLE_URL);
	const credential = new Credential(env.PSB_STABLE_URL, env.PSB_STABLE_USERNAME, env.PSB_STABLE_PASSWORD);
	const resolver = new EpisodeResolver();
	const store = new Store(join(env.PSB_DATA_DIR, 'sidecar.sqlite'), { scheduler: reconciler(stable, credential, resolver) });
	const corpus = new AnalysisCorpus(join(env.PSB_DATA_DIR, 'sidecar.sqlite'));
	const app = createApp(stable, store, corpus, resolver);
	app.route('/', createFeedRoutes(stable));
	const debug = createDebugRoutes(stable, env.PSB_DATA_DIR);
	app.route('/api/debug', debug);
	void store.start(async (job, signal) => {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(20 * 60 * 1000)]);
		if (!store.enabled(job.itemId)) throw new Error('consent_required');
		const item = await stable.item(job.itemId, await credential.get());
		store.observeResolved(job.itemId, await resolver.resolve(item));
		if (bounded.aborted || !store.enabled(job.itemId)) throw new Error('cancelled');
		const cached = store.cachedHash(job.itemId, job.episodeId);
		if (cached && store.content(cached)) return;
		const source = await downloadSource(stable, credential, job.itemId, job.episodeId, bounded);
		try {
			const identity = fileIdentity(source.episode);
			if (!identity) throw new Error('source_identity_unavailable');
			store.cacheHash(job.itemId, job.episodeId, identity, source.sha256);
			if (store.content(source.sha256)) return;
			const resolved = store.resolution(job.itemId, job.episodeId);
			if (!resolved) throw new Error('episode_resolution_required');
			store.markAnalysis(job.id);
			const metadata = parseAnalysisMetadata(source.item, source.episode);
			const result = await analyzeCandidates({ sourcePath: source.path, sourceSha256: source.sha256, duration: source.duration, itemId: resolved.showKey, episodeId: resolved.episodeKey, corpus, ...metadata, episode: { ...metadata.episode, publishedAt: metadata.episode.pubDate }, transport, signal: bounded });
			if (bounded.aborted || !store.enabled(job.itemId)) throw new Error('cancelled');
			// Result describes downloaded bytes; only unchanged file identity may expose it locally.
			const current = await stable.item(job.itemId, await credential.get());
			store.observeResolved(job.itemId, await resolver.resolve(current));
			if (store.resolution(job.itemId, job.episodeId)?.identity !== identity) throw new Error('source_changed');
			if (bounded.aborted || !store.enabled(job.itemId)) throw new Error('cancelled');
			store.setContent(source.sha256, { status: ['candidates', 'no_difference'].includes(result.status) ? result.status : `failed:${result.reason ?? result.status}`, segments: result.segments.map(({ start, end }) => ({ start, end })) });
		} finally { await source.cleanup(); }
	});
	if (env.PSB_SCHEDULER_ENABLED === '1') store.startScheduler();
	const server = serve({ fetch: app.fetch, port: env.PORT });
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { store.stop(); server.close(() => { void store.close().then(() => { debug.close(); corpus.close(); process.exit(0); }); }); });
}
void main().catch(() => { console.error('startup_failed'); process.exitCode = 1; });
