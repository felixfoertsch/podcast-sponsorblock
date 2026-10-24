import { createHash } from 'node:crypto';
import { z } from 'zod';

export class HttpError extends Error {
	constructor(public status: number, message: string) { super(message); }
}
const userSchema = z.object({
	id: z.string().min(1), type: z.enum(['root', 'admin', 'user', 'guest']),
	isActive: z.boolean(), permissions: z.record(z.string(), z.unknown()),
});
export type User = z.infer<typeof userSchema>;
export type Fetch = typeof fetch;
export class Stable {
	private cache = new Map<string, { until: number; user: User }>();
	constructor(readonly base: string, private transport: Fetch = fetch) {
		const url = new URL(base);
		// HTTP allowed only for verified stable service on private Docker network.
		const internal = url.protocol === 'http:' && url.hostname === 'audiobookshelf' && (!url.port || url.port === '80');
		if ((!internal && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_stable_base');
	}
	async request(path: string, token: string): Promise<unknown> {
		if (!/^\/api\/(me(?:\?|$|\/)|items\/|libraries(?:\/|\?|$)|playlists(?:\?|$)|users(?:\?|$))/.test(path) || path.includes('..')) throw new Error('stable_route_denied');
		let response: Response;
		try { response = await this.transport(new URL(path, this.base), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
		catch { throw new HttpError(503, 'stable_unavailable'); }
		if (!response.ok) throw new HttpError(response.status === 401 ? 401 : response.status === 403 || response.status === 404 ? response.status : 503, 'stable_request_failed');
		const chunks: Uint8Array[] = []; let size = 0;
		if (!response.body) throw new HttpError(503, 'stable_empty_response');
		for await (const chunk of response.body) {
			size += chunk.byteLength;
			if (size > 16 * 1024 * 1024) { throw new HttpError(503, 'stable_response_limit'); }
			chunks.push(chunk);
		}
		try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(503, 'stable_invalid_json'); }
	}
	async validate(token: string, write = false): Promise<User> {
		const digest = createHash('sha256').update(token).digest('hex');
		const cached = this.cache.get(digest);
		if (!write && cached && cached.until > Date.now()) return cached.user;
		const parsed = userSchema.safeParse(await this.request('/api/me', token));
		if (!parsed.success) throw new HttpError(503, 'stable_invalid_user');
		if (!parsed.data.isActive) throw new HttpError(401, 'inactive_user');
		if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
		let until = Date.now() + 30000;
		try {
			const expiry = z.object({ exp: z.number().finite() }).safeParse(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()));
			if (expiry.success) until = Math.min(until, expiry.data.exp * 1000);
		} catch { /* Stable remains sole token validator. */ }
		this.cache.set(digest, { until, user: parsed.data });
		return parsed.data;
	}
	async item(id: string, token: string): Promise<Record<string, unknown>> {
		return z.record(z.string(), z.unknown()).parse(await this.request(`/api/items/${encodeURIComponent(id)}?expanded=1`, token));
	}
}
// API-key /me projection in ABS 2.37.1 loses effective key scope. Only a
// stable-validated access-token envelope can request admin writes; decoding
// never grants identity or permissions, it only narrows accepted credentials.
export function permitsAdminWrite(token: string, user: User): boolean {
	if (user.type !== 'root' && user.type !== 'admin') return false;
	try {
		const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
		return z.object({ type: z.literal('access') }).safeParse(payload).success;
	} catch { return false; }
}
