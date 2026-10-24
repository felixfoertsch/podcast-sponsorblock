import { z } from "zod";

export const debugRouteSchema = z.object({ path: z.string().min(1), status: z.number().int().nullable().optional() }).passthrough();
export const debugRoutesSchema = z.array(debugRouteSchema);
export type DebugRoute = z.infer<typeof debugRouteSchema>;

/** Parent supplies authenticated ABS discovery; token must be requesting user's token. */
export interface DebugDiscovery {
	staticPaths: string[];
	getAccessibleLibraries(token: string, page?: string): Promise<{ items: Array<{ id: string; mediaType: string }>; nextPage?: string }>;
	getAccessibleItems(token: string, page?: string): Promise<{ items: Array<{ id: string; libraryId: string; mediaType: string }>; nextPage?: string }>;
	getOwnedPlaylists(token: string, page?: string): Promise<{ items: Array<{ id: string; libraryId: string }>; nextPage?: string }>;
	getAdminRoutes?(token: string, page?: string): Promise<{ items: DebugRoute[]; nextPage?: string }>;
	isAdmin(token: string): boolean;
}
const MAX_PAGES = 100;

async function collect<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextPage?: string }>): Promise<T[]> {
	const rows: T[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await fetchPage(cursor);
		rows.push(...result.items);
		if (!result.nextPage) return rows;
		if (result.nextPage === cursor) throw new Error("debug_pagination_loop");
		cursor = result.nextPage;
	}
	throw new Error("debug_pagination_limit");
}

export async function discoverDebugRoutes(token: string, api: DebugDiscovery): Promise<string[]> {
	if (!token) throw new Error("requesting_token_required");
	const [libraries, items, playlists] = await Promise.all([
		collect((page) => api.getAccessibleLibraries(token, page)),
		collect((page) => api.getAccessibleItems(token, page)),
		collect((page) => api.getOwnedPlaylists(token, page)),
	]);
	const paths = new Set(api.staticPaths);
	const add = (...parts: string[]) => paths.add(`/${parts.map(encodeURIComponent).join("/")}`);
	for (const library of libraries) {
		add("library", library.id);
		if (library.mediaType === "podcast") for (const page of ["search", "latest", "download-queue"]) add("library", library.id, "podcast", page);
	}
	for (const item of items) add("item", item.id);
	for (const playlist of playlists) add("playlist", playlist.id);
	if (api.isAdmin(token) && api.getAdminRoutes) {
		const adminRoutes = await collect((page) => api.getAdminRoutes!(token, page));
		for (const { path } of adminRoutes) if (path.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(path)) paths.add(path);
	}
	return [...paths].sort();
}
