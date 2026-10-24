import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconciler } from '../src/scheduler.js';
import { Stable } from '../src/stable.js';
import { Credential } from '../src/credential.js';
import { Store } from '../src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('reconciliation persists pagination and admits every enabled show fairly',async()=>{
	const dir = mkdtempSync(join(tmpdir(), 'psb-scheduler-')), path = join(dir, 'db');
	const transport = async(url: string|URL|Request) => {
		const parsed = new URL(url.toString());
		if(parsed.pathname==='/login') return Response.json({user:{accessToken:'service'}});
		if(parsed.pathname==='/api/libraries') return Response.json({libraries:[{id:'p',mediaType:'podcast'}]});
		if(parsed.pathname==='/api/libraries/p/items') {
			const page = Number(parsed.searchParams.get('page'));
			return Response.json({total:41,results:Array.from({length: page === 2 ? 1 : 20}, (_,i)=>({id:`show-${page*20+i}`}))});
		}
		const id = parsed.pathname.match(/\/api\/items\/([^/]+)/)?.[1] ?? '';
		return Response.json({media:{episodes:[{id:`${decodeURIComponent(id)}-ep`} ]}});
	};
	const stable = new Stable('https://stable.example',transport); const credential = new Credential(stable.base,'u','p',transport);
	try {
		let store = new Store(path); for(let i=0;i<41;i++) store.setEnabled(`show-${i}`,true);
		const reconcile = reconciler(stable,credential);
		await reconcile(store,new AbortController().signal);
		assert.equal(store.jobs('show-0').length,1); assert.equal(store.jobs('show-20').length,0);
		assert.equal(store.schedulerPage('p'),1); await store.close();
		store = new Store(path); await reconcile(store,new AbortController().signal);
		assert.equal(store.jobs('show-20').length,1); assert.equal(store.jobs('show-40').length,0);
		assert.equal(store.schedulerPage('p'),1);
		assert.equal(store.schedulerPage('p:offset'),12);
		await store.close();
	} finally {rmSync(dir,{recursive:true,force:true});}
});
