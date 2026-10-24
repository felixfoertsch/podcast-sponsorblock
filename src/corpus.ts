import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { encodeFrames, decodeFrames } from "../vendor/mpegFrameAlignment.js";

const ALGORITHM = "chromaprint-test2-inward-v1";
const MAX_FP = 2 * 1024 * 1024;
const MAX_FRAMES = 24 * 1024 * 1024;
const DEFAULT_LIMIT = 10 * 1024 * 1024 * 1024;
const digest = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const validId = (v: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(v);
export type CorpusVersion = { version: 2; versionId: string; itemId: string; episodeId: string; algorithm: string; sha256: string; fingerprintSha256: string; provider: string; route: string; collectedAt: string; duration: number; audioBytes: number; fingerprintBytes: number; frameBytes: number; frameSha256: string; format: "mpeg-frames-v1"; fingerprint: number[]; frames: ReturnType<typeof decodeFrames> };

export class AnalysisCorpus {
	private db: Database.Database;
	constructor(path: string, private limitBytes = DEFAULT_LIMIT) {
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = FULL");
		this.db.pragma("foreign_keys = ON");
		this.db.exec(`CREATE TABLE IF NOT EXISTS analysis_corpus_versions (
			version_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, episode_id TEXT NOT NULL,
			algorithm TEXT NOT NULL, sha256 TEXT NOT NULL, fingerprint_sha256 TEXT NOT NULL,
			provider TEXT NOT NULL, route TEXT NOT NULL, collected_at TEXT NOT NULL,
			duration REAL NOT NULL, audio_bytes INTEGER NOT NULL, fingerprint BLOB NOT NULL,
			frames BLOB NOT NULL, frame_sha256 TEXT NOT NULL,
			UNIQUE(item_id, episode_id, sha256), UNIQUE(item_id, episode_id, fingerprint_sha256)
		);
		CREATE INDEX IF NOT EXISTS analysis_corpus_episode ON analysis_corpus_versions(item_id, episode_id);`);
	}
	close() { this.db.close(); }
	inventory(itemId: string, episodeId: string) {
		if (!validId(itemId) || !validId(episodeId)) throw new Error("corpus_invalid_id");
		const all = this.db.prepare("SELECT length(fingerprint) + length(frames) + length(version_id) + 4096 AS bytes FROM analysis_corpus_versions").all() as Array<{ bytes: number }>;
		const rows = this.db.prepare("SELECT version_id, item_id, episode_id, algorithm, sha256, fingerprint_sha256, provider, route, collected_at, duration, audio_bytes, length(fingerprint) AS fingerprint_bytes, length(frames) AS frame_bytes, frame_sha256 FROM analysis_corpus_versions WHERE item_id = ? AND episode_id = ? ORDER BY collected_at").all(itemId, episodeId) as Array<Record<string, unknown>>;
		const versions = rows.map((row) => ({ version: 2, versionId: row.version_id, itemId: row.item_id, episodeId: row.episode_id, algorithm: row.algorithm, sha256: row.sha256, fingerprintSha256: row.fingerprint_sha256, provider: row.provider, route: row.route, collectedAt: row.collected_at, duration: row.duration, audioBytes: row.audio_bytes, fingerprintBytes: row.fingerprint_bytes, frameBytes: row.frame_bytes, frameSha256: row.frame_sha256, format: "mpeg-frames-v1" }));
		const totalBytes = all.reduce((sum, row) => sum + row.bytes, 0);
		const episodeCount = (this.db.prepare("SELECT COUNT(*) AS count FROM analysis_corpus_versions WHERE item_id = ? AND episode_id = ?").get(itemId, episodeId) as { count: number }).count;
		const reason = episodeCount >= 5 ? "episode_limit" : this.limitBytes - totalBytes < MAX_FP + MAX_FRAMES + 4096 ? "corpus_limit" : null;
		return { version: 2 as const, count: versions.length, totalBytes, limitBytes: this.limitBytes, collectionPaused: !!reason, reason, versions };
	}
	load(itemId: string, episodeId: string) {
		const inventory = this.inventory(itemId, episodeId);
		return { ...inventory, versions: (this.db.prepare("SELECT * FROM analysis_corpus_versions WHERE item_id = ? AND episode_id = ? ORDER BY collected_at").all(itemId, episodeId) as Array<Record<string, unknown>>).map((row) => {
			const fpBytes = row.fingerprint as Buffer;
			const framesBytes = row.frames as Buffer;
			if (fpBytes.length > MAX_FP || framesBytes.length > MAX_FRAMES || digest(fpBytes) !== row.fingerprint_sha256 || digest(framesBytes) !== row.frame_sha256) throw new Error("corpus_invalid");
			const fingerprint = JSON.parse(fpBytes.toString("utf8")) as number[];
			if (!Array.isArray(fingerprint) || !fingerprint.length || fingerprint.length > 120_000 || !fingerprint.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff)) throw new Error("corpus_invalid");
			return { version: 2, versionId: row.version_id, itemId: row.item_id, episodeId: row.episode_id, algorithm: row.algorithm, sha256: row.sha256, fingerprintSha256: row.fingerprint_sha256, provider: row.provider, route: row.route, collectedAt: row.collected_at, duration: row.duration, audioBytes: row.audio_bytes, fingerprintBytes: fpBytes.length, frameBytes: framesBytes.length, frameSha256: row.frame_sha256, format: "mpeg-frames-v1", fingerprint, frames: decodeFrames(framesBytes) } as CorpusVersion;
		}) };
	}
	retain(input: { itemId: string; episodeId: string; data: Buffer; fingerprint: number[]; duration: number; provider: "apple" | "gpodder"; route: "direct" | "vpn_proxy" }) {
		const { itemId, episodeId, data, fingerprint, duration, provider, route } = input;
		if (!validId(itemId) || !validId(episodeId) || !Buffer.isBuffer(data) || !data.length || data.length > 256 * 1024 * 1024 || !Array.isArray(fingerprint) || fingerprint.length < 1 || fingerprint.length > 120_000 || !fingerprint.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff) || !Number.isFinite(duration) || duration < 50 || duration > 14_400) throw new Error("corpus_invalid_input");
		const inv = this.inventory(itemId, episodeId);
		const fingerprintBytes = Buffer.from(JSON.stringify(fingerprint));
		const frames = encodeFrames(data);
		if (!Buffer.isBuffer(frames) || !frames.length || frames.length > MAX_FRAMES || fingerprintBytes.length > MAX_FP) throw new Error("corpus_invalid_input");
		const sha256 = digest(data);
		const fingerprintSha256 = digest(fingerprintBytes);
		const duplicate = this.db.prepare("SELECT version_id FROM analysis_corpus_versions WHERE item_id = ? AND episode_id = ? AND (sha256 = ? OR fingerprint_sha256 = ?)").get(itemId, episodeId, sha256, fingerprintSha256) as { version_id: string } | undefined;
		if (duplicate) return { status: "duplicate", versionId: duplicate.version_id, sha256, fingerprintSha256 };
		if (inv.count >= 5) return { status: "paused", reason: "episode_limit" };
		const versionId = digest(JSON.stringify([itemId, episodeId, sha256, fingerprintSha256]));
		const collectedAt = new Date().toISOString();
		const totalBytes = inv.totalBytes + frames.length + fingerprintBytes.length + 4096;
		if (totalBytes > this.limitBytes) return { status: "paused", reason: "corpus_limit" };
		const tx = this.db.transaction(() => this.db.prepare(`INSERT INTO analysis_corpus_versions (version_id,item_id,episode_id,algorithm,sha256,fingerprint_sha256,provider,route,collected_at,duration,audio_bytes,fingerprint,frames,frame_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(versionId,itemId,episodeId,ALGORITHM,sha256,fingerprintSha256,provider,route,collectedAt,duration,data.length,fingerprintBytes,frames,digest(frames)));
		tx();
		return { status: "retained", versionId, sha256, fingerprintSha256 };
	}
}
