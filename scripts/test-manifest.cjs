#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(root, '../audiobookshelf');
const sourceRevision = 'bcfd59cc49e8195b989d3ffda7c032f0fe34a5ea';
const copied = {
  'test/server/utils/mpegFrameAlignment.test.js': ['tests/mpegFrameAlignment.test.js', 'standalone vendor worker'],
  'test/server/utils/adAnalysisProxy.test.js': ['tests/adAnalysisProxy.test.js', 'standalone fail-closed config checks; upstream HTTP proxy integration depends on ABS manager'],
  'test/server/utils/adComparisonCorpus.test.js': ['tests/adComparisonCorpus.test.js', 'vendor corpus/MPEG helpers'],
  'test/server/utils/daiAnalysis.test.js': ['tests/daiAnalysis.test.js', 'vendor matching/alignment safety assertions; ABS manager integration omitted'],
  'test/server/utils/daiNativeSafety.test.js': ['tests/daiNativeSafety.test.js', 'portable boundary + native version check'],
};

function files(dir) {
  return execFileSync('find', [dir, '-type', 'f', '-name', '*.test.js', '-print0'], { encoding: 'buffer' })
    .toString().split('\0').filter(Boolean).sort();
}
function names(file) {
  const source = fs.readFileSync(file, 'utf8');
  const stack = [];
  const tests = [];
  const token = /\b(describe|context|it|specify|test)\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*)\2/g;
  for (const match of source.matchAll(token)) {
    const kind = match[1];
    const name = match[3].replace(/\\([\\'"`])/g, '$1');
    if (kind === 'describe' || kind === 'context') stack.push({ name, depth: (source.slice(0, match.index).match(/\{/g) || []).length });
    else tests.push({ name: [...stack.map(item => item.name), name].join(' > '), sourceLine: source.slice(0, match.index).split('\n').length });
  }
  return tests;
}

const sourceFiles = files(path.join(sourceRoot, 'test'));
const suites = sourceFiles.map(file => {
  const sourcePath = path.relative(sourceRoot, file);
  const destination = copied[sourcePath];
  const cases = names(file).map(test => ({ ...test, disposition: destination ? 'copied-adapted' : 'upstream-owned', ...(destination ? { destination: destination[0], limitation: destination[1] } : {}) }));
  return { sourcePath, caseCount: cases.length, disposition: destination ? 'copied-adapted' : 'upstream-owned', ...(destination ? { destination: destination[0], limitation: destination[1] } : {}), tests: cases };
});
const output = { sourceRevision, discovery: 'Static extraction of literal describe/context/it/specify/test names; source line is approximate; dynamic/generated names are not expanded.', source: { suiteFiles: sourceFiles.length, staticTestNames: suites.reduce((n, suite) => n + suite.caseCount, 0) }, newRepository: { runnableTests: 16, command: 'node --import tsx --test tests/*.test.ts', note: 'Measured passing node:test cases; Mocha-adapted JavaScript suites are not included in package test command.' }, suites };
fs.writeFileSync(path.join(root, 'test-manifest.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote test-manifest.json: ${output.source.suiteFiles} suites, ${output.source.staticTestNames} static test names.`);
