import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,fileIdentity} from '../src/store.js';
import {Stable} from '../src/stable.js';
import {Credential} from '../src/credential.js';
import {downloadSource} from '../src/source.js';
import {AnalysisCorpus} from '../src/corpus.js';
import {analyzeCandidates} from '../src/analyzer.js';
import {createApp} from '../src/app.js';

test('enqueue fetches authorized fixture, runs real detector, persists corpus and returns analysis',async t=>{
	if(spawnSync('ffmpeg',['-version']).status!==0||spawnSync('fpcalc',['-version']).status!==0){t.skip('native ffmpeg/fpcalc not installed; check image supplies both');return;}
	const dir=mkdtempSync(join(tmpdir(),'psb-e2e-')), audio=join(dir,'audio.mp3'),store=new Store(join(dir,'runtime.sqlite')),corpus=new AnalysisCorpus(join(dir,'runtime.sqlite'));
	try{
		execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=60','-c:a','libmp3lame',audio]);
		const bytes=readFileSync(audio);let sourceGets=0;
		const episode={id:'e',title:'Episode',guid:'g',publishedAt:'2026-01-01',duration:60,audioFile:{ino:'1',metadata:{size:bytes.length,mtimeMs:1}},enclosure:{url:'https://audio.example/source.mp3'}};
		const fetcher:typeof fetch=async url=>{
			const path=new URL(url.toString()).pathname;
			if(path==='/login')return Response.json({user:{accessToken:'service'}});
			if(path==='/api/me')return Response.json({id:'u',type:'admin',isActive:true,permissions:{}});
			if(path==='/api/items/i')return Response.json({media:{metadata:{title:'Show'},episodes:[episode]}});
			if(path==='/api/items/i/file/1'){sourceGets++;return new Response(bytes);}
			throw Error('unexpected_route');
		};
		const stable=new Stable('https://stable.example',fetcher),credential=new Credential(stable.base,'u','p',fetcher),headers={Authorization:`Bearer x.${Buffer.from(JSON.stringify({type:'access'})).toString('base64url')}.x`,'Content-Type':'application/json'};
		const app=createApp(stable,store,corpus);
		assert.equal((await app.request('/api/podcasts/i/ad-analysis',{method:'POST',headers,body:'{"enabled":true}'})).status,200);
		assert.equal((await app.request('/api/podcasts/i/episode/e/ad-analysis',{method:'POST',headers,body:'{}'})).status,202);
		void store.start(async(job,signal)=>{
			const source=await downloadSource(stable,credential,job.itemId,job.episodeId,signal,fetcher);
			try{
				const result=await analyzeCandidates({sourcePath:source.path,duration:60,itemId:'i',episodeId:'e',episode,item:{title:'Show'},corpus,signal,transport:{candidates:async provider=>provider==='apple'?{results:[{feedUrl:'https://feed.example/rss',collectionName:'Show'}]}:[],fetchFeed:async()=>[episode],get:async url=>({data:bytes,url})}});
				assert.equal(result.status,'no_difference',JSON.stringify(result));
				store.setResult('i','e',{status:result.status,version:'1',sourceSha256:source.sha256,segments:result.segments,adAnalysisEnabled:true,applicable:true},fileIdentity(source.episode));
			}finally{await source.cleanup();}
		});
		const deadline=Date.now()+30000;
		while(!['complete','failed'].includes(store.jobs('i')[0].status)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
		assert.equal(store.jobs('i')[0].status,'complete',store.jobs('i')[0].error);assert.equal(sourceGets,1);
		const response=await app.request('/api/items/i/analysis',{headers});const result=(await response.json()).episodes.e;
		assert.equal(result.status,'no_difference');assert.equal(result.applicable,true);assert.deepEqual(result.segments,[]);assert.equal(corpus.inventory('i','e').count,1);
	}finally{await store.close();corpus.close();rmSync(dir,{recursive:true,force:true});}
});
