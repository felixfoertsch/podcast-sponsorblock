import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stable } from '../src/stable.js';
import { createDebugRoutes } from '../src/debug-server.js';
test('admin discovery accepts stock playlist envelope',async()=>{
	const dir=mkdtempSync(join(tmpdir(),'psb-debug-'));
	const token='header.'+Buffer.from(JSON.stringify({type:'access'})).toString('base64url')+'.signature';
	const stable=new Stable('https://stable.example',async url=>{
		const path=new URL(String(url)).pathname;
		if(path==='/api/me')return Response.json({id:'u',type:'admin',isActive:true,permissions:{}});
		if(path==='/api/libraries')return Response.json({libraries:[]});
		if(path==='/api/playlists')return Response.json({playlists:[]});
		throw Error('unexpected');
	});
	const debug=createDebugRoutes(stable,dir);
	try{assert.equal((await debug.request('/all',{headers:{Authorization:'Bearer '+token}})).status,200);}finally{debug.close();rmSync(dir,{recursive:true,force:true});}
});
test('same debug-overlay package opens native SQLite and rejects non-admin',async()=>{
	const dir=mkdtempSync(join(tmpdir(),'psb-debug-'));
	const stable=new Stable('https://stable.example',async()=>Response.json({id:'u',type:'user',isActive:true,permissions:{}}));
	const debug=createDebugRoutes(stable,dir);
	try{assert.equal((await debug.request('/auth',{headers:{Authorization:'Bearer x'}})).status,401);}finally{debug.close();rmSync(dir,{recursive:true,force:true});}
});
