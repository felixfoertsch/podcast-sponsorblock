import assert from "node:assert/strict";
import { discoverDebugRoutes } from "../src/debug";

async function main() {
	const tokens: string[] = [];
	const api = {
		staticPaths: ["/"], isAdmin: () => false,
		async getAccessibleLibraries(token: string, page?: string) { tokens.push(token); return page ? { items: [] } : { items: [{ id: "lib", mediaType: "podcast" }], nextPage: "next" }; },
		async getAccessibleItems(token: string) { tokens.push(token); return { items: [{ id: "item", libraryId: "lib", mediaType: "podcast" }] }; },
		async getOwnedPlaylists(token: string) { tokens.push(token); return { items: [] }; },
	};
	const paths = await discoverDebugRoutes("user-token", api);
	assert(paths.includes("/library/lib/podcast/latest"));
	assert(paths.includes("/item/item"));
	assert.deepEqual(tokens, ["user-token", "user-token", "user-token", "user-token"]);
}
void main();
