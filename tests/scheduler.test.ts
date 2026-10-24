import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconciler } from '../src/scheduler.js';
import { Stable } from '../src/stable.js';
import { Credential } from '../src/credential.js';
import { Store } from '../src/store.js';
test('reconciliation admits one episode per enabled show with requesting service catalog reads',async()=>{
	const transport = async(url: string|URL|Request) => {
		const parsed = new URL(url.toString());
		if(parsed.pathname==='/login') return Response.json({user:{accessToken:'service'}});
		if(parsed.pathname==='/api/libraries') return Response.json({libraries:[{id:'p',mediaType:'podcast'}]});
		if(parsed.pathname==='/api/libraries/p/items') return Response.json({total:2,results:[{id:'a'},{id:'b'}]});
		return Response.json({media:{episodes:[{id:'e1'},{id:'e2'}]}});
	};
	const stable = new Stable('https://stable.example',transport); const credential = new Credential(stable.base,'u','p',transport);
	const store = new Store(':memory:'); store.setEnabled('a',true);store.setEnabled('b',true);
	try {await reconciler(stable,credential)(store,new AbortController().signal);assert.equal(store.jobs('a').length,1);assert.equal(store.jobs('b').length,1);}finally{store.close();}
});
