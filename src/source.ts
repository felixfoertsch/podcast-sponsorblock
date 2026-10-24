import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Stable, HttpError, type Fetch } from './stable.js';
import { Credential } from './credential.js';
export const episodeSourceSchema = z.object({ id: z.string(), duration: z.number().finite().min(50).lt(14400), audioFile: z.object({ ino: z.union([z.string(), z.number()]) }).passthrough() }).passthrough();
export async function downloadSource(stable: Stable, credential: Credential, itemId: string, episodeId: string, signal: AbortSignal, transport: Fetch = fetch) {
	const token = await credential.get();
	const item = await stable.item(itemId, token);
	const media = z.object({ episodes: z.array(episodeSourceSchema) }).parse(item.media);
	const episode = media.episodes.find(e => e.id === episodeId);
	if (!episode) throw new HttpError(404, 'episode_not_found');
	// getLibraryFile sends authorized bytes only; no playback/session/progress handler.
	const path = `/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(String(episode.audioFile.ino))}`;
	const response = await transport(new URL(path, stable.base), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
	if (!response.ok || !response.body) { if (response.status === 401) credential.invalidate(); throw new Error('source_download_failed'); }
	const dir = await mkdtemp(join(tmpdir(), 'psb-source-'));
	const file = join(dir, 'source');
	const hash = createHash('sha256'); let bytes = 0;
	try {
		await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), new Transform({ transform(chunk: Buffer, _encoding, done) {
			bytes += chunk.length;
			if (bytes > 256 * 1024 * 1024) return done(new Error('source_byte_limit'));
			hash.update(chunk); done(null, chunk);
		} }), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
		return { path: file, sha256: hash.digest('hex'), duration: episode.duration, item, episode, cleanup: () => rm(dir, { recursive: true, force: true }) };
	} catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
