import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { request } from '../src/analyzerTransport.js';

// Proxy fixture routes public target authorities locally; production SSRF policy stays intact.
test('HTTP CONNECT proxy handles payload, redirects, limits, blocked redirects and TLS failure without fallback', async () => {
	const previous=process.env.AD_ANALYSIS_PROXY_URL;
	let connects=0;
	const origin=http.createServer((req,res)=>{
		if(req.url==='/redirect'){res.writeHead(302,{Location:'http://8.8.8.8/final'});res.end();}
		else if(req.url==='/blocked'){res.writeHead(302,{Location:'http://127.0.0.1/private'});res.end();}
		else if(req.url==='/loop'){res.writeHead(302,{Location:'/loop'});res.end();}
		else res.end('fixture payload');
	});
	origin.listen(0,'127.0.0.1');await once(origin,'listening');const originPort=(origin.address() as net.AddressInfo).port;
	const proxy=http.createServer();
	proxy.on('connect',(_req,client,head)=>{
		connects++;const upstream=net.connect(originPort,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
		upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
	});
	proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
	process.env.AD_ANALYSIS_PROXY_URL=`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
	try{
		assert.equal((await request('http://8.8.8.8/')).data.toString(),'fixture payload');
		const redirected=await request('http://8.8.8.8/redirect');assert.equal(redirected.url,'http://8.8.8.8/final');
		await assert.rejects(request('http://8.8.8.8/blocked'),/unsafe_url/);
		await assert.rejects(request('http://8.8.8.8/loop'),/redirect_limit/);
		await assert.rejects(request('http://8.8.8.8/',2),/response_too_large/);
		await assert.rejects(request('https://8.8.8.8/',1024,2000),/proxy_failed_or_blocked|request_timeout/);
		assert.ok(connects>=10);
		process.env.AD_ANALYSIS_PROXY_URL='http://127.0.0.1:1';
		await assert.rejects(request('http://8.8.8.8/',1024,1000),/proxy_failed_or_blocked/);
	}finally{
		if(previous===undefined)delete process.env.AD_ANALYSIS_PROXY_URL;else process.env.AD_ANALYSIS_PROXY_URL=previous;
		proxy.closeAllConnections();origin.closeAllConnections();proxy.close();origin.close();
	}
});
