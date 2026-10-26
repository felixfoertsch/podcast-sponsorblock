#!/usr/bin/env bash
set -euo pipefail
/opt/homebrew/bin/mise exec -- node --import tsx --test tests/analysis*.test.ts tests/corpus.test.ts tests/native-analysis.test.ts tests/auth.test.ts tests/feeds.test.ts tests/queue.test.ts
/opt/homebrew/bin/mise exec -- bun x mocha --timeout 60000 tests/mpegFrameAlignment.test.js tests/adComparisonCorpus.test.js tests/daiAnalysis.test.js tests/daiNativeSafety.test.js tests/adAnalysisProxy.test.js tests/vendor-adapter.test.js
