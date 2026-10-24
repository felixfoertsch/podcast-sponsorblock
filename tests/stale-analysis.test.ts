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
