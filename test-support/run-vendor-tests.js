require('tsx/cjs/api').register()
const path = require('node:path')
const Mocha = require('mocha')
const mocha = new Mocha({ timeout: 60000 })
for (const file of [
  'tests/mpegFrameAlignment.test.js',
  'tests/adComparisonCorpus.test.js',
  'tests/daiAnalysis.test.js',
  'tests/daiNativeSafety.test.js',
  'tests/vendor-adapter.test.js',
]) mocha.addFile(path.resolve(file))
mocha.run((failures) => { process.exitCode = failures ? 1 : 0 })
