import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stable, HttpError, permitsAdminWrite } from '../src/stable.js';
const user = { id: 'u', type: 'admin', isActive: true, permissions: {} };
test('auth validates stable, caches reads, revalidates writes, never permits restricted keys', async () => {
	let calls = 0;
	const stable = new Stable('https://stable.example', async () => { calls++; return Response.json(user); });
	const token = `e.${Buffer.from(JSON.stringify({ type: 'access' })).toString('base64url')}.s`;
	const who = await stable.validate(token);
	await stable.validate(token);
	assert.equal(calls, 1);
	await stable.validate(token, true);
	assert.equal(calls, 2);
	assert.equal(permitsAdminWrite(token, who), true);
	assert.equal(permitsAdminWrite(`e.${Buffer.from('{"type":"api"}').toString('base64url')}.s`, who), false);
	assert.equal(permitsAdminWrite(token, { ...who, type: 'user' }), false);
});
test('invalid, unavailable and malformed auth fail closed', async () => {
	for (const [status, expected] of [[401,401],[500,503]]) {
		const stable = new Stable('https://stable.example', async () => new Response('', {status}));
		await assert.rejects(stable.validate('bad'), (e: unknown) => e instanceof HttpError && e.status === expected);
	}
	const stable = new Stable('https://stable.example', async () => Response.json({id:'u',type:'admin'}));
	await assert.rejects(stable.validate('bad'), /stable_invalid_user/);
});
test('fixed-base client denies path escapes and mutations', async () => {
	const stable = new Stable('https://stable.example', async () => { throw new Error('must not fetch'); });
	await assert.rejects(stable.request('//attacker.example/api/me','x'), /stable_route_denied/);
	await assert.rejects(stable.request('/api/items/../settings','x'), /stable_route_denied/);
});
