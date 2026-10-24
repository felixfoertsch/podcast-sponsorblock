import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeFrames, decodeFrames } from "../vendor/mpegFrameAlignment.js";
import { Store } from "./store.js";
import { AnalysisCorpus } from "./corpus.js";
import { type DebugImport } from "debug-overlay/server";

export type CatalogShow = { id: string; feedUrl: string | null };
export type CatalogEpisode = { id: string; showId: string; guid: string | null; enclosureUrl: string | null };
export type Match = { oldShowId: string; stableShowId: string; oldEpisodeId: string; stableEpisodeId: string | null; reason: "guid" | "enclosure" | "unmatched" | "conflict" };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const safeEqual = (a: string | null, b: string | null) => Boolean(a && b && a === b);
const validId = (v:unknown):v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

export function matchCatalog(oldShows: Array<{id:string;feedUrl:string|null}>, oldEpisodes: Array<{id:string;showId:string;guid:string|null;enclosureUrl:string|null}>, stableShows: CatalogShow[], stableEpisodes: CatalogEpisode[]): Match[] {
 const byFeed = new Map<string, CatalogShow[]>();
 for (const show of stableShows) if (show.feedUrl) byFeed.set(show.feedUrl, [...(byFeed.get(show.feedUrl) ?? []), show]);
 const showMatches = new Map<string, CatalogShow>();
 for (const old of oldShows) { const hits = old.feedUrl ? byFeed.get(old.feedUrl) ?? [] : []; if (hits.length === 1 && oldShows.filter(s=>s.feedUrl===old.feedUrl).length===1) showMatches.set(old.id, hits[0]); }
 return oldEpisodes.map(old => {
  const show = showMatches.get(old.showId);
  if (!show) return { oldShowId:old.showId,stableShowId:"",oldEpisodeId:old.id,stableEpisodeId:null,reason:"unmatched" };
  const candidates=stableEpisodes.filter(ep=>ep.showId===show.id), guid=old.guid?candidates.filter(ep=>safeEqual(ep.guid,old.guid)):[], enclosure=old.enclosureUrl?candidates.filter(ep=>safeEqual(ep.enclosureUrl,old.enclosureUrl)):[];
  if(guid.length>1||enclosure.length>1||(guid.length&&enclosure.length&&guid[0].id!==enclosure[0].id)) return {oldShowId:old.showId,stableShowId:show.id,oldEpisodeId:old.id,stableEpisodeId:null,reason:"conflict"};
  const hit=guid[0]??enclosure[0]; return {oldShowId:old.showId,stableShowId:show.id,oldEpisodeId:old.id,stableEpisodeId:hit?.id??null,reason:hit?guid.length?"guid":"enclosure":"unmatched"};
 });
}

