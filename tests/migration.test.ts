import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCatalog, migrateCopy, openMigrationDatabase } from "../src/migration";

test("matches exact feed, GUID then enclosure; rejects GUID/enclosure conflict", () => {
	const shows = [{ id: "old", feedUrl: "https://feed.test/rss", consent: true }];
	const stableShows = [{ id: "new", feedUrl: "https://feed.test/rss" }];
	const stable = [
		{ id: "ep-guid", showId: "new", guid: "guid", enclosureUrl: "https://x/one" },
		{ id: "ep-url", showId: "new", guid: "other", enclosureUrl: "https://x/two" },
	];
	const result = matchCatalog(shows, [
		{ id: "1", showId: "old", guid: "guid", enclosureUrl: "https://x/one" },
		{ id: "2", showId: "old", guid: null, enclosureUrl: "https://x/two" },
		{ id: "3", showId: "old", guid: "guid", enclosureUrl: "https://x/two" },
	], stableShows, stable);
	assert.deepEqual(result.map((x) => [x.stableEpisodeId, x.reason]), [["ep-guid", "guid"], ["ep-url", "enclosure"], [null, "conflict"]]);
	assert.equal(matchCatalog(shows, [], [{ id: "x", feedUrl: "https://feed.test/other" }], []).length, 0);
});

test("dry import stays idempotent and source results remain inapplicable", () => {
	const db = openMigrationDatabase(":memory:");
	const input = { shows: [{ id: "old", feedUrl: "f", consent: true }], episodes: [{ id: "e", showId: "old", guid: "g", enclosureUrl: "u", sourceSha256: "abc", analysis: { segments: [1] } }] };
	const shows = [{ id: "new", feedUrl: "f" }], episodes = [{ id: "stable-ep", showId: "new", guid: "g", enclosureUrl: "u" }];
	const bytes = Buffer.from("fixture");
	const first = migrateCopy(input, shows, episodes, db, bytes);
	const second = migrateCopy(input, shows, episodes, db, bytes);
	assert.equal(first.repeated, false); assert.equal(second.repeated, true);
	assert.equal(db.prepare("SELECT applicable FROM psb_migration_episode_map").get().applicable, 0);
	assert.equal(db.prepare("SELECT consent FROM psb_migration_show_map").get().consent, 1);
	assert.equal(db.pragma("integrity_check")[0].integrity_check, "ok");
	db.close();
});
