import { z } from 'zod';
import { Stable } from './stable.js';
import { Credential } from './credential.js';
import { Store } from './store.js';
export function reconciler(stable: Stable, credential: Credential) {
	const pages = new Map<string, number>();
	return async (store: Store, signal: AbortSignal) => {
		if (signal.aborted) return;
		const token = await credential.get();
		const libraries = z.object({ libraries: z.array(z.object({ id: z.string(), mediaType: z.string() })) }).parse(await stable.request('/api/libraries', token)).libraries.filter(l => l.mediaType === 'podcast');
		for (const library of libraries) {
			const page = pages.get(library.id) ?? 0;
			const response = z.object({ results: z.array(z.object({ id: z.string() })), total: z.number() }).parse(await stable.request(`/api/libraries/${encodeURIComponent(library.id)}/items?limit=20&page=${page}`, token));
			for (const row of response.results) {
				if (signal.aborted) return;
				if (!store.enabled(row.id)) continue;
				const item = await stable.item(row.id, token);
				const media = z.object({ episodes: z.array(z.object({ id: z.string() })) }).parse(item.media);
				// One admission/show/pass avoids large shows starving remaining shows.
				const known = new Set(store.jobs(row.id).map(j => j.episodeId));
				const next = media.episodes.find(e => !known.has(e.id));
				if (next) { try { store.enqueue(row.id, next.id); } catch (error) { if (error instanceof Error && error.message === 'queue_full') return; throw error; } }
			}
			pages.set(library.id, (page + 1) * 20 >= response.total ? 0 : page + 1);
		}
	};
}
