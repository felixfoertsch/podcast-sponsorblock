import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stable } from '../src/stable.js';
import { createDebugRoutes } from '../src/debug-server.js';
test('same debug-overlay package opens native SQLite and rejects non-admin',async()=>{
	const dir=mkdtempSync(join(tmpdir(),'psb-debug-'));
	const stable=new Stable('https://stable.example',async()=>Response.json({id:'u',type:'user',isActive:true,permissions:{}}));
	const debug=createDebugRoutes(stable,dir);
	try{assert.equal((await debug.request('/auth',{headers:{Authorization:'Bearer x'}})).status,401);}finally{debug.close();rmSync(dir,{recursive:true,force:true});}
});
