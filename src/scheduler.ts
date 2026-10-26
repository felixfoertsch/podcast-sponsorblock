import { z } from 'zod';
import { Stable } from './stable.js';
import { Credential } from './credential.js';
import { Store } from './store.js';
import { EpisodeResolver } from './identity.js';
export function reconciler(stable: Stable, credential: Credential, resolver: EpisodeResolver) {
	return async (store: Store, signal: AbortSignal) => {
		if (signal.aborted) return;
		const token = await credential.get();
		const libraries = z.object({ libraries: z.array(z.object({ id: z.string(), mediaType: z.string() })) }).parse(await stable.request('/api/libraries', token)).libraries.filter(l => l.mediaType === 'podcast');
		for (const library of libraries) {
			if (signal.aborted) return;
			const page = store.schedulerPage(library.id);
			const response = z.object({ results: z.array(z.object({ id: z.string() })), total: z.number() }).parse(await stable.request(`/api/libraries/${encodeURIComponent(library.id)}/items?limit=20&page=${page}`, token));
			const offset = store.schedulerPage(`${library.id}:offset`);
			for (const row of response.results.slice(offset)) {
				if (signal.aborted) return;
				store.setSchedulerPage(`${library.id}:offset`, response.results.indexOf(row));
				const item = await stable.item(row.id, token);
				let resolved;
				try { resolved = await resolver.resolve(item); } catch { console.error('scheduler_feed_unavailable'); continue; }
				store.observeResolved(row.id, resolved);
				if (!store.enabled(row.id)) continue;
				const media = { episodes: resolved.episodes.filter(e => e.identity) };
				// One admission/show/pass avoids large shows starving remaining shows.
				const known = new Set(store.jobs(row.id).filter(j => j.status !== 'cancelled').map(j => j.episodeId));
				const next = media.episodes.find(e => !known.has(e.id));
				if (next) { try { store.enqueue(row.id, next.id, 0); } catch (error) { if (error instanceof Error && error.message === 'queue_full') return; throw error; } }
			}
			store.setSchedulerPage(`${library.id}:offset`, 0);
			store.setSchedulerPage(library.id, (page + 1) * 20 >= response.total ? 0 : page + 1);
		}
	};
}