export function openMigrationDatabase(path:string):Database.Database {
 const db=new Database(path); db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
 db.exec(`CREATE TABLE IF NOT EXISTS psb_migration_receipts(input_sha256 TEXT PRIMARY KEY,imported_at TEXT NOT NULL,matched INTEGER NOT NULL,archived INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS psb_migration_show_map(old_id TEXT PRIMARY KEY,stable_id TEXT,feed_url TEXT,consent INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS psb_migration_episode_map(old_id TEXT PRIMARY KEY,old_show_id TEXT NOT NULL,stable_id TEXT,reason TEXT NOT NULL,source_sha256 TEXT,applicable INTEGER NOT NULL DEFAULT 0,archived_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS psb_migration_corpus_archive(legacy_id TEXT PRIMARY KEY,manifest_json TEXT NOT NULL,fingerprint BLOB,frames BLOB,state TEXT NOT NULL DEFAULT 'archived');
 CREATE TABLE IF NOT EXISTS psb_migration_debug_archive(archive_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);`); return db;
}
export type Input={shows:Array<{id:string;feedUrl:string|null;consent:boolean;libraryItemId?:string}>;episodes:Array<{id:string;showId:string;guid:string|null;enclosureUrl:string|null;sourceSha256:string|null;analysis:any}>;corpusDir?:string;debugRecords?:unknown[];debugImport?:DebugImport};
function readCorpus(dir?:string) {
 if(!dir)return[]; const root=resolve(dir), names=readdirSync(root).sort(); let total=0;
 const rows=names.map(name=>{ if(!/^[a-f0-9]{64}$/.test(name)) throw Error("corpus_invalid"); const path=join(root,name), ds=lstatSync(path); if(!ds.isDirectory()||ds.isSymbolicLink())throw Error("corpus_invalid");
  const files=readdirSync(path).sort(), manifestBytes=readFileSync(join(path,"manifest.json")); if(manifestBytes.length>4096)throw Error("corpus_invalid"); const m=JSON.parse(manifestBytes.toString()) as Record<string,any>;
  const common="algorithm,audioBytes,collectedAt,duration,episodeId,fingerprintBytes,fingerprintSha256,format,itemId,provider,route,sha256,version,versionId";
  const keys=Object.keys(m).sort().join(","), v1=keys===common, v2=keys===common.replace(",itemId",",frameBytes,frameSha256,itemId");
  if(m.versionId!==name||m.versionId!==sha(Buffer.from(JSON.stringify([m.itemId,m.episodeId,m.sha256,m.fingerprintSha256])))||m.algorithm!=="chromaprint-test2-inward-v1"||!validId(m.itemId)||!validId(m.episodeId)||!["apple","gpodder"].includes(m.provider)||!["direct","vpn_proxy"].includes(m.route)||typeof m.collectedAt!=="string"||new Date(m.collectedAt).toISOString()!==m.collectedAt||!hex(m.sha256)||!hex(m.fingerprintSha256)||!Number.isFinite(m.duration)||m.duration<50||m.duration>14400||!Number.isInteger(m.audioBytes)||m.audioBytes<1||m.audioBytes>256*1024*1024||!Number.isInteger(m.fingerprintBytes)||m.fingerprintBytes<1||m.fingerprintBytes>2*1024*1024||!((m.version===1&&v1&&m.format==="raw-uint32-json")||(m.version===2&&v2&&m.format==="mpeg-frames-v1"&&hex(m.frameSha256)&&Number.isInteger(m.frameBytes)&&m.frameBytes>0&&m.frameBytes<=24*1024*1024)))throw Error("corpus_invalid");
  const expected=m.version===1?["audio","fingerprint.json","manifest.json",...(files.includes("frames.bin")?["frames.bin"]:[]),...(files.includes("manifest.next")?["manifest.next"]:[])]:["fingerprint.json","frames.bin","manifest.json",...(files.includes("audio")?["audio"]:[])]; if(files.join("\0")!==expected.sort().join("\0"))throw Error("corpus_invalid");
  const regular=(file:string,max:number)=>{const st=lstatSync(join(path,file));if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>max)throw Error("corpus_invalid");return readFileSync(join(path,file));};
  const fp=regular("fingerprint.json",2*1024*1024); if(fp.length!==m.fingerprintBytes||sha(fp)!==m.fingerprintSha256)throw Error("corpus_invalid"); const fingerprint=JSON.parse(fp.toString()); if(!Array.isArray(fingerprint)||!fingerprint.length||fingerprint.length>120000||!fingerprint.every((n:number)=>Number.isInteger(n)&&n>=0&&n<=0xffffffff))throw Error("corpus_invalid");
  let frames:Buffer; if(m.version===2){frames=regular("frames.bin",24*1024*1024);if(frames.length!==m.frameBytes||sha(frames)!==m.frameSha256)throw Error("corpus_invalid");}else {const audio=regular("audio",256*1024*1024);if(audio.length!==m.audioBytes||sha(audio)!==m.sha256)throw Error("corpus_invalid"); frames=encodeFrames(audio); if(files.includes("frames.bin")&&!frames.equals(regular("frames.bin",24*1024*1024)))throw Error("corpus_invalid");}
  if(files.includes("audio")&&m.version===2){const audio=regular("audio",256*1024*1024);if(audio.length!==m.audioBytes||sha(audio)!==m.sha256)throw Error("corpus_invalid");total+=audio.length;}
   if(!frames.length||frames.length>24*1024*1024)throw Error("corpus_invalid");decodeFrames(frames); total+=manifestBytes.length+fp.length+frames.length; if(total>10*1024*1024*1024)throw Error("corpus_limit"); return {legacyId:name,manifest:m,fingerprint:fp,frames};
 });
 const counts=new Map<string,number>(); for(const r of rows){const k=`${r.manifest.itemId}/${r.manifest.episodeId}`, n=(counts.get(k)??0)+1;counts.set(k,n);if(n>5)throw Error("corpus_episode_limit");} return rows;
}
export function migrateCopy(input:Input,stableShows:CatalogShow[],stableEpisodes:CatalogEpisode[],db:Database.Database,inputBytes:Buffer,options:{apply?:boolean;debugDbPath?:string;serverId?:string}={}) {
	const digest=sha(inputBytes), corpus=readCorpus(input.corpusDir), matches=matchCatalog(input.shows,input.episodes,stableShows,stableEpisodes);
	const serverId=options.serverId??"default";
	// Offline migration keeps runtime data and receipt on one connection/transaction.
	const store=new Store(db.name,{serverId}); void store.close();
	const runtimeCorpus=new AnalysisCorpus(db.name);runtimeCorpus.close();
	const showMap=new Map(input.shows.map(old=>{const hits=stableShows.filter(s=>s.feedUrl===old.feedUrl&&old.feedUrl!==null);return[old.id,hits.length===1&&input.shows.filter(s=>s.feedUrl===old.feedUrl).length===1?hits[0].id:null] as const;}));
	const episodeMap=new Map(matches.filter(m=>m.stableEpisodeId).map(m=>[m.oldEpisodeId,m]));
	let debugAttached=false;
	if(options.apply&&options.debugDbPath){
		// Attached databases use rollback journals so SQLite commits both atomically.
		db.pragma("journal_mode = DELETE");
		db.prepare("ATTACH DATABASE ? AS debug_import").run(options.debugDbPath);debugAttached=true;
		db.exec(`PRAGMA debug_import.journal_mode=DELETE;
		CREATE TABLE IF NOT EXISTS debug_import.notes(route_path TEXT PRIMARY KEY,note TEXT NOT NULL DEFAULT '',waiting_on TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE IF NOT EXISTS debug_import.sub_items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,scope_pattern TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT '',UNIQUE(name,scope_pattern));
		CREATE TABLE IF NOT EXISTS debug_import.sub_item_status(sub_item_id INTEGER NOT NULL REFERENCES sub_items(id) ON DELETE CASCADE,route_path TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'TODO',note TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(sub_item_id,route_path));`);
	}
	let debugImported=0, debugArchived=0, resultsImported=0, corpusImported=0;
	const routeMap=(route:string):string|null=>{
		if(!route.startsWith('/')||route.includes('..')||route.includes('?')||route.includes('#'))return null;
		let mapped=false;
		const parts=route.split('/').map(part=>{const ep=episodeMap.get(part);if(ep){mapped=true;return ep.stableEpisodeId!;}const show=input.shows.find(s=>s.id===part||s.libraryItemId===part);if(show){const id=showMap.get(show.id);if(id){mapped=true;return id;}}return part;});
		return mapped?parts.join('/'):null;
	};
	const archive=(record:unknown)=>{const json=JSON.stringify(record);db.prepare("INSERT OR IGNORE INTO psb_migration_debug_archive VALUES(?,?)").run(sha(Buffer.from(json)),json);debugArchived++;};
	try {
		const result=db.transaction(()=>{
			if(db.prepare("SELECT 1 FROM psb_migration_receipts WHERE input_sha256=?").get(digest))return {repeated:true,digest,matches,debugImported:0,debugArchived:0,resultsImported:0,corpusImported:0};
			for(const old of input.shows){const dest=showMap.get(old.id);db.prepare("INSERT INTO psb_migration_show_map VALUES(?,?,?,?,?)").run(old.id,dest,old.feedUrl,Number(Boolean(dest&&old.consent)),dest?'matched':'archived');if(dest&&options.apply)db.prepare("INSERT INTO consent VALUES(?,?,?) ON CONFLICT(server_id,item_id) DO NOTHING").run(serverId,dest,Number(old.consent));}
			for(const old of input.episodes){const match=matches.find(m=>m.oldEpisodeId===old.id)!;db.prepare("INSERT INTO psb_migration_episode_map VALUES(?,?,?,?,?,0,?)").run(old.id,old.showId,match.stableEpisodeId,match.reason,old.sourceSha256,JSON.stringify({analysis:old.analysis}));
				const segments:unknown=old.analysis?.segments;
				let end=0;
				const valid=Array.isArray(segments)&&segments.every(s=>{const ok=typeof s==='object'&&s!==null&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=end&&s.end>s.start&&s.end<=14400;end=s.end;return ok;});
				if(options.apply&&match.stableEpisodeId&&hex(old.sourceSha256)&&valid){db.prepare("INSERT INTO results VALUES(?,?,?,?,?,?,0,'stale') ON CONFLICT(server_id,item_id,episode_id) DO NOTHING").run(serverId,match.stableShowId,match.stableEpisodeId,old.sourceSha256,'migration-v1',JSON.stringify(segments));resultsImported++;}
			}
			for(const row of corpus){const m=row.manifest;db.prepare("INSERT INTO psb_migration_corpus_archive(legacy_id,manifest_json,fingerprint,frames) VALUES(?,?,?,?)").run(row.legacyId,JSON.stringify(m),row.fingerprint,row.frames);
				const match=episodeMap.get(m.episodeId), oldShow=input.shows.find(s=>s.id===match?.oldShowId);
				if(!options.apply||!match||!oldShow||![oldShow.id,oldShow.libraryItemId].includes(m.itemId))continue;
				const id=sha(Buffer.from(JSON.stringify([match.stableShowId,match.stableEpisodeId,m.sha256,m.fingerprintSha256])));
				corpusImported+=db.prepare("INSERT OR IGNORE INTO analysis_corpus_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,match.stableShowId,match.stableEpisodeId,m.algorithm,m.sha256,m.fingerprintSha256,m.provider,m.route,m.collectedAt,m.duration,m.audioBytes,row.fingerprint,row.frames,sha(row.frames)).changes;
			}
			for(const record of input.debugRecords??[])archive(record);
			const data=input.debugImport;
			if(data){
				const ids=new Map<number,number>();
				for(const note of data.notes){const route=routeMap(note.routePath);if(!debugAttached||!route){archive({kind:'note',...note});continue;}
					if(typeof note.note!=='string'||note.note.length>100000||!['','agent','user'].includes(note.waitingOn))throw Error('debug_invalid');
					if(db.prepare('SELECT 1 FROM debug_import.notes WHERE route_path=?').get(route))throw Error('debug_collision');
					db.prepare('INSERT INTO debug_import.notes VALUES(?,?,?,?)').run(route,note.note,note.waitingOn,note.updatedAt);debugImported++;
				}
				for(const item of data.subItems){const scope=routeMap(item.scopePattern);if(!debugAttached||!scope){archive({kind:'subItem',...item});continue;}
					if(!Number.isSafeInteger(item.id)||item.id<=0||typeof item.name!=='string'||!item.name.trim()||item.name.length>200)throw Error('debug_invalid');
					if(db.prepare('SELECT 1 FROM debug_import.sub_items WHERE name=? AND scope_pattern=?').get(item.name,scope))throw Error('debug_collision');
					const inserted=db.prepare('INSERT INTO debug_import.sub_items(name,scope_pattern,created_at) VALUES(?,?,?)').run(item.name,scope,item.createdAt);ids.set(item.id,Number(inserted.lastInsertRowid));debugImported++;
				}
				for(const status of data.statuses){const route=routeMap(status.routePath),id=ids.get(status.subItemId);if(!debugAttached||!route||!id){archive({kind:'status',...status});continue;}
					if(!['TODO','QA','DONE'].includes(status.status)||typeof status.note!=='string'||status.note.length>100000)throw Error('debug_invalid');
					db.prepare('INSERT INTO debug_import.sub_item_status VALUES(?,?,?,?,?)').run(id,route,status.status,status.note,status.updatedAt);debugImported++;
				}
			}
			db.prepare("INSERT INTO psb_migration_receipts VALUES(?,?,?,?)").run(digest,new Date().toISOString(),episodeMap.size,input.episodes.length-episodeMap.size+corpus.length+debugArchived);
			return{repeated:false,digest,matches,debugImported,debugArchived,resultsImported,corpusImported};
		})();
		return result;
	}finally{if(debugAttached)db.exec('DETACH DATABASE debug_import');}
}
export function sha256(bytes:Buffer){return sha(bytes)}
