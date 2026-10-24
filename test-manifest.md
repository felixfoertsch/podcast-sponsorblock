# Test manifest

Source revision: `bcfd59cc49e8195b989d3ffda7c032f0fe34a5ea`.

`test-manifest.json` records every source JavaScript suite and statically discovered literal test name, including per-name disposition. Discovery does not execute source tests; dynamic/generated names may be absent. Suite-file count includes only `*.test.js` files under source `test/` (fixtures/data and migration scripts excluded).

## Measured counts

- Source: 49 `*.test.js` suites; 394 static test names. This is not a runtime count.
- New repository: 15 passing runnable tests via `node --import tsx --test tests/*.test.ts`; 0 failures. JavaScript Mocha adaptations are not part of package test command.
- Source names map one-by-one in JSON to copied/adapted suites or `upstream-owned`. Upstream-owned means not ported: those tests remain responsibility of upstream ABS, not claimed as replacements here.

## Explicit adaptations and gaps

- `test/server/utils/mpegFrameAlignment.test.js` -> `tests/mpegFrameAlignment.test.js`: standalone vendor worker.
- `test/server/utils/adAnalysisProxy.test.js` -> `tests/adAnalysisProxy.test.js`: standalone fail-closed config checks; upstream HTTP proxy integration depends on ABS manager.
- `test/server/utils/adComparisonCorpus.test.js` -> `tests/adComparisonCorpus.test.js`: vendor corpus/MPEG helpers.
- `test/server/utils/daiAnalysis.test.js` -> `tests/daiAnalysis.test.js`: vendor matching/alignment safety assertions; ABS manager integration omitted.
- `test/server/utils/daiNativeSafety.test.js` -> `tests/daiNativeSafety.test.js`: portable boundary + native version check.
- `tests/native-analysis.test.ts` exercises real ffmpeg/fpcalc fingerprint path when binaries installed.
- `tests/analysis*.test.ts` use `node:test`; no top-level test setup runs outside runner. `tests/analysis.test.ts` exercises adapter authorization-to-publish boundary.
- `tests/corpus.test.ts` exercises SQLite corpus retention, integrity hashes, MPEG evidence decode, duplicate handling, and inventory fields. Corpus uses its own table family; parent store schema untouched.
- `scripts/run-analysis-tests.sh` runs Node tests plus Mocha suites; `tests/native-analysis.test.ts` uses installed ffmpeg/fpcalc.
- Other source suites are recorded as upstream-owned, not represented as copied or replaced. Remaining gap: adapt relevant ABS-independent behavior or explicitly close each gap in future scope. Do not interpret transferred-suite coverage as full upstream test coverage.

Regenerate static inventory from repository root with `node scripts/test-manifest.cjs`. The generator reads sibling `../audiobookshelf/test` at pinned revision and writes `test-manifest.json`; it does not modify source checkout.
