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

test("apply bridges runtime, gates source hashes, rolls back debug collisions", async () => {
	const {mkdtempSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {Store}=await import('../src/store');
	const dir=mkdtempSync(join(tmpdir(),'psb-apply-')), path=join(dir,'runtime.sqlite'), db=openMigrationDatabase(path);
	const input={shows:[{id:'old',feedUrl:'f',consent:true}],episodes:[{id:'e',showId:'old',guid:'g',enclosureUrl:'u',sourceSha256:'a'.repeat(64),analysis:{status:'candidates',segments:[{start:1,end:2}]}}],debugImport:{notes:[{routePath:'/item/old',note:'mapped',waitingOn:'',updatedAt:''}],subItems:[],statuses:[]}};
	const shows=[{id:'new',feedUrl:'f'}],episodes=[{id:'new-e',showId:'new',guid:'g',enclosureUrl:'u'}], options={apply:true,debugDbPath:join(dir,'debug.sqlite')};
	try{
		assert.equal(migrateCopy(input,shows,episodes,db,Buffer.from('one'),options).resultsImported,1);
		assert.equal(migrateCopy(input,shows,episodes,db,Buffer.from('one'),options).repeated,true);
		const store=new Store(path);assert.equal(store.analysis('new')['new-e'].applicable,false);store.verifySource('new','new-e','a'.repeat(64));assert.equal(store.analysis('new')['new-e'].applicable,true);store.verifySource('new','new-e','b'.repeat(64));assert.deepEqual(store.analysis('new')['new-e'].segments,[]);assert.equal(store.jobs('new')[0].status,'queued');await store.close();
		assert.equal(db.pragma('integrity_check')[0].integrity_check,'ok');assert.equal(db.pragma('foreign_key_check').length,0);
		const collision=openMigrationDatabase(join(dir,'other.sqlite'));
		try { assert.throws(()=>migrateCopy(input,shows,episodes,collision,Buffer.from('two'),options),/debug_collision/); assert.equal(collision.prepare('SELECT count(*) n FROM psb_migration_receipts').get().n,0); assert.equal(collision.prepare('SELECT count(*) n FROM results').get().n,0); } finally { collision.close(); }
	}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
