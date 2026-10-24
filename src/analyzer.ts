import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import type { AnalysisCorpus } from "./corpus";
import { normalize, matchesEpisode, PERIOD, DELAY } from "../vendor/daiAlignment.js";
import { catalogEndpoint, catalogResults, type CatalogItem, type EpisodeLike } from "./analyzerTransport";

type AnalysisEpisode = Pick<EpisodeLike, "guid" | "title" | "publishedAt">;

const run = promisify(execFile);
export const MAX_DURATION = 14_400;
export const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");

type Fingerprint = number[] & { duration?: number };
type Segment = { start: number; end: number; [key: string]: unknown };
export type CandidateResult = { status: string; reason: string | null; segments: Segment[]; samples: Record<string, unknown>[]; catalogs: Record<string, unknown>[]; sourceSha256: string; corpus?: ReturnType<AnalysisCorpus["inventory"]> };

function executable(env: NodeJS.ProcessEnv): string {
	return env.FPCALC_PATH || "fpcalc";
}

export async function fingerprint(file: string, dir: string, label: string, duration: number | null, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<Fingerprint> {
	const fpcalc = executable(env);
	const version = await run(fpcalc, ["-version"], { timeout: 5000, maxBuffer: 4096 });
	if (!/fpcalc version 1\.(5|6)\./.test(version.stdout)) throw new Error("unsupported_runtime");
	const size = (await stat(file)).size;
	if (size > MAX_AUDIO_BYTES) throw new Error("audio_size_limit");
	if (duration !== null && (!Number.isFinite(duration) || duration < 50 || duration > MAX_DURATION)) throw new Error("duration_limit");
	const pcm = join(dir, `${label}.pcm`);
	try {
		await run(env.FFMPEG_PATH || "ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mp3,wav,mov,ogg,flac,aac,matroska,webm,aiff,asf", "-threads", "1", "-i", file, "-map", "0:a:0", "-vn", "-t", String(MAX_DURATION + 1), "-ac", "1", "-ar", "11025", "-f", "s16le", "-fs", String((MAX_DURATION + 1) * 22050), pcm], { signal, killSignal: "SIGKILL", timeout: 180_000, maxBuffer: 65_536 });
		const pcmSize = (await stat(pcm)).size;
		if (pcmSize < 50 * 22_050 || pcmSize >= MAX_DURATION * 22_050 || (duration !== null && Math.abs(pcmSize / 22_050 - duration) > 3)) throw new Error("duration_or_decode_mismatch");
		const out = await run(fpcalc, ["-format", "s16le", "-rate", "11025", "-channels", "1", "-algorithm", "2", "-length", "0", "-raw", "-json", pcm], { signal, killSignal: "SIGKILL", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
		const parsed = JSON.parse(out.stdout) as { fingerprint?: unknown };
		if (!Array.isArray(parsed.fingerprint) || !parsed.fingerprint.every((n) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 0xffff_ffff)) throw new Error("invalid_fingerprint");
		const fp = parsed.fingerprint as Fingerprint;
		const actualDuration = pcmSize / 22_050;
		if (Math.abs(fp.length * PERIOD + DELAY - actualDuration) > 1) throw new Error("incomplete_fingerprint");
		Object.defineProperty(fp, "duration", { value: actualDuration });
		return fp;
	} finally { await rm(pcm, { force: true }); }
}

function runWorker(original: unknown, variant: unknown, signal: AbortSignal): Promise<{ segments: Segment[]; reason: string; matchedSeconds: number }> {
	return new Promise((resolve, reject) => {
		const workerPath = join(__dirname, "../vendor/daiAlignmentWorker.js");
		const worker = new Worker(workerPath, { workerData: { original, variant }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
		const timer = setTimeout(() => { void worker.terminate(); reject(new Error("alignment_timeout")); }, 10_000);
		const cancel = () => { void worker.terminate(); reject(new Error("cancelled")); };
		signal.addEventListener("abort", cancel, { once: true });
		worker.once("message", (value) => resolve(value));
		worker.once("error", reject);
		worker.once("exit", (code) => { clearTimeout(timer); signal.removeEventListener("abort", cancel); if (code) reject(new Error("alignment_failed")); });
	});
}

async function align(originalPath: string, original: Fingerprint, variantPath: unknown, variant: Fingerprint, signal: AbortSignal) {
	let result = await runWorker(originalPath, variantPath, signal).catch(() => null);
	if (!result?.segments.length && result?.reason !== "no_inserted_audio") result = await runWorker(original, variant, signal);
	return result;
}

export interface CandidateTransport {
	/** Must enforce SSRF checks, redirects <=4, TLS verification, deadline and response byte cap. */
	get(url: string, maxBytes: number, timeoutMs: number, signal: AbortSignal): Promise<{ data: Buffer; url: string }>;
	fetchFeed(url: string, signal: AbortSignal): Promise<EpisodeLike[]>;
	candidates(provider: "apple" | "gpodder", item: CatalogItem, signal: AbortSignal): Promise<unknown>;
}

export async function analyzeCandidates(input: { sourcePath: string; sourceSha256?: string; duration: number; episodeId: string; itemId: string; episode: AnalysisEpisode; item: CatalogItem; transport: CandidateTransport; corpus: AnalysisCorpus; signal: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<CandidateResult> {
	const { sourcePath, duration, episode, item, transport, signal } = input;
	const env = input.env || process.env;
	const sourceStat = await stat(sourcePath);
	if (!sourceStat.isFile() || sourceStat.size > MAX_AUDIO_BYTES) throw new Error("audio_size_limit");
	if (input.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sourceSha256)) throw new Error('invalid_source_hash');
	const sourceHash = input.sourceSha256 ?? hash(await readFile(sourcePath));
	const dir = await mkdtemp(join(tmpdir(), "psb-dai-"));
	const out: CandidateResult = { status: "running", reason: null, segments: [], samples: [], catalogs: [], sourceSha256: sourceHash };
	try {
		const original = await fingerprint(sourcePath, dir, "original", duration, signal, env);
		out.samples.push({ origin: "subscribed", route: "direct", fingerprintSha256: hash(JSON.stringify(original)) });
		const fingerprints = new Set([hash(JSON.stringify(original))]);
		const inventory = input.corpus.inventory(input.itemId, input.episodeId);
		out.corpus = inventory;
		for (const saved of input.corpus.load(input.itemId, input.episodeId).versions) {
			if (signal.aborted) throw new Error("cancelled");
			const compared = await align(sourcePath, original, saved.frames, saved.fingerprint, signal);
			const savedFpHash = saved.fingerprintSha256;
			out.samples.push({ origin: saved.provider, route: saved.route, versionId: saved.versionId, sha256: saved.sha256, fingerprintSha256: savedFpHash, retained: true, method: compared.reason === "no_inserted_audio" ? "mpeg_frames" : "chromaprint", status: compared.reason });
			fingerprints.add(savedFpHash);
			out.segments.push(...compared.segments.map((s) => ({ ...s, sampleIndex: out.samples.length - 1 })));
		}
		const feedCache = new Map<string, EpisodeLike[]>();
		const urls = new Set<string>();
		let extras = 0;
		for (const provider of ["apple", "gpodder"] as const) {
			if (signal.aborted) throw new Error("cancelled");
			const catalog = { provider, status: "empty" } as Record<string, unknown>;
			out.catalogs.push(catalog);
			try {
				const rows = catalogResults(provider, await transport.candidates(provider, item, signal));
				catalog.status = rows.length ? "no_matching_episode" : "empty";
				let providerFeeds = 0;
				for (const row of rows) {
					if (normalize(row.title) !== normalize(item.title) || (item.author && normalize(row.author || "") && normalize(row.author || "") !== normalize(item.author))) continue;
					let feed = feedCache.get(row.url);
					if (!feed) {
						if (providerFeeds >= 2 || feedCache.size >= 4) continue;
						providerFeeds++;
						feed = await transport.fetchFeed(row.url, signal);
						feedCache.set(row.url, feed);
					}
					const matches = feed.filter((ep) => matchesEpisode(episode, ep));
					if (matches.length !== 1 || extras >= 2) continue;
					extras++;
					const url = matches[0].enclosure.url;
					const response = await transport.get(url, MAX_AUDIO_BYTES, 120_000, signal);
					if (response.data.length > MAX_AUDIO_BYTES) throw new Error("response_too_large");
					const samplePath = join(dir, `sample${extras}`);
					await writeFile(samplePath, response.data, { flag: "wx" });
					const variant = await fingerprint(samplePath, dir, `variant${extras}`, null, signal, env);
					const fpHash = hash(JSON.stringify(variant));
					const retained = input.corpus.retain({ showKey: input.itemId, episodeKey: input.episodeId, data: response.data, fingerprint: variant, duration: variant.duration || 0, provider, route: "direct" });
					const sample = { origin: provider, route: "direct", requestAttempt: extras, repeatedUrl: urls.has(url), sha256: hash(response.data), fingerprintSha256: fpHash, collectionStatus: retained.status, versionId: retained.versionId, status: "compared" };
					urls.add(url); urls.add(response.url); out.samples.push(sample);
					fingerprints.add(fpHash);
					const comparison = await align(sourcePath, original, samplePath, variant, signal);
					sample.status = comparison.reason;
					out.segments.push(...comparison.segments.map((s) => ({ ...s, sampleIndex: out.samples.length - 1 })));
					catalog.status = "sampled";
					break;
				}
			} catch (error) {
				catalog.status = "failed";
				catalog.reason = error instanceof Error ? error.message : "request_failed";
			}
		}
		out.segments.sort((a, b) => a.start - b.start);
		out.segments = out.segments.filter((s, i, all) => i === 0 || s.start >= all[i - 1].end);
		const compared = out.samples.some((s) => s.status === "no_inserted_audio" || s.status === "inserted_audio");
		out.status = out.segments.length ? "candidates" : compared ? "no_difference" : out.catalogs.length && out.catalogs.every((c) => ["empty", "no_matching_episode"].includes(String(c.status))) ? "unsupported" : "inconclusive";
		out.reason = out.segments.length ? "candidate_insertions_not_advertising_proof" : out.status === "no_difference" ? "no_inserted_audio" : out.status === "unsupported" ? "no_matching_episode" : fingerprints.size < 2 ? "insufficient_diversity" : "no_safe_candidates";
		return out;
	} catch (error) { out.status = "failed"; out.reason = error instanceof Error ? error.message : "analysis_failed"; out.segments = []; return out; }
	finally {
		await rm(dir, { recursive: true, force: true });
		const after = await stat(sourcePath).catch(() => null);
		if (!after || after.size !== sourceStat.size || after.mtimeMs !== sourceStat.mtimeMs) { out.status = "stale"; out.reason = "source_changed"; out.segments = []; }
	}
}

export { catalogEndpoint, request, MAX_FEED_BYTES } from "./analyzerTransport";
