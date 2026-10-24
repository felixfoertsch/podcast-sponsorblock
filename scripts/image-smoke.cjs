const assert = require('node:assert/strict');
const { createApp } = require('../dist/src/app.js');
const { Stable } = require('../dist/src/stable.js');
const { Store } = require('../dist/src/store.js');
(async()=>{
	const store = new Store(':memory:');
	try {
		const app = createApp(new Stable('https://stable.example',async()=>new Response('',{status:401})),store);
		assert.equal((await app.request('/healthz')).status,200);
		assert.equal((await app.request('/api/items/i/analysis',{headers:{Authorization:'Bearer bad'}})).status,401);
		assert.equal((await app.request('/api/items/i/analysis')).status,401);
		console.log('image HTTP smoke passed');
	}finally{store.close();}
})().catch(()=>{console.error('image_http_smoke_failed');process.exitCode=1;});
