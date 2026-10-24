import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
test('restart retries interrupted running job once, never beyond budget',()=>{
	const dir=mkdtempSync(join(tmpdir(),'psb-restart-')), path=join(dir,'db');
	try{
		let store=new Store(path,{serverId:'s'});store.setEnabled('i',true);store.enqueue('i','e');store.close();
		let db=new Database(path);db.prepare("UPDATE jobs SET status='running',attempts=1").run();db.close();
		store=new Store(path,{serverId:'s'});assert.equal(store.jobs('i')[0].status,'queued');store.close();
		db=new Database(path);db.prepare("UPDATE jobs SET status='running',attempts=2").run();db.close();
		store=new Store(path,{serverId:'s'});assert.equal(store.jobs('i')[0].status,'interrupted');store.close();
	}finally{rmSync(dir,{recursive:true,force:true});}
});
