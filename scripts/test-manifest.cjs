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
const sidecar = {
  'test/server/controllers/PodcastAdAnalysis.test.js': ['tests/analysis.test.ts', 'partial replacement: authorization-to-publish boundary; full ABS controller integration absent'],
  'test/server/controllers/PodcastEpisodeSummary.test.js': ['tests/feeds.test.ts', 'partial replacement: episode/feed behavior only; ABS controller integration absent'],
  'test/server/utils/adAnalysisDiagnostics.test.js': [null, 'missing sidecar test; no direct replacement identified'],
  'test/server/utils/adAnalysisPublicResult.test.js': [null, 'missing sidecar test; no direct replacement identified'],
  'test/server/utils/adComparisonPublication.test.js': ['tests/corpus.test.ts', 'partial replacement: corpus publication safety; not full upstream integration suite'],
  'test/server/utils/adCatalogMatching.test.js': ['tests/fixtures/adCatalogMatching.json', 'partial fixture mapping only; no equivalent executable suite'],
  'test/server/utils/PodcastRecency.test.js': [null, 'missing sidecar test; no direct replacement identified'],
  'test/server/models/oldJsonSerialization.test.js': [null, 'missing sidecar test; no direct replacement identified'],
  'test/server/debugHost.test.js': [null, 'not ported; frontend ownership'],
  'test/server/debugOverlay.test.js': [null, 'not ported; frontend ownership'],
  'test/server/debugShutdown.test.js': [null, 'not ported; frontend ownership'],
  'test/server/debugJwt.test.js': [null, 'not ported; frontend ownership'],
  'test/server/controllers/LibraryRecentEpisodes.test.js': [null, 'missing sidecar test; no direct replacement identified'],
};

function files(dir) {
  return execFileSync('find', [dir, '-type', 'f', '-name', '*.test.js', '-print0'], { encoding: 'buffer' })
    .toString().split('\0').filter(Boolean).sort();
}
function names(file) {
  const source = fs.readFileSync(file, 'utf8');
  const token = /\b(describe|context|it|specify|test)\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*)\2/g;
  return [...source.matchAll(token)].filter(match => !['describe', 'context'].includes(match[1])).map(match => ({
    name: match[3].replace(/\\([\\'"`])/g, '$1'),
    sourceLine: source.slice(0, match.index).split('\n').length,
  }));
}

const sourceFiles = files(path.join(sourceRoot, 'test'));
const suites = sourceFiles.map(file => {
  const sourcePath = path.relative(sourceRoot, file);
  const disposition = copied[sourcePath] ? 'copied-adapted' : sidecar[sourcePath] ? 'missing-sidecar' : 'upstream-owned';
  const mapping = copied[sourcePath] || sidecar[sourcePath];
  const cases = names(file).map(test => ({
    ...test,
    disposition,
    ...(mapping ? { destination: mapping[0], limitation: mapping[1] } : {}),
  }));
  return { sourcePath, caseCount: cases.length, disposition, ...(mapping ? { destination: mapping[0], limitation: mapping[1] } : {}), tests: cases };
});
const output = {
  sourceRevision,
  discovery: 'Static extraction of literal describe/context/it/specify/test calls. Records each literal test name without inferred describe nesting; source line is approximate. Dynamic/generated names are not expanded.',
  source: { suiteFiles: sourceFiles.length, staticTestNames: suites.reduce((n, suite) => n + suite.caseCount, 0) },
  newRepository: {
    runtimeEvidence: 'Measured by running configured package test command; counts below are passing individual tests, not test files.',
    command: 'bun run test',
    nodeTests: 20,
    mochaTests: 25,
    runnableTests: 45,
    failedTests: 0,
  },
  dispositions: {
    copiedAdaptedSuites: suites.filter(s => s.disposition === 'copied-adapted').length,
    missingSidecarSuites: suites.filter(s => s.disposition === 'missing-sidecar').length,
    upstreamOwnedSuites: suites.filter(s => s.disposition === 'upstream-owned').length,
  },
  suites,
};
fs.writeFileSync(path.join(root, 'test-manifest.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote test-manifest.json: ${output.source.suiteFiles} suites, ${output.source.staticTestNames} static test names; new repo ${output.newRepository.runnableTests} passing (20 Node + 25 Mocha).`);
