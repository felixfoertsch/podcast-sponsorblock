import { z } from 'zod';
import { HttpError, type Fetch } from './stable.js';
const loginSchema = z.object({ user: z.object({ accessToken: z.string().min(1) }) });
export class Credential {
	private token?: string;
	private until = 0;
	private pending?: Promise<string>;
	constructor(private base: string, private username: string, private password: string, private transport: Fetch = fetch) {}
	async get(): Promise<string> {
		if (this.token && this.until > Date.now()) return this.token;
		if (this.pending) return this.pending;
		this.pending = this.login();
		try { return await this.pending; } finally { this.pending = undefined; }
	}
	invalidate() { this.token = undefined; this.until = 0; }
	private async login(): Promise<string> {
		let response: Response;
		try { response = await this.transport(new URL('/login', this.base), {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: this.username, password: this.password }),
			redirect: 'error', signal: AbortSignal.timeout(10000),
		}); } catch { throw new HttpError(503, 'service_login_unavailable'); }
		if (!response.ok) throw new HttpError(503, 'service_login_rejected');
		if (!response.body) throw new HttpError(503, 'service_login_invalid');
		const chunks: Uint8Array[] = []; let bytes = 0;
		for await (const chunk of response.body) {
			bytes += chunk.byteLength;
			if (bytes > 1024 * 1024) throw new HttpError(503, 'service_login_response_limit');
			chunks.push(chunk);
		}
		const parsed = loginSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
		if (!parsed.success) throw new HttpError(503, 'service_login_invalid');
		this.token = parsed.data.user.accessToken;
		let lifetime = 5 * 60 * 1000;
		try {
			const payload = z.object({ exp: z.number() }).parse(JSON.parse(Buffer.from(this.token.split('.')[1] ?? '', 'base64url').toString()));
			lifetime = Math.max(0, Math.min(lifetime, payload.exp * 1000 - Date.now() - 30000));
		} catch { /* Short bounded refresh if expiry unavailable. */ }
		this.until = Date.now() + lifetime;
		return this.token;
	}
}
