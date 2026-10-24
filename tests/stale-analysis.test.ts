import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
test('candidate classification survives persistence; disabled source never returns segments',()=>{
	const store=new Store(':memory:');
	try{
		store.setEnabled('i',true);
		store.setResult('i','e',{status:'candidates',version:'1',sourceSha256:'a'.repeat(64),segments:[{start:1,end:2}],adAnalysisEnabled:true,applicable:true});
		assert.equal(store.analysis('i').e.status,'candidates');
		store.setEnabled('i',false);
		assert.deepEqual(store.analysis('i').e.segments,[]);
		assert.throws(()=>store.setResult('i','e',{status:'candidates',version:'1',sourceSha256:'b'.repeat(64),segments:[],adAnalysisEnabled:true,applicable:true}),/analysis_disabled/);
	}finally{store.close();}
});
test('source verification never promotes inconclusive analysis to no_difference',()=>{
	const store=new Store(':memory:');
	try{
		store.setEnabled('i',true);
		store.setResult('i','e',{status:'inconclusive',version:'1',sourceSha256:'a'.repeat(64),segments:[],adAnalysisEnabled:true,applicable:false});
		store.verifySource('i','e','a'.repeat(64));
		assert.equal(store.analysis('i').e.applicable,false);
		assert.equal(store.jobs('i')[0].status,'queued');
	}finally{void store.close();}
});
test('analysis HTTP read verifies bytes before returning migrated segments',async()=>{
	const {Stable}=await import('../src/stable.js');const {createApp}=await import('../src/app.js');
	const store=new Store(':memory:');let hash='a'.repeat(64);
	const stable=new Stable('https://stable.example',async url=>new URL(url.toString()).pathname==='/api/me'?Response.json({id:'u',type:'user',isActive:true,permissions:{}}):Response.json({media:{episodes:[{id:'e'}]}}));
	try{
		store.setEnabled('i',true);store.setResult('i','e',{status:'stale',version:'migration-v1',sourceSha256:hash,segments:[{start:1,end:2}],adAnalysisEnabled:true,applicable:false});
		const app=createApp(stable,store,undefined,async()=>hash),headers={Authorization:'Bearer user'};
		const first=await app.request('/api/items/i/analysis',{headers});assert.equal((await first.json()).episodes.e.applicable,true);
		hash='b'.repeat(64);const changed=await app.request('/api/items/i/analysis',{headers});const result=(await changed.json()).episodes.e;
		assert.equal(result.applicable,false);assert.deepEqual(result.segments,[]);assert.equal(store.jobs('i')[0].status,'queued');
	}finally{await store.close();}
});
