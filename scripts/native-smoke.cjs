const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'psb-native-'));
try {
	assert.match(execFileSync(process.env.FPCALC_PATH || 'fpcalc',['-version'],{encoding:'utf8',timeout:5000}),/fpcalc version 1\.(5|6)\./);
	const pcm = path.join(dir,'sample.pcm');
	execFileSync(process.env.FFMPEG_PATH || 'ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=125','-ac','1','-ar','11025','-f','s16le',pcm],{timeout:30000});
	const data = JSON.parse(execFileSync(process.env.FPCALC_PATH || 'fpcalc',['-format','s16le','-rate','11025','-channels','1','-algorithm','2','-length','0','-raw','-json',pcm],{encoding:'utf8',timeout:30000}));
	assert.ok(data.fingerprint.length > 0 && data.fingerprint.every(n=>Number.isInteger(n)&&n>=0&&n<=0xffffffff));
	assert.ok(Math.abs(data.fingerprint.length*1365/11025+(19*1365+2731)/11025-125)<1,'full-duration fingerprint');
	const db = new (require('better-sqlite3'))(':memory:');
	assert.equal(db.pragma('integrity_check',{simple:true}),'ok'); db.close();
	console.log('native smoke: ffmpeg, 125-second fpcalc, SQLite passed');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
