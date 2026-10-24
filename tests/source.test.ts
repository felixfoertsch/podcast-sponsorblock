import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stable } from '../src/stable.js';
import { Credential } from '../src/credential.js';
import { downloadSource } from '../src/source.js';
test('source validates only requested episode duration', async () => {
	for (const neighbor of [{ id: 'short', duration: 49, audioFile: {} }, { id: 'long', duration: 14400, audioFile: {} }, { id: 'malformed' }]) {
		const fixture = async (url: string | URL | Request) => {
			const path = new URL(typeof url === 'object' && 'url' in url ? url.url : url.toString()).pathname;
			if (path === '/login') return Response.json({ user: { accessToken: 'service-token' } });
			if (path === '/api/items/i') return Response.json({ media: { episodes: [{ id: 'e', duration: 60, audioFile: { ino: 'file' } }, neighbor] } });
			if (path === '/api/items/i/file/file') return new Response('fixture-audio');
			throw new Error('unexpected_route');
		};
		const stable = new Stable('https://stable.example', fixture);
		const source = await downloadSource(stable, new Credential(stable.base, 'service', 'password', fixture), 'i', 'e', new AbortController().signal, fixture);
		try { assert.equal(source.duration, 60); } finally { await source.cleanup(); }
	}
});
test('requested episode duration remains bounded and missing episode returns 404', async () => {
	for (const episodes of [[{ id: 'e', duration: 14400, audioFile: { ino: 'file' } }], []]) {
		const fixture = async (url: string | URL | Request) => {
			const path = new URL(typeof url === 'object' && 'url' in url ? url.url : url.toString()).pathname;
			if (path === '/login') return Response.json({ user: { accessToken: 'service-token' } });
			if (path === '/api/items/i') return Response.json({ media: { episodes } });
			throw new Error('unexpected_route');
		};
		const stable = new Stable('https://stable.example', fixture);
		await assert.rejects(downloadSource(stable, new Credential(stable.base, 'service', 'password', fixture), 'i', 'e', new AbortController().signal, fixture), error => episodes.length ? true : (error as { status?: number }).status === 404);
	}
});
test('source uses authorized file GET, never playback or progress writes', async () => {
	const ledger: { path: string; method: string }[] = [];
	const fixture = async (url: string | URL | Request, options?: RequestInit) => {
		const path = new URL(typeof url === 'object' && 'url' in url ? url.url : url.toString()).pathname;
		ledger.push({path, method: options?.method ?? 'GET'});
		if (path === '/login') return Response.json({ user: { accessToken: 'service-token' } });
		assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer service-token');
		if (path === '/api/items/i') return Response.json({media:{episodes:[{id:'e',duration:60,audioFile:{ino:'file'}}]}});
		if (path === '/api/items/i/file/file') return new Response('fixture-audio');
		throw new Error('unexpected_route');
	};
	const stable = new Stable('https://stable.example', fixture);
	const credential = new Credential(stable.base, 'service', 'password', fixture);
	const source = await downloadSource(stable,credential,'i','e',new AbortController().signal,fixture);
	try { assert.match(source.sha256,/^[0-9a-f]{64}$/); assert.equal(source.duration,60); }
	finally { await source.cleanup(); }
	assert.deepEqual(ledger,[{path:'/login',method:'POST'},{path:'/api/items/i',method:'GET'},{path:'/api/items/i/file/file',method:'GET'}]);
});
