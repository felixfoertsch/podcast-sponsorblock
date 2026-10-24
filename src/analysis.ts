import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { analyzeCandidates, type CandidateTransport, type CandidateResult } from "./analyzer";
export { transport as candidateTransport, catalogEndpoint, catalogResults, request } from "./analyzerTransport";

export type AnalysisJob = {
	serverId: string;
	itemId: string;
	episodeId: string;
	fileId: string;
};

export type Source = { path: string; duration: number; identity: string };
export type Result = { status: string; segments: Array<{ start: number; end: number }> };

/** Stable-client boundary. Implementations must use the requesting user's token. */
export interface AnalysisClient {
	getAuthorizedSource(job: AnalysisJob, signal: AbortSignal): Promise<Source>;
	isEnabled(job: AnalysisJob, signal: AbortSignal): Promise<boolean>;
	publish(job: AnalysisJob, sourceSha256: string, result: Result, signal: AbortSignal): Promise<void>;
}

export type Analyzer = (sourcePath: string, signal: AbortSignal) => Promise<Result>;

export async function analyzePodcastCandidates(input: {
	client: AnalysisClient;
	job: AnalysisJob;
	source: Source;
	episode: import("./analyzerTransport").EpisodeLike;
	item: import("./analyzerTransport").CatalogItem;
	transport: CandidateTransport;
	corpus: import("./corpus").AnalysisCorpus;
	signal: AbortSignal;
	env?: NodeJS.ProcessEnv;
}): Promise<CandidateResult> {
	if (!(await input.client.isEnabled(input.job, input.signal))) throw new Error("analysis_disabled");
	const result = await analyzeCandidates({
		sourcePath: input.source.path,
		duration: input.source.duration,
		itemId: input.job.itemId,
		episodeId: input.job.episodeId,
		episode: input.episode,
		item: input.item,
		transport: input.transport,
		corpus: input.corpus,
		signal: input.signal,
		env: input.env,
	});
	if (input.signal.aborted) throw new Error("cancelled");
	await input.client.publish(input.job, result.sourceSha256, result, input.signal);
	return result;
}

const MAX_AUDIO_BYTES = 256 * 1024 * 1024;

/** One local source per job; never persists audio or accepts remote paths from callers. */
export async function analyzeEpisode(
	client: AnalysisClient,
	analyzer: Analyzer,
	job: AnalysisJob,
	signal: AbortSignal,
): Promise<Result> {
	const source = await client.getAuthorizedSource(job, signal);
	if (!source.path.startsWith("/")) throw new Error("source_path_must_be_absolute");
	const info = await stat(source.path);
	if (!info.isFile() || info.size > MAX_AUDIO_BYTES) throw new Error("audio_size_limit");
	if (!(await client.isEnabled(job, signal))) throw new Error("analysis_disabled");
	const hash = createHash("sha256");
	const { createReadStream } = await import("node:fs");
	for await (const chunk of createReadStream(source.path)) {
		if (signal.aborted) throw new Error("cancelled");
		hash.update(chunk);
	}
	const sourceSha256 = hash.digest("hex");
	const result = await analyzer(source.path, signal);
	if (signal.aborted) throw new Error("cancelled");
	const after = await stat(source.path);
	if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("source_changed");
	await client.publish(job, sourceSha256, result, signal);
	return result;
}
