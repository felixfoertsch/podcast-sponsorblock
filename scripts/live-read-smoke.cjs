const fs = require('node:fs');
const assert = require('node:assert/strict');
const { parseEnv } = require('node:util');
const { Credential } = require('../dist/src/credential.js');
const { Stable } = require('../dist/src/stable.js');
(async()=>{
	const values = parseEnv(fs.readFileSync(process.argv[2],'utf8'));
	assert.ok(values.PSB_STABLE_USERNAME && values.PSB_STABLE_PASSWORD,'missing service credential');
	const stable = new Stable('https://audiobookshelf.felixfoertsch.de');
	const credentials = new Credential(stable.base,values.PSB_STABLE_USERNAME,values.PSB_STABLE_PASSWORD);
	const token = await credentials.get();
	const user = await stable.validate(token,true);
	assert.equal(user.type,'user');
	await assert.rejects(stable.validate('bad-token'));
	const data = await stable.request('/api/libraries',token);
	console.log(JSON.stringify({serviceLogin:true,apiMe:true,badTokenRejected:true,userType:user.type,accessibleLibraries:data.libraries.length}));
})().catch(()=>{console.error('live_read_smoke_failed');process.exitCode=1;});
