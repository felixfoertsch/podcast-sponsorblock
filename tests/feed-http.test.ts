import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stable } from '../src/stable.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { createFeedRoutes } from '../src/feed-routes.js';
import fixtures from '../contract/fixtures.json';
import { analysisSchema,consentSchema,enqueueSchema,summarySchema,recentFeedSchema,corpusSchema,jobStatusSchema } from '../contract/api.js';
test('frozen fixtures validate all response schemas',()=>{
	for(const [schema,value] of [[analysisSchema,fixtures.analysis],[consentSchema,fixtures.consent],[enqueueSchema,fixtures.enqueue],[summarySchema,fixtures.summary],[recentFeedSchema,fixtures.recent],[corpusSchema,fixtures.corpus],[jobStatusSchema,fixtures.status]] as const) assert.equal(schema.safeParse(value).success,true);
});
test('summary fallback uses requesting user progress and item ACL',async()=>{
	const stable=new Stable('https://stable.example',async url=>{
		const path=new URL(url.toString()).pathname;
		if(path==='/api/me')return Response.json({id:'u',type:'user',isActive:true,permissions:{},mediaProgress:[{episodeId:'e',isFinished:true}]});
		if(path==='/api/items/i')return Response.json({media:{episodes:[{id:'e',title:'episode'}]}});
		throw new Error('unexpected');
	});
	const store=new Store(':memory:');const app=createApp(stable,store).route('/',createFeedRoutes(stable));
	try{const response=await app.request('/api/podcasts/i/episode-summary',{headers:{Authorization:'Bearer user'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{total:1,unplayed:0,source:'downloaded'});}finally{store.close();}
});
