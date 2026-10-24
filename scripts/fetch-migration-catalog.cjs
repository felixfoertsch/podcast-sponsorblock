const fs=require('node:fs');
const {parseEnv}=require('node:util');
(async()=>{
	const values=parseEnv(fs.readFileSync(process.argv[2],'utf8')),target=process.argv[3];
	const base=target==='stable'?'https://audiobookshelf.felixfoertsch.de':values.ABS_URL;
	let token=values.ABS_API_KEY;
	if(target==='stable'){
		const response=await fetch(new URL('/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:values.PSB_STABLE_USERNAME,password:values.PSB_STABLE_PASSWORD}),redirect:'error',signal:AbortSignal.timeout(10000)});
		if(!response.ok)throw Error('service_login_failed');token=(await response.json()).user.accessToken;
	}
	async function get(route){const response=await fetch(new URL(route,base),{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('catalog_request_failed');const text=await response.text();if(Buffer.byteLength(text)>16*1024*1024)throw Error('catalog_response_limit');return JSON.parse(text);}
	const shows=[],episodes=[],libraries=(await get('/api/libraries')).libraries;
	for(const library of libraries){if(library.mediaType!=='podcast')continue;
		for(let page=0;page<100;page++){
			const result=await get(`/api/libraries/${encodeURIComponent(library.id)}/items?limit=100&page=${page}`);
			for(const row of result.results){const item=await get(`/api/items/${encodeURIComponent(row.id)}?expanded=1`),media=item.media;shows.push({id:item.id,feedUrl:media.metadata?.feedUrl??media.feedURL??null});for(const ep of media.episodes??[])episodes.push({id:ep.id,showId:item.id,guid:ep.guid??null,enclosureUrl:ep.enclosure?.url??ep.enclosureURL??null});}
			if((page+1)*100>=result.total)break;if(page===99)throw Error('catalog_pagination_limit');
		}
	}
	fs.writeFileSync(process.argv[4],JSON.stringify({shows,episodes}),{mode:0o600});console.log(JSON.stringify({target,shows:shows.length,episodes:episodes.length,feedUrls:shows.filter(s=>s.feedUrl).length}));
})().catch(()=>{console.error('catalog_fetch_failed');process.exitCode=1;});
