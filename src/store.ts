import Database from 'better-sqlite3';
import { z } from 'zod';

export const DETECTOR_VERSION = '1';
export function fileIdentity(episode: unknown): string | null {
	const parsed = z.object({ audioFile: z.object({ ino: z.union([z.string().min(1), z.number().int().safe()]), metadata: z.object({ size: z.number().int().safe().nonnegative(), mtimeMs: z.number().finite().nonnegative() }) }) }).safeParse(episode);
	return parsed.success ? JSON.stringify([String(parsed.data.audioFile.ino), parsed.data.audioFile.metadata.size, parsed.data.audioFile.metadata.mtimeMs]) : null;
}
export type Segment = { start: number; end: number };
export type EpisodeResult = { status: string; version: string; sourceSha256: string; segments: Segment[]; adAnalysisEnabled: boolean; applicable: boolean };
export type ContentResult = { detectorVersion: string; status: string; segments: Segment[] };
export type Job = { id: number; itemId: string; episodeId: string; status: string; attempts: number; analysisRuns: number; priority: number; error?: string };
export type Resolved = { showKey: string; episodes: Array<{ id: string; episodeKey: string; identity: string | null }> };
export type StoreOptions = { scheduler?: (store: Store, signal: AbortSignal) => Promise<void>; intervalMs?: number };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(16384);
const resultSchema = z.object({ status: z.string().min(1).max(256), segments: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).strict()).max(10000) }).strict();

