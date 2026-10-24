import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/analyzerTransport.js';
test('analysis network boundary blocks local, private and metadata addresses', async () => {
	for(const url of ['http://127.0.0.1:1/','http://[::1]:1/','http://169.254.169.254/','http://192.168.23.20/','http://10.0.0.1/','file:///etc/passwd','https://user:password@example.com/']) {
		await assert.rejects(request(url,1024,1000,AbortSignal.timeout(1500)));
	}
});
