# Test manifest

Source revision: `bcfd59cc49e8195b989d3ffda7c032f0fe34a5ea`.

`test-manifest.json` inventories every source `*.test.js` path and statically discovered literal test name. Names are recorded without inferred `describe` nesting; no runtime-name claim. Static discovery cannot expand generated or dynamic test names. Suite count excludes fixtures and non-test migration scripts.

## Measured counts

- Source: 49 test files; 394 static test names.
- New repo, `bun run test`: 20 Node tests + 25 Mocha tests = 45 passing; 0 failures. These counts are runtime evidence from latest full run, not test-file counts.
- Source-suite dispositions: 5 copied/adapted; 13 mapped to missing-sidecar/replacement coverage with explicit partial or absent notes; remaining suites upstream-owned. Sidecar mapping does not claim equivalent coverage.

## Transfer details and gaps

Copied/adapted suites preserve these limitations:

- `test/server/utils/mpegFrameAlignment.test.js` -> `tests/mpegFrameAlignment.test.js`: standalone vendor worker.
- `test/server/utils/adAnalysisProxy.test.js` -> `tests/adAnalysisProxy.test.js`: standalone fail-closed config checks; upstream HTTP proxy integration depends on ABS manager.
- `test/server/utils/adComparisonCorpus.test.js` -> `tests/adComparisonCorpus.test.js`: vendor corpus/MPEG helpers.
- `test/server/utils/daiAnalysis.test.js` -> `tests/daiAnalysis.test.js`: vendor matching/alignment safety assertions; ABS manager integration omitted.
- `test/server/utils/daiNativeSafety.test.js` -> `tests/daiNativeSafety.test.js`: portable boundary + native version check.

JSON marks sidecar suites including `PodcastAdAnalysis`, `PodcastEpisodeSummary`, `adAnalysisDiagnostics`, `adAnalysisPublicResult`, `adComparisonPublication`, `adCatalogMatching`, `LibraryRecentEpisodes`, debug host/overlay/shutdown/JWT (not ported; frontend ownership), `PodcastRecency`, and `oldJsonSerialization` as `missing-sidecar`, with per-suite replacement or gap detail. Partial test mappings are not full replacements; absent executable replacements remain explicit gaps.

The JSON generator reads sibling `../audiobookshelf/test` and writes `test-manifest.json` only: `node scripts/test-manifest.cjs`. It does not modify source checkout. Runtime counts are evidence from `bun run test`; generator preserves those recorded counts and does not claim to execute tests.
