import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('migration rejects unsafe archive types and paths before creating destination', () => {
	const dir = mkdtempSync(join(tmpdir(), 'psb-tar-'));
	try {
		const catalog = join(dir, 'catalog.json'), database = join(dir, 'never.sqlite');
		writeFileSync(catalog, '{"shows":[],"episodes":[]}');
		for (const [kind, path, type] of [['symlink','safe','2'],['hardlink','safe','1'],['parent','../escape','0'],['absolute','/escape','0'],['device','safe','3']] as const) {
			const archive = join(dir, `${kind}.tar`);
			const make = spawnSync('python3', ['-c', 'import tarfile,sys\nwith tarfile.open(sys.argv[1],"w") as t:\n m=tarfile.TarInfo(sys.argv[2]);m.type=sys.argv[3].encode();m.linkname="/outside";t.addfile(m)', archive, path, type]);
			assert.equal(make.status, 0);
			const result = spawnSync('bash', ['bin/migrate-experiment', '--input', archive, '--stable-catalog', catalog, '--database', database], { encoding: 'utf8' });
			assert.equal(result.status, 1, kind);
			assert.match(result.stderr, /unsafe_archive_(member|path)/);
			assert.equal(existsSync(database), false);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
