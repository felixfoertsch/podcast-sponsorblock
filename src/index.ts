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
	void store.start(async (job, signal) => {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(20 * 60 * 1000)]);
		if (!store.enabled(job.itemId)) throw new Error('consent_required');
		const source = await downloadSource(stable, credential, job.itemId, job.episodeId, bounded);
		try {
			if(job.kind==='verify') {
				if(bounded.aborted||!store.enabled(job.itemId))throw new Error('cancelled');
				const identity=fileIdentity(source.episode);
				if(!identity)throw new Error('source_identity_unavailable');
				if(identity&&(job.identity===null||identity===job.identity))store.verifySource(job.itemId,job.episodeId,source.sha256,identity);
				else store.observeSources(job.itemId,source.item);
				return;
			}
			const metadata = parseAnalysisMetadata(source.item, source.episode);
			const result = await analyzeCandidates({ sourcePath: source.path, duration: source.duration, itemId: job.itemId, episodeId: job.episodeId, corpus, ...metadata, episode: { ...metadata.episode, publishedAt: metadata.episode.pubDate }, transport, signal: bounded });
			if (bounded.aborted || !store.enabled(job.itemId)) throw new Error('cancelled');
			// Re-download stable bytes before publication; metadata/ETag cannot prove timeline.
			const current = await downloadSource(stable, credential, job.itemId, job.episodeId, bounded);
			try { if (current.sha256 !== source.sha256) throw new Error('source_changed'); } finally { await current.cleanup(); }
			store.setResult(job.itemId, job.episodeId, { status: result.status, sourceSha256: source.sha256, version: '1', segments: result.segments, adAnalysisEnabled: true, applicable: ['candidates', 'no_difference'].includes(result.status) }, fileIdentity(source.episode));
		} finally { await source.cleanup(); }
	});
	if (env.PSB_SCHEDULER_ENABLED === '1') store.startScheduler();
	const server = serve({ fetch: app.fetch, port: env.PORT });
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { store.stop(); server.close(() => { void store.close().then(() => { debug.close(); corpus.close(); process.exit(0); }); }); });
}
void main().catch(() => { console.error('startup_failed'); process.exitCode = 1; });
