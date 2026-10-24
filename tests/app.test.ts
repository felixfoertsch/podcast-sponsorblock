import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stable } from '../src/stable.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
test('HTTP bearer-only ACL fails closed; reads always prove item access', async () => {
	let reads = 0;
	const stable = new Stable('https://stable.example', async url => {
		const path = new URL(url.toString()).pathname;
		if(path === '/api/me') return Response.json({ id:'u', type:'user', isActive:true, permissions:{} });
		reads++; return new Response('',{status:403});
	});
	const store = new Store(':memory:'); const app = createApp(stable,store);
	try {
		assert.equal((await app.request('/healthz')).status,200);
		assert.equal((await app.request('/api/items/i/analysis',{headers:{Cookie:'token=x'}})).status,401);
		assert.equal((await app.request('/api/items/i/analysis',{headers:{Authorization:'Bearer x'}})).status,403);
		assert.equal(reads,1);
		assert.equal((await app.request('/api/podcasts/i/ad-analysis',{method:'POST',headers:{Authorization:'Bearer x','Content-Type':'application/json'},body:'{"enabled":true}'})).status,403);
	} finally {store.close();}
});
