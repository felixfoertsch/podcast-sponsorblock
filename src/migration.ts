import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

export type CatalogShow = { id: string; feedUrl: string | null };
export type CatalogEpisode = { id: string; showId: string; guid: string | null; enclosureUrl: string | null };
export type Match = { oldShowId: string; stableShowId: string; oldEpisodeId: string; stableEpisodeId: string | null; reason: "guid" | "enclosure" | "unmatched" | "conflict" };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const safeEqual = (a: string | null, b: string | null) => Boolean(a && b && a === b);

export function matchCatalog(oldShows: Array<{id:string;feedUrl:string|null}>, oldEpisodes: Array<{id:string;showId:string;guid:string|null;enclosureUrl:string|null}>, stableShows: CatalogShow[], stableEpisodes: CatalogEpisode[]): Match[] {
	const byFeed = new Map<string, CatalogShow[]>();
	for (const show of stableShows) if (show.feedUrl) byFeed.set(show.feedUrl, [...(byFeed.get(show.feedUrl) ?? []), show]);
	const showMatches = new Map<string, CatalogShow>();
	for (const old of oldShows) { const hits = old.feedUrl ? byFeed.get(old.feedUrl) ?? [] : []; if (hits.length === 1) showMatches.set(old.id, hits[0]); }
	return oldEpisodes.map((old) => {
		const show = showMatches.get(old.showId);
		if (!show) return { oldShowId: old.showId, stableShowId: "", oldEpisodeId: old.id, stableEpisodeId: null, reason: "unmatched" };
		const candidates = stableEpisodes.filter((ep) => ep.showId === show.id);
		const guid = old.guid ? candidates.filter((ep) => safeEqual(ep.guid, old.guid)) : [];
		const enclosure = old.enclosureUrl ? candidates.filter((ep) => safeEqual(ep.enclosureUrl, old.enclosureUrl)) : [];
		if (guid.length > 1 || enclosure.length > 1 || (guid.length && enclosure.length && guid[0].id !== enclosure[0].id)) return { oldShowId: old.showId, stableShowId: show.id, oldEpisodeId: old.id, stableEpisodeId: null, reason: "conflict" };
		const hit = guid[0] ?? enclosure[0];
		return { oldShowId: old.showId, stableShowId: show.id, oldEpisodeId: old.id, stableEpisodeId: hit?.id ?? null, reason: hit ? guid.length ? "guid" : "enclosure" : "unmatched" };
	});
}

export function openMigrationDatabase(path: string): Database.Database {
	const db = new Database(path);
	db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
	db.exec(`CREATE TABLE IF NOT EXISTS psb_migration_receipts (input_sha256 TEXT PRIMARY KEY, imported_at TEXT NOT NULL, matched INTEGER NOT NULL, archived INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS psb_migration_show_map (old_id TEXT PRIMARY KEY, stable_id TEXT, feed_url TEXT, consent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS psb_migration_episode_map (old_id TEXT PRIMARY KEY, old_show_id TEXT NOT NULL, stable_id TEXT, reason TEXT NOT NULL, source_sha256 TEXT, applicable INTEGER NOT NULL DEFAULT 0, archived_json TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS psb_migration_corpus_archive (legacy_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, fingerprint BLOB, frames BLOB, state TEXT NOT NULL DEFAULT 'archived');
	CREATE TABLE IF NOT EXISTS psb_migration_debug_archive (archive_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);`);
	return db;
}

type Input = { shows: Array<{id:string;feedUrl:string|null;consent:boolean}>; episodes: Array<{id:string;showId:string;guid:string|null;enclosureUrl:string|null;sourceSha256:string|null;analysis:unknown}>; corpusDir?: string; debugRecords?: unknown[] };
function readCorpus(dir?: string) {
	if (!dir) return [];
	const root = resolve(dir);
	return readdirSync(root).sort().map((name) => {
		const path = join(root, name);
		if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("invalid_corpus_entry");
		const manifestBytes = readFileSync(join(path, "manifest.json"));
		if (manifestBytes.length > 1024 * 1024) throw new Error("corpus_manifest_too_large");
		const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
		if (![1, 2].includes(Number(manifest.version))) throw new Error("unsupported_corpus_version");
		const fingerprint = readFileSync(join(path, "fingerprint.json"));
		const framesPath = join(path, "frames.bin");
		const frames = lstatSync(framesPath).isFile() ? readFileSync(framesPath) : null;
		if (fingerprint.length > 2 * 1024 * 1024 || (frames?.length ?? 0) > 24 * 1024 * 1024) throw new Error("corpus_evidence_too_large");
		return { legacyId: name, manifest, fingerprint, frames };
	});
}

export function migrateCopy(input: Input, stableShows: CatalogShow[], stableEpisodes: CatalogEpisode[], db: Database.Database, inputBytes: Buffer) {
	const digest = sha(inputBytes);
	const corpus = readCorpus(input.corpusDir);
	const matches = matchCatalog(input.shows, input.episodes, stableShows, stableEpisodes);
	const tx = db.transaction(() => {
		const receipt = db.prepare("SELECT input_sha256 FROM psb_migration_receipts WHERE input_sha256=?").get(digest);
		if (receipt) return { repeated: true, digest, matches };
		const showMap = new Map<string, CatalogShow>();
		for (const old of input.shows) {
			const hit = stableShows.filter((s) => s.feedUrl === old.feedUrl && old.feedUrl !== null);
			const mapped = hit.length === 1 ? hit[0] : null;
			showMap.set(old.id, mapped ?? { id: "", feedUrl: old.feedUrl });
			db.prepare("INSERT INTO psb_migration_show_map(old_id,stable_id,feed_url,consent,state) VALUES(?,?,?,?,?)").run(old.id, mapped?.id ?? null, old.feedUrl, mapped && old.consent ? 1 : 0, mapped ? "matched" : "archived");
		}
		let matched = 0;
		for (const old of input.episodes) {
			const match = matches.find((m) => m.oldEpisodeId === old.id)!;
			const applicable = Boolean(match.stableEpisodeId && old.sourceSha256);
			matched += Number(Boolean(match.stableEpisodeId));
			db.prepare("INSERT INTO psb_migration_episode_map(old_id,old_show_id,stable_id,reason,source_sha256,applicable,archived_json) VALUES(?,?,?,?,?,?,?)").run(old.id, old.showId, match.stableEpisodeId, match.reason, old.sourceSha256, 0, JSON.stringify({ analysis: old.analysis, sourceHashRequired: applicable }));
		}
		for (const row of corpus) db.prepare("INSERT INTO psb_migration_corpus_archive(legacy_id,manifest_json,fingerprint,frames) VALUES(?,?,?,?)").run(row.legacyId, JSON.stringify(row.manifest), row.fingerprint, row.frames);
		for (const record of input.debugRecords ?? []) db.prepare("INSERT INTO psb_migration_debug_archive(archive_id,record_json) VALUES(?,?)").run(sha(Buffer.from(JSON.stringify(record))), JSON.stringify(record));
		db.prepare("INSERT INTO psb_migration_receipts(input_sha256,imported_at,matched,archived) VALUES(?,?,?,?)").run(digest, new Date().toISOString(), matched, input.episodes.length - matched + corpus.length + (input.debugRecords?.length ?? 0));
		return { repeated: false, digest, matches };
	});
	return tx();
}

export function sha256(bytes: Buffer) { return sha(bytes); }
