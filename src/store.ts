import Database from "better-sqlite3";

export type Segment = { start: number; end: number };
export type EpisodeResult = { status: string; version: string; sourceSha256: string; segments: Segment[]; adAnalysisEnabled: boolean; applicable: boolean };
export type Job = { id: number; itemId: string; episodeId: string; status: string; attempts: number; error?: string };
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
	enqueue(itemId: string, episodeId: string): Job {
		if (!this.enabled(itemId)) throw new Error("consent_required");
		const existing = this.db.prepare("SELECT id,item_id AS itemId,episode_id AS episodeId,status,attempts,error FROM jobs WHERE server_id=? AND item_id=? AND episode_id=?").get(this.serverId,itemId,episodeId) as Job | undefined;
		if (existing) {
			if (!["complete", "failed", "cancelled"].includes(existing.status)) return existing;
		}
		const count = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE server_id=? AND status IN ('queued','running')").get(this.serverId) as { n: number };
		if (count.n >= 32) throw new Error("queue_full");
		if (existing) this.db.prepare("UPDATE jobs SET status='queued',attempts=0,error=NULL,created_at=? WHERE id=?").run(Date.now(),existing.id);
		const result = existing ? { lastInsertRowid: BigInt(existing.id) } : this.db.prepare("INSERT INTO jobs(server_id,item_id,episode_id,status,created_at) VALUES(?,?,?,'queued',?)").run(this.serverId,itemId,episodeId,Date.now());
		return this.db.prepare("SELECT id,item_id AS itemId,episode_id AS episodeId,status,attempts,error FROM jobs WHERE id=?").get(result.lastInsertRowid) as Job;
	}
	verifySource(itemId: string, episodeId: string, sourceSha256: string): void {
		if (!/^[a-f0-9]{64}$/i.test(sourceSha256)) {
			this.invalidateSource(itemId, episodeId, "");
			return;
		}
		const result = this.db.prepare("SELECT source_sha,segments FROM results WHERE server_id=? AND item_id=? AND episode_id=?").get(this.serverId,itemId,episodeId) as {source_sha:string;segments:string} | undefined;
		if (result && result.source_sha.toLowerCase() === sourceSha256.toLowerCase() && this.enabled(itemId)) {
			const segments = JSON.parse(result.segments) as Segment[];
			this.db.prepare("UPDATE results SET applicable=1,status=? WHERE server_id=? AND item_id=? AND episode_id=?").run(segments.length ? "candidates" : "no_difference",this.serverId,itemId,episodeId);
			return;
		}
		this.invalidateSource(itemId, episodeId, sourceSha256.toLowerCase());
		if (this.enabled(itemId)) {
			try { this.enqueue(itemId, episodeId); } catch (error) { if (!(error instanceof Error) || error.message !== "queue_full") throw error; }
		}
	}
	analysis(itemId: string): Record<string, EpisodeResult> {
		const rows = this.db.prepare("SELECT episode_id,source_sha,version,segments,applicable,status FROM results WHERE server_id=? AND item_id=?").all(this.serverId, itemId) as Array<{episode_id:string;source_sha:string;version:string;segments:string;applicable:number;status:string}>;
		return Object.fromEntries(rows.map(row => { const valid = Boolean(row.applicable) && this.enabled(itemId); const segments = JSON.parse(row.segments) as Segment[]; return [row.episode_id, { status: valid ? row.status : "stale", version: row.version, sourceSha256: row.source_sha, segments: valid ? segments : [], adAnalysisEnabled: this.enabled(itemId), applicable: valid }]; }));
	}
	jobs(itemId: string): Job[] { return this.db.prepare("SELECT id,item_id AS itemId,episode_id AS episodeId,status,attempts,error FROM jobs WHERE server_id=? AND item_id=? ORDER BY created_at,id").all(this.serverId,itemId) as Job[]; }
	corpus(itemId: string): object { return { itemId, results: this.analysis(itemId) }; }
	setResult(itemId: string, episodeId: string, result: EpisodeResult): void {
		if (!this.enabled(itemId) || !result.adAnalysisEnabled) throw new Error("analysis_disabled");
		let end = -Infinity;
		for (const segment of result.segments) {
			if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.start < end) throw new Error("invalid_segments");
			end = segment.end;
		}
		this.db.prepare("INSERT INTO results(server_id,item_id,episode_id,source_sha,version,segments,applicable,status) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,item_id,episode_id) DO UPDATE SET source_sha=excluded.source_sha,version=excluded.version,segments=excluded.segments,applicable=excluded.applicable,status=excluded.status").run(this.serverId,itemId,episodeId,result.sourceSha256,result.version,JSON.stringify(result.segments),Number(result.applicable),result.status);
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
				const job = this.db.prepare("SELECT id,item_id AS itemId,episode_id AS episodeId,status,attempts,error FROM jobs WHERE server_id=? AND status='queued' ORDER BY created_at,id LIMIT 1").get(this.serverId) as Job | undefined;
				if (job && this.enabled(job.itemId)) {
					const child = new AbortController(); this.active.set(job.id, child);
					this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id);
					try { await worker(job, child.signal); if (!child.signal.aborted) this.db.prepare("UPDATE jobs SET status='complete',error=NULL WHERE id=? AND status='running'").run(job.id); }
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
