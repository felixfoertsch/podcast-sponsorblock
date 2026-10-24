import Database from "better-sqlite3";
import { z } from "zod";

export function fileIdentity(episode: unknown): string | null {
	const parsed=z.object({audioFile:z.object({ino:z.union([z.string().min(1),z.number().int().safe()]),metadata:z.object({size:z.number().int().safe().nonnegative(),mtimeMs:z.number().finite().nonnegative()})})}).safeParse(episode);
	return parsed.success ? JSON.stringify([String(parsed.data.audioFile.ino),parsed.data.audioFile.metadata.size,parsed.data.audioFile.metadata.mtimeMs]) : null;
}

export type Segment = { start: number; end: number };
export type EpisodeResult = { status: string; version: string; sourceSha256: string; segments: Segment[]; adAnalysisEnabled: boolean; applicable: boolean };
export type Job = { kind: "analysis" | "verify"; identity: string | null; id: number; itemId: string; episodeId: string; status: string; attempts: number; error?: string };
export type StoreOptions = { serverId?: string; scheduler?: (store: Store, signal: AbortSignal) => Promise<void>; intervalMs?: number };

export class Store {
	private db: Database.Database;
	private serverId: string;
	private active = new Map<number, AbortController>();
	private worker?: AbortController;
	private timer?: NodeJS.Timeout;
	private scheduler?: StoreOptions["scheduler"];
	private intervalMs: number;
	private scheduling = false;
	private pump?: Promise<void>;
	private schedulerRun?: Promise<void>;
	private schedulerAbort?: AbortController;

