import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stable } from '../src/stable.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { createFeedRoutes } from '../src/feed-routes.js';
import { analysisSchema,consentSchema,enqueueSchema,summarySchema,recentFeedSchema,corpusSchema,jobStatusSchema } from '../contract/api.js';
import fixtures from '../contract/fixtures.json';
test('frozen fixtures validate all response schemas',()=>{
	for(const [schema,value] of [[analysisSchema,fixtures.analysis],[consentSchema,fixtures.consent],[enqueueSchema,fixtures.enqueue],[summarySchema,fixtures.summary],[recentFeedSchema,fixtures.recent],[corpusSchema,fixtures.corpus],[jobStatusSchema,fixtures.status]] as const) assert.equal(schema.safeParse(value).success,true);
});
test('stock enclosure shape matches feed summary and recent downloaded rows',async()=>{
	const stable=new Stable('https://stable.example',async url=>{
		const parsed=new URL(url.toString());
		if(parsed.pathname==='/api/me')return Response.json({id:'u',type:'user',isActive:true,permissions:{},mediaProgress:[{episodeId:'e',isFinished:true}]});
		if(parsed.pathname==='/api/items/i')return Response.json({media:{metadata:{feedUrl:'https://feed.example/rss'},episodes:[{id:'e',title:'Finished episode',enclosure:{url:'https://cdn.example/episode.mp3',length:123,type:'audio/mpeg'}},{id:'legacy',title:'Legacy',enclosureURL:'https://cdn.example/legacy.mp3'}]}});
		if(parsed.pathname==='/api/libraries/lib')return Response.json({id:'lib'});
		if(parsed.pathname==='/api/libraries/lib/items')return Response.json({results:[{id:'i',mediaType:'podcast'}]});
		throw new Error('unexpected');
	});
	const feedTransport={async fetch(){return {episodes:[{title:'Finished episode',guid:null,enclosure:{url:'https://cdn.example/episode.mp3'}}]};}};
	const store=new Store(':memory:');const app=createApp(stable,store).route('/',createFeedRoutes(stable,feedTransport));
	try{
		const summary=await app.request('/api/podcasts/i/episode-summary',{headers:{Authorization:'Bearer user'}});
		assert.deepEqual(await summary.json(),{total:1,unplayed:0,source:'feed'});
		const recent=await app.request('/api/libraries/lib/recent-episodes',{headers:{Authorization:'Bearer user'}});
		assert.equal(recent.status,200);
		const episodes=(await recent.json() as {episodes:{downloaded:boolean}[]}).episodes;
		assert.equal(episodes.length,2);
		assert.equal(episodes.filter(ep=>ep.downloaded).length,2);
	}finally{store.close();}
});
