import { createDebugServer } from 'debug-overlay/server';
import { join } from 'node:path';
import { z } from 'zod';
import { Stable, permitsAdminWrite } from './stable.js';
export function createDebugRoutes(stable: Stable, dataDir: string) {
	return createDebugServer({
		dbPath: join(dataDir, 'debug-overlay.sqlite'),
		authorize: async request => {
			const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
			if (!token) return false;
			const user = await stable.validate(token, true);
			return permitsAdminWrite(token, user);
		},
		routes: async request => {
			const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
			if (!token) return [];
			const paths = new Set(['/', '/podcasts', '/settings', '/debug/issues']);
			const libraries = z.object({ libraries: z.array(z.object({ id: z.string() })) }).parse(await stable.request('/api/libraries', token)).libraries;
			for (const library of libraries) {
				paths.add(`/library/${encodeURIComponent(library.id)}`);
				for (let page = 0; page < 100; page++) {
					const result = z.object({ results: z.array(z.object({ id: z.string() })), total: z.number() }).parse(await stable.request(`/api/libraries/${encodeURIComponent(library.id)}/items?limit=100&page=${page}`, token));
					for (const item of result.results) {
						try { await stable.item(item.id, token); paths.add(`/item/${encodeURIComponent(item.id)}`); } catch { /* Inaccessible resource excluded. */ }
					}
					if ((page + 1) * 100 >= result.total) break;
					if (page === 99) throw new Error('debug_discovery_limit');
				}
			}
			const playlists = z.array(z.object({ id: z.string(), userId: z.string() })).parse(await stable.request('/api/playlists', token));
			const user = await stable.validate(token);
			for (const playlist of playlists) if (playlist.userId === user.id) paths.add(`/playlist/${encodeURIComponent(playlist.id)}`);
			return [...paths].sort();
		},
	});
}