export class Store {
	private db: Database.Database;
	private active = new Map<number, AbortController>();
	private worker?: AbortController;
	private timer?: NodeJS.Timeout;
	private scheduling = false;
	private pump?: Promise<void>;
	private schedulerRun?: Promise<void>;
	private schedulerAbort?: AbortController;
	constructor(path: string, private options: StoreOptions = {}) {
		this.db = new Database(path);
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('foreign_keys = ON');
		// Fresh schema only. Refuse legacy data instead of silently mixing identity models.
		if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='results'").get()) { this.db.close(); throw new Error('fresh_database_required'); }
		this.db.exec(`CREATE TABLE IF NOT EXISTS consent(show_key TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
			CREATE TABLE IF NOT EXISTS episode_cache(item_id TEXT NOT NULL,episode_id TEXT NOT NULL,show_key TEXT NOT NULL,episode_key TEXT NOT NULL,file_identity TEXT,PRIMARY KEY(item_id,episode_id));
			CREATE TABLE IF NOT EXISTS file_hash_cache(file_identity TEXT PRIMARY KEY,audio_sha256 TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS content_results(audio_sha256 TEXT NOT NULL,detector_version TEXT NOT NULL,status TEXT NOT NULL,segments TEXT NOT NULL,PRIMARY KEY(audio_sha256,detector_version));
			CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL,episode_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,analysis_runs INTEGER NOT NULL DEFAULT 0,priority INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,UNIQUE(item_id,episode_id));
			CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status,priority,created_at);
			CREATE TABLE IF NOT EXISTS scheduler_state(library_id TEXT PRIMARY KEY,page INTEGER NOT NULL CHECK(page>=0));`);
		this.db.prepare("UPDATE jobs SET status=CASE WHEN attempts<2 THEN 'queued' ELSE 'interrupted' END WHERE status='running'").run();
	}
	observeResolved(itemId: string, resolved: Resolved): void {
		key.parse(itemId); key.parse(resolved.showKey);
		const episodes = z.array(z.object({ id: key, episodeKey: key, identity: key.nullable() }).strict()).max(100000).parse(resolved.episodes);
		this.db.transaction(() => {
			const existing = this.db.prepare('SELECT episode_id,file_identity,episode_key FROM episode_cache WHERE item_id=?').all(itemId) as Array<{episode_id:string;file_identity:string|null;episode_key:string}>;
			for (const old of existing) {
				const current = episodes.find(e => e.id === old.episode_id);
				if (!current || current.identity !== old.file_identity || current.episodeKey !== old.episode_key) {
					for (const job of this.jobs(itemId).filter(j => j.episodeId === old.episode_id)) this.active.get(job.id)?.abort();
					this.db.prepare('DELETE FROM jobs WHERE item_id=? AND episode_id=?').run(itemId, old.episode_id);
				}
			}
			this.db.prepare('DELETE FROM episode_cache WHERE item_id=?').run(itemId);
			for (const episode of episodes) this.db.prepare('INSERT INTO episode_cache VALUES(?,?,?,?,?)').run(itemId, episode.id, resolved.showKey, episode.episodeKey, episode.identity);
		})();
	}
	resolution(itemId: string, episodeId?: string): { showKey: string; episodeKey: string; identity: string | null } | undefined {
		return (episodeId === undefined ? this.db.prepare('SELECT show_key AS showKey,episode_key AS episodeKey,file_identity AS identity FROM episode_cache WHERE item_id=? LIMIT 1').get(itemId) : this.db.prepare('SELECT show_key AS showKey,episode_key AS episodeKey,file_identity AS identity FROM episode_cache WHERE item_id=? AND episode_id=?').get(itemId, episodeId)) as {showKey:string;episodeKey:string;identity:string|null}|undefined;
	}
	enabled(itemId: string): boolean { const r = this.resolution(itemId); return !!r && this.showEnabled(r.showKey); }
	showEnabled(showKey: string): boolean { return !!this.db.prepare('SELECT enabled FROM consent WHERE show_key=?').pluck().get(showKey); }
	setEnabled(itemId: string, enabled: boolean): void {
		const r = this.resolution(itemId); if (!r) throw new Error('episode_resolution_required');
		this.db.prepare('INSERT INTO consent VALUES(?,?) ON CONFLICT(show_key) DO UPDATE SET enabled=excluded.enabled').run(r.showKey, Number(enabled));
		if (!enabled) for (const job of this.db.prepare("SELECT j.id FROM jobs j JOIN episode_cache e ON e.item_id=j.item_id AND e.episode_id=j.episode_id WHERE e.show_key=? AND j.status IN ('queued','running')").all(r.showKey) as Array<{id:number}>) {
			this.active.get(job.id)?.abort(); this.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);
		}
	}
	schedulerPage(libraryId: string): number { return (this.db.prepare('SELECT page FROM scheduler_state WHERE library_id=?').pluck().get(libraryId) as number|undefined) ?? 0; }
	setSchedulerPage(libraryId: string, page: number): void { z.number().int().safe().nonnegative().parse(page); this.db.prepare('INSERT INTO scheduler_state VALUES(?,?) ON CONFLICT(library_id) DO UPDATE SET page=excluded.page').run(libraryId, page); }
	cachedHash(itemId: string, episodeId: string): string | undefined {
		return this.db.prepare('SELECT h.audio_sha256 FROM episode_cache e JOIN file_hash_cache h ON h.file_identity=e.file_identity WHERE e.item_id=? AND e.episode_id=?').pluck().get(itemId, episodeId) as string|undefined;
	}
	cacheHash(itemId: string, episodeId: string, identity: string, sha: string): void {
		hash.parse(sha); key.parse(identity);
		if (this.resolution(itemId, episodeId)?.identity !== identity) throw new Error('source_changed');
		this.db.prepare('INSERT INTO file_hash_cache VALUES(?,?) ON CONFLICT(file_identity) DO UPDATE SET audio_sha256=excluded.audio_sha256').run(identity, sha);
	}
	content(sha: string): ContentResult | undefined {
		hash.parse(sha);
		const row = this.db.prepare('SELECT status,segments FROM content_results WHERE audio_sha256=? AND detector_version=?').get(sha, DETECTOR_VERSION) as {status:string;segments:string}|undefined;
		return row ? { detectorVersion: DETECTOR_VERSION, status: row.status, segments: JSON.parse(row.segments) as Segment[] } : undefined;
	}
	setContent(sha: string, input: Omit<ContentResult, 'detectorVersion'>): void {
		hash.parse(sha); const result = resultSchema.parse(input); let end = -Infinity;
		for (const segment of result.segments) { if (segment.end <= segment.start || segment.start < end) throw new Error('invalid_segments'); end = segment.end; }
		if (!['candidates','no_difference'].includes(result.status) && result.segments.length) throw new Error('invalid_segments');
		this.db.prepare('INSERT INTO content_results VALUES(?,?,?,?) ON CONFLICT(audio_sha256,detector_version) DO NOTHING').run(sha, DETECTOR_VERSION, result.status, JSON.stringify(result.segments));
	}
	analysis(itemId: string): Record<string, EpisodeResult> {
		const rows = this.db.prepare('SELECT e.episode_id,h.audio_sha256,r.status,r.segments FROM episode_cache e JOIN file_hash_cache h ON h.file_identity=e.file_identity JOIN content_results r ON r.audio_sha256=h.audio_sha256 AND r.detector_version=? WHERE e.item_id=?').all(DETECTOR_VERSION, itemId) as Array<{episode_id:string;audio_sha256:string;status:string;segments:string}>;
		return Object.fromEntries(rows.map(row => { const enabled = this.enabled(itemId); const applicable = enabled && ['candidates','no_difference'].includes(row.status); return [row.episode_id, { status: enabled ? row.status : 'stale', version: DETECTOR_VERSION, sourceSha256: row.audio_sha256, segments: applicable ? JSON.parse(row.segments) as Segment[] : [], adAnalysisEnabled: enabled, applicable }]; }));
	}
	jobs(itemId: string): Job[] { return this.db.prepare('SELECT id,item_id AS itemId,episode_id AS episodeId,status,attempts,analysis_runs AS analysisRuns,priority,error FROM jobs WHERE item_id=? ORDER BY created_at,id').all(itemId) as Job[]; }
	enqueue(itemId: string, episodeId: string, priority = 1): Job {
		key.parse(itemId); key.parse(episodeId); z.number().int().min(0).max(1).parse(priority);
		if (!this.enabled(itemId)) throw new Error('consent_required');
		if (!this.resolution(itemId, episodeId)?.identity) throw new Error('source_identity_unavailable');
		const existing = this.jobs(itemId).find(j => j.episodeId === episodeId);
		if (existing && ['queued','running'].includes(existing.status)) return existing;
		if ((this.db.prepare("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").pluck().get() as number) >= 32) {
			const evict = priority === 1 ? this.db.prepare("SELECT id FROM jobs WHERE priority=0 AND status='queued' ORDER BY created_at DESC,id DESC LIMIT 1").pluck().get() : undefined;
			if (!evict) throw new Error('queue_full');
			this.db.prepare('DELETE FROM jobs WHERE id=?').run(evict);
		}
		this.db.prepare("INSERT INTO jobs(item_id,episode_id,status,priority,created_at) VALUES(?,?,'queued',?,?) ON CONFLICT(item_id,episode_id) DO UPDATE SET status='queued',attempts=0,error=NULL,priority=excluded.priority,created_at=excluded.created_at").run(itemId, episodeId, priority, Date.now());
		return this.jobs(itemId).find(j => j.episodeId === episodeId)!;
	}
	markAnalysis(id: number): void { this.db.prepare("UPDATE jobs SET analysis_runs=analysis_runs+1 WHERE id=? AND status='running'").run(id); }
	async start(worker: (job: Job, signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.worker) return this.pump;
		const controller = new AbortController(); this.worker = controller;
		this.pump = (async () => {
			while (!controller.signal.aborted) {
				const job = this.db.prepare("SELECT j.id,j.item_id AS itemId,j.episode_id AS episodeId,j.status,j.attempts,j.analysis_runs AS analysisRuns,j.priority,j.error FROM jobs j JOIN episode_cache e ON e.item_id=j.item_id AND e.episode_id=j.episode_id JOIN consent c ON c.show_key=e.show_key WHERE j.status='queued' AND c.enabled=1 ORDER BY j.priority DESC,j.created_at,j.id LIMIT 1").get() as Job|undefined;
				if (!job) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
				const child = new AbortController(); this.active.set(job.id, child);
				this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id);
				try { await worker(job, child.signal); if (!child.signal.aborted) this.db.prepare("UPDATE jobs SET status='complete',error=NULL WHERE id=? AND status='running'").run(job.id); }
				catch (error) { if (!child.signal.aborted && !controller.signal.aborted) this.db.prepare("UPDATE jobs SET status=CASE WHEN attempts<2 THEN 'queued' ELSE 'failed' END,error=? WHERE id=? AND status='running'").run(String(error), job.id); }
				finally { this.active.delete(job.id); }
			}
		})().finally(() => { this.pump = undefined; });
		return this.pump;
	}
	startScheduler(): void {
		if (!this.options.scheduler || this.timer) return;
		const run = (): void => {
			if (this.scheduling) return; this.scheduling = true;
			const controller = new AbortController(); this.schedulerAbort = controller;
			this.schedulerRun = this.options.scheduler!(this, controller.signal).catch(() => { console.error('scheduler_failed'); }).finally(() => { this.scheduling = false; this.schedulerRun = undefined; this.schedulerAbort = undefined; });
		};
		run(); this.timer = setInterval(run, this.options.intervalMs ?? 120000);
	}
	stop(): void { this.worker?.abort(); this.worker = undefined; this.schedulerAbort?.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const controller of this.active.values()) controller.abort(); }
	async close(): Promise<void> { this.stop(); await Promise.all([this.pump, this.schedulerRun]); this.db.close(); }
}
