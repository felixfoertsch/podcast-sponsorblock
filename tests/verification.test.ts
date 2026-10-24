import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Stable} from '../src/stable.js';
import {createApp} from '../src/app.js';
const identity=JSON.stringify(['1',100,10]);
const result={status:'candidates',version:'1',sourceSha256:'a'.repeat(64),segments:[{start:1,end:2}],adAnalysisEnabled:true,applicable:true};
test('GET uses item identity only; verify hash controls applicability and unchanged identity needs no download',async()=>{
 const store=new Store(':memory:');let mtime=10;const ledger:string[]=[];
 const stable=new Stable('https://stable.example',async url=>{const path=new URL(url.toString()).pathname;ledger.push(path);if(path==='/api/me')return Response.json({id:'u',type:'user',isActive:true,permissions:{}});if(path==='/api/items/i')return Response.json({media:{episodes:[{id:'e',audioFile:{ino:'1',metadata:{size:100,mtimeMs:mtime}}}]}});throw Error('unexpected_source_fetch');});
 try{
  store.setEnabled('i',true);store.setResult('i','e',result);const app=createApp(stable,store),headers={Authorization:'Bearer user'};
  const read=async()=> (await (await app.request('/api/items/i/analysis',{headers})).json()).episodes.e;
  assert.equal((await read()).applicable,false);assert.equal(store.jobs('i')[0].kind,'verify');await read();assert.equal(store.jobs('i').length,1);
  store.verifySource('i','e',result.sourceSha256,identity);assert.equal((await read()).applicable,true);
  mtime=11;assert.equal((await read()).applicable,false);store.verifySource('i','e','b'.repeat(64),JSON.stringify(['1',100,11]));assert.equal((await read()).applicable,false);assert.equal(store.jobs('i')[0].kind,'analysis');
  assert.ok(ledger.every(path=>path==='/api/me'||path==='/api/items/i'));
 }finally{await store.close();}
});
test('verify backlog survives restart and full verify queue admits analysis first',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'psb-verify-')),path=join(dir,'db');let store=new Store(path);
 try{
  store.setEnabled('i',true);for(let i=0;i<40;i++)store.setResult('i',String(i),result);
  store.observeSources('i',{media:{episodes:Array.from({length:40},(_,i)=>({id:String(i),audioFile:{ino:'1',metadata:{size:100,mtimeMs:10}}}))}});
  assert.equal(store.jobs('i').filter(j=>j.status==='queued').length,32);store.enqueue('i','user');assert.equal(store.jobs('i').filter(j=>j.status==='queued').length,32);
  await store.close();store=new Store(path);const order:string[]=[];
  void store.start(async job=>{order.push(job.kind);if(job.kind==='verify')store.verifySource('i',job.episodeId,result.sourceSha256,identity);if(order.length===41)store.stop();});
  const deadline=Date.now()+5000;while(order.length<41&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(order.length,41);assert.equal(order[0],'analysis');assert.equal(order.filter(k=>k==='verify').length,40);
 }finally{await store.close();rmSync(dir,{recursive:true,force:true});}
});
test('running verify recovers once after restart; imported backlog needs no GET',async()=>{
 const {default:Database}=await import('better-sqlite3');const dir=mkdtempSync(join(tmpdir(),'psb-verify-restart-')),path=join(dir,'db');
 try{
  let store=new Store(path);store.setEnabled('i',true);store.setResult('i','e',{...result,version:'migration-v1',status:'stale',applicable:false});store.enqueue('i','e','verify',identity);await store.close();
  const db=new Database(path);db.prepare("UPDATE jobs SET status='running',attempts=1").run();db.close();
  store=new Store(path);assert.equal(store.jobs('i')[0].kind,'verify');assert.equal(store.jobs('i')[0].status,'queued');let verified=false;
  void store.start(async job=>{store.verifySource('i',job.episodeId,result.sourceSha256,identity);verified=true;store.stop();});
  const deadline=Date.now()+1000;while(!verified&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(verified,true);assert.equal(store.analysis('i').e.applicable,true);await store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
