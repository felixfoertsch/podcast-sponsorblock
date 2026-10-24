import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
test('detector remains byte-identical to GPL source blob 7287bad5cde8dd22715a98fef8483f629c6b8e70', () => {
	const data = readFileSync(join(__dirname,'../vendor/daiAlignment.js'));
	assert.equal(createHash('sha256').update(data).digest('hex'),'7dfd72aa379aca8716e3147c0e0ad26af53688aa5b83489b99bb7819deea73e2');
	assert.equal(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),'7287bad5cde8dd22715a98fef8483f629c6b8e70');
});