	constructor(path: string, options: StoreOptions = {}) {
		this.db = new Database(path);
		this.serverId = options.serverId ?? "default";
		this.scheduler = options.scheduler;
		this.intervalMs = options.intervalMs ?? 120_000;
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
			INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
			CREATE TABLE IF NOT EXISTS consent(server_id TEXT NOT NULL,item_id TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),PRIMARY KEY(server_id,item_id));
			CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,server_id TEXT NOT NULL,item_id TEXT NOT NULL,episode_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,UNIQUE(server_id,item_id,episode_id));
			CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status,created_at);
			CREATE TABLE IF NOT EXISTS results(server_id TEXT NOT NULL,item_id TEXT NOT NULL,episode_id TEXT NOT NULL,source_sha TEXT NOT NULL,version TEXT NOT NULL,segments TEXT NOT NULL,applicable INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'complete',PRIMARY KEY(server_id,item_id,episode_id));
			CREATE TABLE IF NOT EXISTS scheduler_state(server_id TEXT NOT NULL,library_id TEXT NOT NULL,page INTEGER NOT NULL CHECK(page>=0),PRIMARY KEY(server_id,library_id));`);
		const columns = this.db.pragma('table_info(results)') as Array<{ name: string }>;
		if (!columns.some(column => column.name === 'status')) this.db.exec("ALTER TABLE results ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'");
		for (const [name, definition] of [["identity","TEXT"],["verified_identity","TEXT"],["needs_analysis","INTEGER NOT NULL DEFAULT 0"]]) if (!columns.some(c=>c.name===name)) this.db.exec(`ALTER TABLE results ADD COLUMN ${name} ${definition}`);
		const jobColumns=this.db.pragma('table_info(jobs)') as Array<{name:string}>;
		for (const [name, definition] of [["kind","TEXT NOT NULL DEFAULT 'analysis'"],["identity","TEXT"]]) if (!jobColumns.some(c=>c.name===name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
		this.db.prepare("UPDATE jobs SET status='interrupted' WHERE server_id=? AND status='running'").run(this.serverId);
		this.db.prepare("UPDATE jobs SET status='queued' WHERE server_id=? AND status='interrupted' AND attempts < 2").run(this.serverId);
	}

	enabled(itemId: string): boolean {
		return Boolean(this.db.prepare("SELECT enabled FROM consent WHERE server_id=? AND item_id=?").pluck().get(this.serverId, itemId));
	}
	schedulerPage(libraryId: string): number {
		return (this.db.prepare("SELECT page FROM scheduler_state WHERE server_id=? AND library_id=?").pluck().get(this.serverId, libraryId) as number | undefined) ?? 0;
	}
	setSchedulerPage(libraryId: string, page: number): void {
		if (!Number.isSafeInteger(page) || page < 0) throw new Error("invalid_scheduler_page");
		this.db.prepare("INSERT INTO scheduler_state VALUES(?,?,?) ON CONFLICT(server_id,library_id) DO UPDATE SET page=excluded.page").run(this.serverId, libraryId, page);
	}
	setEnabled(itemId: string, enabled: boolean): void {
		this.db.prepare("INSERT INTO consent VALUES(?,?,?) ON CONFLICT(server_id,item_id) DO UPDATE SET enabled=excluded.enabled").run(this.serverId, itemId, Number(enabled));
		if (!enabled) {
			this.db.prepare("UPDATE jobs SET status='cancelled' WHERE server_id=? AND item_id=? AND status IN ('queued','running')").run(this.serverId,itemId);
			for (const [id, controller] of this.active) if (this.db.prepare("SELECT item_id FROM jobs WHERE id=? AND server_id=?").pluck().get(id,this.serverId) === itemId) controller.abort();
		}
	}
	enqueue(itemId: string, episodeId: string, kind: Job["kind"] = "analysis", identity: string | null = null): Job {
		if (!this.enabled(itemId)) throw new Error("consent_required");
		const existing = this.jobs(itemId).find(j=>j.episodeId===episodeId);
		if (existing && ["queued","running"].includes(existing.status)) {
			if (kind==='verify' || existing.kind==='analysis') return existing;
			// User analysis supersedes pending verification, never runs concurrently.
			this.active.get(existing.id)?.abort();
		} else {
			const count=this.db.prepare("SELECT count(*) FROM jobs WHERE server_id=? AND status IN ('queued','running')").pluck().get(this.serverId) as number;
			if(count>=32) {
				const evict=kind==='analysis' ? this.db.prepare("SELECT id FROM jobs WHERE server_id=? AND kind='verify' AND status='queued' ORDER BY created_at DESC,id DESC LIMIT 1").pluck().get(this.serverId) : undefined;
				if(!evict)throw new Error('queue_full');
				this.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(evict);
			}
		}
		this.db.prepare("INSERT INTO jobs(server_id,item_id,episode_id,kind,identity,status,created_at) VALUES(?,?,?,?,?,'queued',?) ON CONFLICT(server_id,item_id,episode_id) DO UPDATE SET kind=excluded.kind,identity=excluded.identity,status='queued',attempts=0,error=NULL,created_at=excluded.created_at").run(this.serverId,itemId,episodeId,kind,identity,Date.now());
		return this.jobs(itemId).find(j=>j.episodeId===episodeId)!;
	}
	observeSources(itemId: string, item: unknown): void {
		const parsed=z.object({media:z.object({episodes:z.array(z.object({id:z.string()}).passthrough())})}).safeParse(item);
		const episodes=new Map(parsed.success?parsed.data.media.episodes.map(ep=>[ep.id,fileIdentity(ep)]):[]);
		for(const row of this.db.prepare("SELECT episode_id,identity,verified_identity FROM results WHERE server_id=? AND item_id=?").all(this.serverId,itemId) as Array<{episode_id:string;identity:string|null;verified_identity:string|null}>) {
			const identity=episodes.get(row.episode_id)??null;
			if(identity!==row.identity) {
				this.db.prepare("UPDATE results SET identity=?,applicable=0 WHERE server_id=? AND item_id=? AND episode_id=?").run(identity,this.serverId,itemId,row.episode_id);
				const job=this.jobs(itemId).find(j=>j.episodeId===row.episode_id&&j.kind==='verify'&&j.status!=='complete');
				if(job){this.active.get(job.id)?.abort();this.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);}
			}
			if(identity&&identity===row.verified_identity)this.db.prepare("UPDATE results SET applicable=CASE WHEN needs_analysis=0 AND status IN ('candidates','no_difference','complete') THEN 1 ELSE 0 END WHERE server_id=? AND item_id=? AND episode_id=?").run(this.serverId,itemId,row.episode_id);
			if(!identity||identity!==row.verified_identity)this.db.prepare("UPDATE results SET applicable=0 WHERE server_id=? AND item_id=? AND episode_id=?").run(this.serverId,itemId,row.episode_id);
		}
		this.fillQueue();
	}
	private fillQueue(): void {
		const rows=this.db.prepare("SELECT r.item_id,r.episode_id,r.identity,r.needs_analysis FROM results r JOIN consent c ON c.server_id=r.server_id AND c.item_id=r.item_id WHERE r.server_id=? AND c.enabled=1 AND (r.needs_analysis=1 OR (r.version='migration-v1' AND r.identity IS NULL AND r.verified_identity IS NULL) OR (r.identity IS NOT NULL AND (r.verified_identity IS NULL OR r.identity<>r.verified_identity))) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.server_id=r.server_id AND j.item_id=r.item_id AND j.episode_id=r.episode_id AND j.status IN ('queued','running','failed','interrupted')) ORDER BY r.needs_analysis DESC,r.item_id,r.episode_id LIMIT 33").all(this.serverId) as Array<{item_id:string;episode_id:string;identity:string;needs_analysis:number}>;
		for(const row of rows)try{this.enqueue(row.item_id,row.episode_id,row.needs_analysis?'analysis':'verify',row.identity);}catch(error){if(error instanceof Error&&error.message==='queue_full')break;throw error;}
	}
	verifySource(itemId: string, episodeId: string, sourceSha256: string, identity?: string): void {
		if (!/^[a-f0-9]{64}$/i.test(sourceSha256)) throw new Error('invalid_source_hash');
		const row=this.db.prepare("SELECT source_sha,segments,identity,status,version FROM results WHERE server_id=? AND item_id=? AND episode_id=?").get(this.serverId,itemId,episodeId) as {source_sha:string;segments:string;identity:string|null;status:string;version:string}|undefined;
		if(!row || (identity!==undefined&&row.identity!==null&&identity!==row.identity))return;
		const match=row.source_sha===sourceSha256 && (['complete','candidates','no_difference'].includes(row.status)||row.version==='migration-v1');
		this.db.prepare("UPDATE results SET identity=COALESCE(identity,?),verified_identity=?,applicable=?,status=?,needs_analysis=? WHERE server_id=? AND item_id=? AND episode_id=?").run(identity??null,identity??null,Number(match&&this.enabled(itemId)),match?(JSON.parse(row.segments).length?'candidates':'no_difference'):'stale',Number(!match),this.serverId,itemId,episodeId);
		// Current verify completes before durable reanalysis admission in next pump iteration.
		this.db.prepare("UPDATE jobs SET status='complete' WHERE server_id=? AND item_id=? AND episode_id=? AND kind='verify'").run(this.serverId,itemId,episodeId);
		if(!match&&this.enabled(itemId))this.fillQueue();
	}
	analysis(itemId: string): Record<string, EpisodeResult> {
		const rows = this.db.prepare("SELECT episode_id,source_sha,version,segments,applicable,status FROM results WHERE server_id=? AND item_id=?").all(this.serverId, itemId) as Array<{episode_id:string;source_sha:string;version:string;segments:string;applicable:number;status:string}>;
		return Object.fromEntries(rows.map(row => { const valid = Boolean(row.applicable) && this.enabled(itemId); const segments = JSON.parse(row.segments) as Segment[]; return [row.episode_id, { status: valid ? row.status : "stale", version: row.version, sourceSha256: row.source_sha, segments: valid ? segments : [], adAnalysisEnabled: this.enabled(itemId), applicable: valid }]; }));
	}
	jobs(itemId: string): Job[] { return this.db.prepare("SELECT id,item_id AS itemId,episode_id AS episodeId,kind,identity,status,attempts,error FROM jobs WHERE server_id=? AND item_id=? ORDER BY created_at,id").all(this.serverId,itemId) as Job[]; }
	corpus(itemId: string): object { return { itemId, results: this.analysis(itemId) }; }
	setResult(itemId: string, episodeId: string, result: EpisodeResult, identity: string | null = null): void {
		if (!this.enabled(itemId) || !result.adAnalysisEnabled) throw new Error("analysis_disabled");
		let end = -Infinity;
		for (const segment of result.segments) {
			if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.start < end) throw new Error("invalid_segments");
			end = segment.end;
		}
		this.db.prepare("INSERT INTO results(server_id,item_id,episode_id,source_sha,version,segments,applicable,status) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,item_id,episode_id) DO UPDATE SET source_sha=excluded.source_sha,version=excluded.version,segments=excluded.segments,applicable=excluded.applicable,status=excluded.status").run(this.serverId,itemId,episodeId,result.sourceSha256,result.version,JSON.stringify(result.segments),Number(result.applicable),result.status);
		this.db.prepare("UPDATE results SET identity=?,verified_identity=?,needs_analysis=0 WHERE server_id=? AND item_id=? AND episode_id=?").run(identity,identity,this.serverId,itemId,episodeId);
	}
	invalidateSource(itemId: string, episodeId: string, sourceSha: string): void {
		this.db.prepare("UPDATE results SET applicable=0,status='stale' WHERE server_id=? AND item_id=? AND episode_id=? AND source_sha<>?").run(this.serverId,itemId,episodeId,sourceSha);
		this.db.prepare("UPDATE jobs SET status='cancelled' WHERE server_id=? AND item_id=? AND episode_id=? AND status IN ('queued','running')").run(this.serverId,itemId,episodeId);
		for (const [id, controller] of this.active) if (this.db.prepare("SELECT item_id FROM jobs WHERE id=? AND server_id=? AND episode_id=?").pluck().get(id,this.serverId,episodeId) === itemId) controller.abort();
	}
	async start(worker: (job: Job, signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.worker) return this.pump;
		const controller = new AbortController(); this.worker = controller;
		const pump = async (): Promise<void> => {
			while (!controller.signal.aborted) {
				this.fillQueue();
				const job = this.db.prepare("SELECT id,item_id AS itemId,episode_id AS episodeId,kind,identity,status,attempts,error FROM jobs WHERE server_id=? AND status='queued' ORDER BY CASE kind WHEN 'analysis' THEN 0 ELSE 1 END,created_at,id LIMIT 1").get(this.serverId) as Job | undefined;
				if (job && this.enabled(job.itemId)) {
					const child = new AbortController(); this.active.set(job.id, child);
					this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id);
					try { await worker(job, child.signal); if (!child.signal.aborted) this.db.prepare("UPDATE jobs SET status='complete',error=NULL WHERE id=? AND kind=? AND status='running'").run(job.id,job.kind); }
					catch (error) { if (!child.signal.aborted && !controller.signal.aborted) this.db.prepare("UPDATE jobs SET status=CASE WHEN attempts<2 THEN 'queued' ELSE 'failed' END,error=? WHERE id=? AND status='running'").run(String(error), job.id); }
					finally { this.active.delete(job.id); }
				} else await new Promise(resolve => setTimeout(resolve, 100));
			}
		};
		this.pump = pump().finally(() => { this.pump = undefined; });
		return this.pump;
	}
	startScheduler(): void {
		if (!this.scheduler || this.timer) return;
		const run = (): void => {
			if (this.scheduling) return;
			this.scheduling = true;
			const controller = this.worker ?? new AbortController();
			this.schedulerAbort = controller;
			this.schedulerRun = this.scheduler?.(this, controller.signal).catch(() => { console.error('scheduler_failed'); }).finally(() => { this.scheduling = false; this.schedulerRun = undefined; this.schedulerAbort = undefined; });
		};
		run(); this.timer = setInterval(run, this.intervalMs);
	}
	stop(): void { this.worker?.abort(); this.worker = undefined; this.schedulerAbort?.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const controller of this.active.values()) controller.abort(); }
	async close(): Promise<void> { this.stop(); if (this.pump || this.schedulerRun) await Promise.all([this.pump, this.schedulerRun]); this.db.close(); }
}
